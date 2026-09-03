// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
 * always. Value is never created or destroyed here — it is moved between
 * accounts, and minting is no exception:
 *
 *     mint ₹100  →  TOKEN_SUPPLY -10000, MERCHANT_FLOAT +10000
 *
 * TOKEN_SUPPLY is a contra account whose negation is the number of tokens in
 * existence. A mint makes it more negative; the tokens it created are visible
 * in the float account that received them. `trialBalance()` summing to anything
 * but zero means something wrote outside this module.
 *
 * ── Signed amounts, unlike the wallet ledgers ───────────────────────────────
 * merchant_wallet_entries and wallet_ledger store a positive magnitude with the
 * direction in a separate column, because every sum-based check reads the
 * direction from that column. This table is double-entry, and in
 * double entry the sign IS the meaning: the legs of one movement sum to zero,
 * and a magnitude-plus-direction encoding would make that sum express nothing.
 *
 * ── What a single counter cannot do ─────────────────────────────────────────
 * `SystemConfig.adminTokenSupply.minted` is one counter with a 10B cap,
 * incremented on mint and decremented by a blind, error-swallowing $inc on
 * rollback. It cannot say where tokens went, it is not idempotent (a retried
 * rollback decrements twice), and if its `.catch(() => {})` ever fires the
 * supply figure is permanently wrong with nothing to reconcile against.
 */
import { getPool, pgQuery, connectGuarded } from '../client.js';

export const ACCOUNTS = Object.freeze({
  TOKEN_SUPPLY:      'TOKEN_SUPPLY',
  MERCHANT_FLOAT:    'MERCHANT_FLOAT',
  USER_FLOAT:        'USER_FLOAT',
  HOUSE_RESERVE:     'HOUSE_RESERVE',
  COMMISSION_POOL:   'COMMISSION_POOL',
  BONUS_POOL:        'BONUS_POOL',
  REFERRAL_POOL:     'REFERRAL_POOL',
  OPERATIONAL_FLOAT: 'OPERATIONAL_FLOAT',
});

const ALL_ACCOUNTS = Object.freeze(Object.values(ACCOUNTS));

/**
 * The supply ceiling, in paise. The cap is 10,000,000,000 tokens
 * so the two agree during the migration; overridable for testing and for the
 * day the business changes it.
 */
export const DEFAULT_SUPPLY_CAP_PAISE = 10_000_000_000 * 100;

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
  supplyCapPaise = DEFAULT_SUPPLY_CAP_PAISE,
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
  const pool = await getPool();
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL unset)');
  const client = await connectGuarded(pool);
  let failure = null;

  try {
    await client.query('BEGIN');
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

    // The supply ceiling. A mint drives TOKEN_SUPPLY down, so the guard is on
    // how negative it may go — expressed here rather than as a CHECK because
    // the cap is a business rule that can change, and a constraint would make
    // every historical row invalid the day it did.
    const supplyLeg = legs[ACCOUNTS.TOKEN_SUPPLY] ?? 0;
    if (supplyLeg < 0) {
      const wouldCirculate = -(before[ACCOUNTS.TOKEN_SUPPLY] + supplyLeg);
      if (wouldCirculate > supplyCapPaise) {
        await client.query('ROLLBACK');
        return {
          ok: false, reason: 'supply_cap_exceeded',
          capPaise: supplyCapPaise, circulatingPaise: -before[ACCOUNTS.TOKEN_SUPPLY],
          requestedPaise: -supplyLeg,
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
          await client.query('ROLLBACK');
          // Read on THIS client — see readBalances for why a pooled read here deadlocks.
          return { ok: true, idempotent: true, balances: await readBalances((t, p) => client.query(t, p)) };
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
    // also report a moment later than the one this movement created.
    const balances = await readBalances((t, p) => client.query(t, p));
    await client.query('COMMIT');
    return { ok: true, idempotent: false, entries: written, balances };
  } catch (error) {
    failure = error;
    try { await client.query('ROLLBACK'); } catch { /* already unwound */ }
    throw error;
  } finally {
    // Destroy rather than reuse a client whose backend may have gone away
    // mid-transaction — see merchantWalletPg.withMerchantLock.
    client.release(failure ?? undefined);
  }
}

// ── Operations ───────────────────────────────────────────────────────────────

const move = (from, to) => (amountPaise, args) => {
  requirePositive(amountPaise, args.operation ?? 'treasury movement');
  return postMovement({ ...args, legs: { [from]: -amountPaise, [to]: amountPaise } });
};

/** Admin mints tokens into merchant float. The only way supply increases. */
export const mintToMerchantFloat = (amountPaise, args = {}) =>
  move(ACCOUNTS.TOKEN_SUPPLY, ACCOUNTS.MERCHANT_FLOAT)(amountPaise, { operation: 'MINT', ...args });

/** Tokens destroyed — supply decreases. The exact inverse of a mint. */
export const burnFromMerchantFloat = (amountPaise, args = {}) =>
  move(ACCOUNTS.MERCHANT_FLOAT, ACCOUNTS.TOKEN_SUPPLY)(amountPaise, { operation: 'BURN', ...args });

/** A merchant dispensed tokens to a user (deposit completed). */
export const merchantDispensedToUser = (amountPaise, args = {}) =>
  move(ACCOUNTS.MERCHANT_FLOAT, ACCOUNTS.USER_FLOAT)(amountPaise, { operation: 'DEPOSIT_DISPENSED', ...args });

/** A user's tokens went to a merchant (withdrawal settled). */
export const userPaidMerchant = (amountPaise, args = {}) =>
  move(ACCOUNTS.USER_FLOAT, ACCOUNTS.MERCHANT_FLOAT)(amountPaise, { operation: 'WITHDRAWAL_SETTLED', ...args });

/** A losing stake. The house takes what the user staked. */
export const stakeLostToHouse = (amountPaise, args = {}) =>
  move(ACCOUNTS.USER_FLOAT, ACCOUNTS.HOUSE_RESERVE)(amountPaise, { operation: 'STAKE_LOST', ...args });

/** A winning payout. The house pays out of reserve. */
export const housePaidWinnings = (amountPaise, args = {}) =>
  move(ACCOUNTS.HOUSE_RESERVE, ACCOUNTS.USER_FLOAT)(amountPaise, { operation: 'WINNINGS_PAID', ...args });

/** House revenue apportioned to a pool. */
export const allocateFromHouse = (amountPaise, pool, args = {}) => {
  requireAccount(pool);
  return move(ACCOUNTS.HOUSE_RESERVE, pool)(amountPaise, { operation: `ALLOCATE_${pool}`, ...args });
};

/** A pool paid a user — a bonus, a referral reward, a cashback. */
export const poolPaidUser = (amountPaise, pool, args = {}) => {
  requireAccount(pool);
  return move(pool, ACCOUNTS.USER_FLOAT)(amountPaise, { operation: `PAYOUT_${pool}`, ...args });
};

function requirePositive(amountPaise, label) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new TypeError(`${label}: amountPaise must be a positive integer, got ${amountPaise}`);
  }
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
