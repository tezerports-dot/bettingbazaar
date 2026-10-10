// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * postgres/treasuryPg.js — the platform's own accounts, as double entry.
 *
 * Domain 3. Every other money module tracks what somebody ELSE holds: a user's
 * balance, a merchant's inventory. This one tracks the platform's side of those
 * same movements, and it is what closes the books.
 *
 * ── Why this had to exist before the conservation test could be trusted ─────
 * moneyConservation.test.js walks the full chain and asserts tokens are
 * conserved. It needed a `sink` variable, because value legitimately leaves the
 * user/merchant books — a losing stake goes to the house, a commission goes to
 * the platform — and neither had anywhere to go. The test had to be TOLD about
 * that money rather than reading it from a ledger, which means the invariant
 * read "the test accounted for it", not "the books account for it".
 *
 * These accounts are that ledger. With them the sink becomes real balances and
 * the whole system closes on itself.
 *
 * ── The invariant ───────────────────────────────────────────────────────────
 * EVERY MOVEMENT'S LEGS SUM TO ZERO, therefore the entire ledger sums to zero,
 * always. Value is never created or destroyed here — it is only moved between
 * accounts, and a team buying inventory is no exception:
 *
 *     team buys ₹100  →  TOKEN_SUPPLY -10000, TEAM_FLOAT +10000
 *
 * TOKEN_SUPPLY is a contra account holding the platform's own tokens. All
 * 20,000,000,000 start there; the negation of its balance is how many have
 * been handed out, and what the platform still holds is the difference. A
 * transfer moves tokens from it into the float account that received them —
 * nothing is created, which is why the legs sum to zero.
 *
 * The DATABASE holds it, not this module (schema.sql, "TOKEN CONSERVATION";
 * owner, 2026-10-07): a transaction whose movement's legs do not sum to zero,
 * whose account moved by other than its entries, whose wallets moved by other
 * than USER_FLOAT or whose pools by other than TEAM_FLOAT, does not commit,
 * whoever wrote it. So a player's wallet and its USER_FLOAT leg are written in
 * ONE transaction by every path (`wallets.core.applyMovementWithin`'s
 * `counterparty`), and `trialBalance()` is evidence, not a guard.
 *
 * ── Signed amounts, unlike the wallet ledgers ───────────────────────────────
 * team_pool_entries and wallet_ledger store a positive magnitude with the
 * direction in a separate column, because every sum-based check reads the
 * direction from that column. This table is double-entry, and in
 * double entry the sign IS the meaning: the legs of one movement sum to zero,
 * and a magnitude-plus-direction encoding would make that sum express nothing.
 *
 * ── What a single counter cannot do ─────────────────────────────────────────
 * `SystemConfig.adminTokenSupply.transferred` is one counter, incremented on a
 * transfer out and decremented by a blind, error-swallowing $inc on rollback.
 * It cannot say where tokens went, it is not idempotent (a retried rollback
 * decrements twice), and if its `.catch(() => {})` ever fires the figure is
 * permanently wrong with nothing to reconcile against. These accounts can say
 * where every token is, which is what makes the conservation invariant —
 * platform holding + every team pool + every player wallet = 20B —
 * something the books prove rather than something a counter asserts.
 */
import { getPool, pgQuery, connectGuarded } from '../client.js';

export const ACCOUNTS = Object.freeze({
  TOKEN_SUPPLY:      'TOKEN_SUPPLY',
  USER_FLOAT:        'USER_FLOAT',
  HOUSE_RESERVE:     'HOUSE_RESERVE',
  COMMISSION_POOL:   'COMMISSION_POOL',
  BONUS_POOL:        'BONUS_POOL',
  REFERRAL_POOL:     'REFERRAL_POOL',
  OPERATIONAL_FLOAT: 'OPERATIONAL_FLOAT',
  // Every team pool's tokens, held and available together (Step 2b). Equals
  // the sum of `team_pools` — `teamPools.js` is the only writer of both.
  TEAM_FLOAT:        'TEAM_FLOAT',
});

const ALL_ACCOUNTS = Object.freeze(Object.values(ACCOUNTS));

/**
 * Every token that exists, in paise: `SystemConfig.adminTokenSupply.total`
 * (owner, 2026-09-23: 20,000,000,000), and none are ever created — the
 * platform starts holding all of them and everything after is a transfer.
 *
 * Read IN the database (`bb_token_supply_paise()`), on the movement's own
 * client: the same function the `treasury_supply_ceiling` trigger asks, so the
 * refusal below and the row's guarantee cannot use two different figures.
 */
async function supplyPaise(client) {
  const { rows } = await client.query('SELECT bb_token_supply_paise() AS paise');
  return toPaise(rows[0].paise);
}

const toPaise = (v) => Number(v ?? 0);

/**
 * Every account balance in paise, read through `run`.
 *
 * `run` is a parameter and not an implicit pgQuery for a reason that cost a
 * 110-second hang to find: postMovement holds a checked-out client for the
 * length of its transaction, and calling a pgQuery-based reader from inside it
 * asks the pool for a SECOND connection while still holding the first. With
 * enough concurrent movements every connection is held by a transaction that is
 * waiting for a connection, and the pool deadlocks — the money path stops, not
 * just the test. Anything running inside a transaction must read on that
 * transaction's own client.
 */
async function readBalances(run) {
  const { rows } = await run(
    `SELECT account, balance_paise FROM treasury_accounts`, [], 'treasury_read',
  );
  const balances = Object.fromEntries(ALL_ACCOUNTS.map((a) => [a, 0]));
  for (const r of rows) balances[r.account] = toPaise(r.balance_paise);
  return balances;
}

/** Every account balance in paise. Accounts never touched read as zero. */
export function getTreasuryBalances() {
  return readBalances(pgQuery);
}

/**
 * Tokens in existence — the negation of the contra account.
 *
 * `0 - x` rather than `-x`: negating a zero balance yields -0, and
 * Object.is(-0, 0) is false, so an empty treasury would compare unequal to zero
 * for any caller using strict equality or a test matcher. The arithmetic is
 * identical everywhere else.
 */
export async function circulatingSupplyPaise() {
  return 0 - (await getTreasuryBalances())[ACCOUNTS.TOKEN_SUPPLY];
}

function requireAccount(account) {
  if (!ALL_ACCOUNTS.includes(account)) {
    throw new Error(`Unknown treasury account '${account}'. Known: ${ALL_ACCOUNTS.join(', ')}`);
  }
}

/**
 * postMovement — THE mutation. Every operation below is a thin wrapper, so
 * there is exactly one place a treasury balance can change and exactly one
 * place that enforces the zero-sum rule.
 *
 * Accounts are locked in a FIXED ORDER (alphabetical) regardless of the order
 * the caller listed the legs. Two concurrent movements touching the same pair
 * of accounts in opposite orders would otherwise deadlock — and unlike a
 * single-row lock, that is a hazard this module creates for itself by touching
 * several rows per transaction.
 *
 * @param {object} args
 * @param {string} args.movementId  idempotency key for the whole movement
 * @param {string} args.operation   e.g. 'MINT', 'DEPOSIT_DISPENSED'
 * @param {Object<string, number>} args.legs  account → signed paise; must sum to 0
 */
export async function postMovement({
  movementId, operation, legs,
  actor = null, reason = null, refModel = null, refId = null, correlationId = null,
  // A caller already inside a transaction passes its client, and the movement
  // commits or unwinds WITH that transaction. A team pool credit and the
  // treasury movement that funds it are one fact; two transactions would be
  // §21's shape, a second write that can fail after the first committed.
  client: outer = null,
}) {
  if (!movementId) throw new Error('postMovement requires a movementId (idempotency key)');
  if (!operation) throw new Error('postMovement requires an operation');

  const entries = Object.entries(legs || {}).filter(([, delta]) => delta);
  if (!entries.length) throw new Error('postMovement requires at least one non-zero leg');
  for (const [account, delta] of entries) {
    requireAccount(account);
    if (!Number.isInteger(delta)) {
      throw new TypeError(`leg '${account}': must be an integer number of paise, got ${delta}`);
    }
  }

  // The rule the whole domain rests on, checked before anything is written so a
  // malformed movement can never reach the table even momentarily.
  const sum = entries.reduce((s, [, delta]) => s + delta, 0);
  if (sum !== 0) {
    throw new Error(
      `postMovement legs must sum to zero (double entry), got ${sum}: ${JSON.stringify(legs)}`,
    );
  }

  const accounts = entries.map(([a]) => a).sort();
  let client = outer;
  if (!client) {
    const pool = await getPool();
    if (!pool) throw new Error('Postgres not configured (DATABASE_URL unset)');
    client = await connectGuarded(pool);
  }
  let failure = null;
  // Inside a caller's transaction, a refusal or replay unwinds to a savepoint
  // instead of rolling the caller's whole transaction back.
  const begin    = outer ? 'SAVEPOINT treasury_movement' : 'BEGIN';
  const rollback = outer ? 'ROLLBACK TO SAVEPOINT treasury_movement' : 'ROLLBACK';
  const commit   = outer ? 'RELEASE SAVEPOINT treasury_movement' : 'COMMIT';

  try {
    await client.query(begin);
    for (const account of accounts) {
      await client.query(
        `INSERT INTO treasury_accounts (account) VALUES ($1) ON CONFLICT (account) DO NOTHING`,
        [account],
      );
    }
    // Locked in one statement, ordered — no interleaving is possible.
    const locked = await client.query(
      `SELECT account, balance_paise FROM treasury_accounts
        WHERE account = ANY($1) ORDER BY account FOR UPDATE`,
      [accounts],
    );
    const before = Object.fromEntries(locked.rows.map((r) => [r.account, toPaise(r.balance_paise)]));

    // The supply ceiling. A release drives TOKEN_SUPPLY down, so the guard is
    // on how negative it may go: never past the configured total. Asked here,
    // under the TOKEN_SUPPLY row lock, so the caller gets a refusal it can
    // phrase; the `treasury_supply_ceiling` trigger is the same rule as a
    // property of the row, for every writer.
    const supplyLeg = legs[ACCOUNTS.TOKEN_SUPPLY] ?? 0;
    if (supplyLeg < 0) {
      const capPaise = await supplyPaise(client);
      const wouldCirculate = -(before[ACCOUNTS.TOKEN_SUPPLY] + supplyLeg);
      if (wouldCirculate > capPaise) {
        await client.query(rollback);
        return {
          ok: false, reason: 'supply_cap_exceeded',
          capPaise, circulatingPaise: -before[ACCOUNTS.TOKEN_SUPPLY],
          requestedPaise: -supplyLeg,
        };
      }
    }

    // An account cannot pay out tokens it does not hold: that would be a token
    // nobody has, and the next payment would spend it again. Asked here, under
    // the account's own row lock, so the caller gets a refusal it can phrase —
    // an unfunded bonus pool is "nobody has funded this promotion", not a 500.
    // `treasury_accounts_sign` is the same rule as a property of the row.
    for (const account of accounts) {
      if (account === ACCOUNTS.TOKEN_SUPPLY) continue;   // the contra account: see above
      const after = before[account] + legs[account];
      if (after < 0) {
        await client.query(rollback);
        return {
          ok: false, reason: 'account_short', account,
          availablePaise: before[account], requestedPaise: 0 - legs[account],
        };
      }
    }

    const written = [];
    for (const account of accounts) {
      const delta = legs[account];
      const balanceBefore = before[account];
      const balanceAfter = balanceBefore + delta;
      // One leg per account, each with its own unique key so the movement as a
      // whole replays under `movementId` while every row stays addressable.
      const txId = accounts.length > 1 ? `${movementId}:${account}` : movementId;

      try {
        await client.query(
          `INSERT INTO treasury_entries
             (tx_id, movement_id, account, amount_paise, balance_before_paise, balance_after_paise,
              operation, actor, reason, ref_model, ref_id, correlation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [txId, movementId, account, delta, balanceBefore, balanceAfter,
           operation, actor, reason, refModel, refId ? String(refId) : null, correlationId],
        );
      } catch (error) {
        // UNIQUE tx_id — the idempotency gate firing INSIDE the transaction, so
        // the whole movement unwinds rather than half of it landing.
        if (error.code === '23505') {
          await client.query(rollback);
          // Read on THIS client — see readBalances for why a pooled read here deadlocks.
          return {
            ok: true, idempotent: true,
            balances: outer ? null : await readBalances((t, p) => client.query(t, p)),
          };
        }
        throw error;
      }

      await client.query(
        `UPDATE treasury_accounts SET balance_paise = $2, updated_at = now() WHERE account = $1`,
        [account, balanceAfter],
      );
      written.push({ txId, movementId, account, amountPaise: delta, balanceBefore, balanceAfter });
    }

    // Read BEFORE committing, on this transaction's client. Reading after the
    // commit would be a second pooled connection (the deadlock above) and would
    // also report a moment later than the one this movement created. Inside a
    // caller's transaction nobody reads them, and the read would be one more
    // statement while USER_FLOAT's row lock is held.
    const balances = outer ? null : await readBalances((t, p) => client.query(t, p));
    await client.query(commit);
    return { ok: true, idempotent: false, entries: written, balances };
  } catch (error) {
    failure = error;
    try { await client.query(rollback); } catch { /* already unwound */ }
    throw error;
  } finally {
    // Destroy rather than reuse a client whose backend may have gone away
    // mid-transaction — see merchantWalletPg.withMerchantLock.
    if (!outer) client.release(failure ?? undefined);
  }
}

// ── The house ────────────────────────────────────────────────────────────────

/**
 * A game's result on the platform's side, inside the caller's transaction:
 * the player's wallet moved by `userDeltaPaise` (a lost stake is negative; a
 * win, net of the stake it consumed, positive) and the HOUSE is the other side.
 *
 * A stake the house wins joins HOUSE_RESERVE. A payout comes out of
 * HOUSE_RESERVE first and, once the house has paid out more than it has won,
 * the rest from the platform's holding (TOKEN_SUPPLY): a transfer like any
 * other, inside the supply ceiling. Never from a negative reserve, which would
 * be tokens nobody holds (`treasury_accounts_sign`).
 *
 * The reserve is read under its row lock, taken before `postMovement` locks
 * the rest in the same alphabetical order, so two payouts cannot both spend it.
 */
export async function postHouseSettlement({ client, movementId, userDeltaPaise, operation, ...meta }) {
  if (!client) throw new Error('postHouseSettlement runs inside the caller\'s transaction: pass its client');
  if (!Number.isInteger(userDeltaPaise) || userDeltaPaise === 0) {
    throw new TypeError(`postHouseSettlement: userDeltaPaise must be a non-zero integer, got ${userDeltaPaise}`);
  }
  if (userDeltaPaise < 0) {
    return postMovement({
      client, movementId, operation, ...meta,
      legs: { [ACCOUNTS.USER_FLOAT]: userDeltaPaise, [ACCOUNTS.HOUSE_RESERVE]: 0 - userDeltaPaise },
    });
  }
  await client.query(
    'INSERT INTO treasury_accounts (account) VALUES ($1) ON CONFLICT (account) DO NOTHING', [ACCOUNTS.HOUSE_RESERVE]);
  const { rows } = await client.query(
    'SELECT balance_paise FROM treasury_accounts WHERE account = $1 FOR UPDATE', [ACCOUNTS.HOUSE_RESERVE]);
  const fromReserve = Math.min(toPaise(rows[0].balance_paise), userDeltaPaise);
  return postMovement({
    client, movementId, operation, ...meta,
    legs: {
      [ACCOUNTS.HOUSE_RESERVE]: 0 - fromReserve,
      [ACCOUNTS.TOKEN_SUPPLY]: fromReserve - userDeltaPaise,
      [ACCOUNTS.USER_FLOAT]: userDeltaPaise,
    },
  });
}

/**
 * Many lost stakes taken by the house, inside the caller's transaction, in a
 * fixed number of statements however many there are.
 *
 * Each stake is its OWN movement, exactly the one `postHouseSettlement` posts
 * for a single lost bet (USER_FLOAT → HOUSE_RESERVE, keyed by `movementId`,
 * entries `<movementId>:<account>`), so the books cannot tell a batched loss
 * from a single one. The entries chain each account's balance through the
 * movements in the order given; the two accounts are then set once to where
 * the chain ends. Every conservation trigger sees what it would have seen
 * from the movements one by one.
 *
 * @param {object} args
 * @param {object} args.client        the caller's transaction
 * @param {Array<{movementId: string, amountPaise: number, refId: string, reason?: string}>} args.stakes
 *                                    each a positive number of paise
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>} a refusal or a
 *   replayed key leaves the transaction for the caller to roll back
 */
export async function postHouseTakesWithin({ client, stakes, operation, actor = null, refModel = null }) {
  if (!client) throw new Error('postHouseTakesWithin runs inside the caller\'s transaction: pass its client');
  if (!operation) throw new Error('postHouseTakesWithin requires an operation');
  if (!stakes.length) return { ok: true };
  for (const s of stakes) {
    if (!s.movementId) throw new Error('every house take needs a movementId (idempotency key)');
    if (!Number.isInteger(s.amountPaise) || s.amountPaise <= 0) {
      throw new TypeError(`house take ${s.movementId}: amountPaise must be a positive integer, got ${s.amountPaise}`);
    }
  }

  // The same accounts, locked the same way and in the same order as postMovement.
  const accounts = [ACCOUNTS.HOUSE_RESERVE, ACCOUNTS.USER_FLOAT].sort();
  await client.query(
    `INSERT INTO treasury_accounts (account) SELECT unnest($1::text[]) ON CONFLICT (account) DO NOTHING`, [accounts]);
  const locked = await client.query(
    `SELECT account, balance_paise FROM treasury_accounts
      WHERE account = ANY($1) ORDER BY account FOR UPDATE`, [accounts]);
  const balance = Object.fromEntries(locked.rows.map((r) => [r.account, toPaise(r.balance_paise)]));

  // USER_FLOAT only falls here, so its last balance is its lowest: one check
  // is every movement's check.
  const total = stakes.reduce((t, s) => t + s.amountPaise, 0);
  if (balance[ACCOUNTS.USER_FLOAT] - total < 0) {
    return { ok: false, reason: 'account_short', account: ACCOUNTS.USER_FLOAT };
  }

  const cols = { tx: [], movement: [], account: [], amount: [], before: [], after: [], ref: [], reason: [] };
  for (const s of stakes) {
    const legs = { [ACCOUNTS.HOUSE_RESERVE]: s.amountPaise, [ACCOUNTS.USER_FLOAT]: 0 - s.amountPaise };
    for (const account of accounts) {
      const before = balance[account];
      balance[account] = before + legs[account];
      cols.tx.push(`${s.movementId}:${account}`);
      cols.movement.push(s.movementId);
      cols.account.push(account);
      cols.amount.push(legs[account]);
      cols.before.push(before);
      cols.after.push(balance[account]);
      cols.ref.push(s.refId ? String(s.refId) : null);
      cols.reason.push(s.reason ?? null);
    }
  }

  try {
    await client.query(
      `INSERT INTO treasury_entries
         (tx_id, movement_id, account, amount_paise, balance_before_paise, balance_after_paise,
          operation, actor, reason, ref_model, ref_id)
       SELECT e.tx, e.movement, e.account, e.amount, e.before, e.after, $9, $10, e.reason, $11, e.ref
         FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[], $5::bigint[], $6::bigint[], $7::text[], $8::text[])
              WITH ORDINALITY AS e(tx, movement, account, amount, before, after, ref, reason, n)
        ORDER BY e.n`,
      [cols.tx, cols.movement, cols.account, cols.amount, cols.before, cols.after, cols.ref, cols.reason,
       operation, actor, refModel],
    );
  } catch (error) {
    if (error.code === '23505') return { ok: false, reason: 'treasury_already_posted' };
    throw error;
  }
  await client.query(
    `UPDATE treasury_accounts t SET balance_paise = b.after, updated_at = now()
       FROM unnest($1::text[], $2::bigint[]) AS b(account, after)
      WHERE t.account = b.account`,
    [accounts, accounts.map((a) => balance[a])],
  );
  return { ok: true };
}

// ── Proof ────────────────────────────────────────────────────────────────────

/**
 * The trial balance. Every account, and the grand total that MUST be zero.
 *
 * This is the single strongest statement the platform can make about its own
 * money: not "each domain reconciles" but "the whole ledger closes". A non-zero
 * total is unambiguous evidence that something wrote outside postMovement.
 */
export async function trialBalance() {
  const [{ rows: stored }, { rows: fromEntries }] = await Promise.all([
    pgQuery(`SELECT account, balance_paise FROM treasury_accounts ORDER BY account`, [], 'treasury_trial'),
    pgQuery(
      `SELECT account, COALESCE(SUM(amount_paise), 0) AS net FROM treasury_entries GROUP BY account`,
      [], 'treasury_trial_entries',
    ),
  ]);

  const balances = Object.fromEntries(ALL_ACCOUNTS.map((a) => [a, 0]));
  for (const r of stored) balances[r.account] = toPaise(r.balance_paise);

  const explained = Object.fromEntries(ALL_ACCOUNTS.map((a) => [a, 0]));
  for (const r of fromEntries) explained[r.account] = toPaise(r.net);

  // Two independent questions, and both must hold. The ledger closing to zero
  // says no value was invented; the entries explaining the balances says no
  // balance moved without its entry. Either can fail while the other passes.
  const grandTotal = ALL_ACCOUNTS.reduce((s, a) => s + balances[a], 0);
  const unexplained = ALL_ACCOUNTS
    .map((a) => ({ account: a, balance: balances[a], fromEntries: explained[a], drift: balances[a] - explained[a] }))
    .filter((r) => r.drift !== 0);

  return {
    ok: grandTotal === 0 && unexplained.length === 0,
    balances,
    grandTotalPaise: grandTotal,
    conservesToZero: grandTotal === 0,
    unexplained,
    circulatingSupplyPaise: 0 - balances[ACCOUNTS.TOKEN_SUPPLY],  // never -0, see above
  };
}
