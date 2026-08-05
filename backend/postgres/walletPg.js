// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/walletPg.js — the Postgres-authoritative wallet path (cutover step 3,
 * the FIRST path the plan flips).
 *
 * When `MONEY_AUTHORITY_WALLET=postgres`, balance reads and mutations happen
 * here instead of against the Mongo User document. Everything is integer paise
 * end to end — this is the schema's stated purpose: "once Postgres is
 * authoritative, integer paise is the only representation money has at rest".
 * The float-rupee round2() pattern stops at this wall.
 *
 * ── Why this is not secureBetPlacement.js ───────────────────────────────────
 * That file is a reference implementation on a DIFFERENT table set
 * (`user_wallets` NUMERIC / ISO-4217 currency, `financial_ledger`,
 * `operational_bet_outbox`). It demonstrates the serializable-with-outbox
 * pattern but was never wired to the app, and its tables do not hold the
 * balances the dual-write mirror has been populating. The authoritative path
 * has to operate on the tables that already carry the mirrored money —
 * `wallets` + `wallet_ledger`, BIGINT paise — or a cutover would silently
 * switch to an empty set of balances.
 *
 * ── Concurrency ─────────────────────────────────────────────────────────────
 * Every mutation runs in one transaction that:
 *   1. locks the wallet row (SELECT … FOR UPDATE), serialising concurrent
 *      movements for that user — the guarantee Mongo needed a replica-set
 *      transaction to approximate;
 *   2. applies the delta with a guard that refuses to leave a balance negative;
 *   3. appends the ledger row in the SAME transaction, so a balance can never
 *      move without its audit row (in Mongo these are two writes that a crash
 *      between could separate).
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 * `tx_id` is UNIQUE on wallet_ledger. A replay of the same movement hits that
 * constraint, and the caller gets `{ idempotent: true }` with the balance the
 * original produced — the same contract walletAuthority already exposes, so
 * callers do not learn a new one at cutover. This mirrors the hard-won Mongo
 * lesson recorded in GOVERNANCE §20 (2026-07-10): the unique index INSIDE the
 * transaction is the idempotency gate, not a pre-read.
 */
import { getPool, pgQuery, connectGuarded } from './pgClient.js';
import { rupeesToPaise, paiseToRupees } from '../shared/money.js';

/** Mongo balance field → its paise column on `wallets`. */
export const FIELD_COLUMN = Object.freeze({
  depositBalance:  'deposit_paise',
  winningsBalance: 'winnings_paise',
  tokenBalance:    'token_paise',
  reserveBalance:  'reserve_paise',
  lockedBalance:   'locked_paise',
  // Lock provenance — how much of lockedBalance came from each pocket. These
  // are never the `field` of a ledger row (Mongo doesn't ledger them either);
  // they move as extra legs alongside a lockedBalance movement.
  lockedDepositAmount:  'locked_deposit_paise',
  lockedWinningsAmount: 'locked_winnings_paise',
});

export const BALANCE_FIELDS = Object.freeze(Object.keys(FIELD_COLUMN));

function columnFor(field) {
  const column = FIELD_COLUMN[field];
  if (!column) {
    throw new Error(`Unknown balance field '${field}'. Known: ${BALANCE_FIELDS.join(', ')}`);
  }
  return column;
}

/** pg returns BIGINT as a string; every balance crosses this boundary as paise. */
function toPaise(value) {
  return Number(value ?? 0);
}

/**
 * getBalancesPaise — every balance for a user, in integer paise.
 * Returns zeros for a user with no wallet row yet, which is the same thing the
 * Mongo path reports for a user who has never transacted.
 */
export async function getBalancesPaise(userId) {
  const { rows } = await pgQuery(
    `SELECT ${BALANCE_FIELDS.map((f) => FIELD_COLUMN[f]).join(', ')}
       FROM wallets WHERE user_id = $1`,
    [String(userId)],
    'wallet_read',
  );
  const row = rows[0] || {};
  return Object.fromEntries(
    BALANCE_FIELDS.map((field) => [field, toPaise(row[FIELD_COLUMN[field]])]),
  );
}

/** The same balances in rupees, for callers still speaking the Mongo shape. */
export async function getBalancesRupees(userId) {
  const paise = await getBalancesPaise(userId);
  return Object.fromEntries(
    Object.entries(paise).map(([field, value]) => [field, paiseToRupees(value)]),
  );
}


// ── Transaction plumbing ─────────────────────────────────────────────────────

const BALANCE_COLUMNS = BALANCE_FIELDS.map((f) => FIELD_COLUMN[f]).join(', ');

function rowToBalances(row = {}) {
  return Object.fromEntries(BALANCE_FIELDS.map((f) => [f, toPaise(row[FIELD_COLUMN[f]])]));
}

/**
 * withWalletLock — open a transaction, materialise the user's wallet row, take
 * the row lock, and hand the callback the client plus the balances AS OF that
 * lock.
 *
 * The lock is this user's mutex. While it is held no other movement for them
 * can read or write, so a decision made inside the callback — an existence
 * probe, a spend-order split across two pockets — is DURABLE rather than a
 * hopeful pre-read that a concurrent writer can invalidate. That is the
 * property the Mongo path has to approximate with a `$gte` filter and a retry.
 *
 * The callback returns `{ commit, value }`; `commit:false` rolls back and still
 * returns `value`, which is the shape "this was refused, and here is why"
 * needs. Note that once a statement inside the transaction has errored,
 * Postgres refuses further work on that connection until it unwinds — so any
 * follow-up read (e.g. fetching what an earlier replay produced) must happen
 * OUTSIDE this helper, after it has returned.
 */
export async function withWalletLock(userId, fn) {
  const uid = String(userId);
  const pool = await getPool();
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL unset)');
  // connectGuarded, not pool.connect: an unguarded checked-out client turns a
  // Postgres restart mid-transaction into an unhandled 'error' event and a hard
  // process crash. See pgClient.connectGuarded.
  const client = await connectGuarded(pool);
  let failure = null;

  try {
    await client.query('BEGIN');

    // Materialise the wallet row so FOR UPDATE has something to lock. A
    // first-ever movement and a concurrent one race here; ON CONFLICT makes the
    // loser a no-op rather than an error.
    await client.query(
      `INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [uid],
    );
    const locked = await client.query(
      `SELECT ${BALANCE_COLUMNS} FROM wallets WHERE user_id = $1 FOR UPDATE`, [uid],
    );

    const { commit, value } = await fn({
      client, uid, balances: rowToBalances(locked.rows[0]),
    });

    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return value;
  } catch (error) {
    failure = error;
    try { await client.query('ROLLBACK'); } catch { /* already unwound */ }
    throw error;
  } finally {
    // Passing the error DESTROYS the client instead of returning it to the
    // pool. It matters when the backend went away mid-transaction — a Postgres
    // restart, a failover, an admin pg_terminate_backend: the socket is dead
    // but a plain release() puts it back in rotation and the NEXT caller
    // inherits "terminating connection due to administrator command" on a query
    // of its own, two statements later, in unrelated code.
    //
    // The merchant modules were fixed when a settlement test killed a backend
    // mid-transition and the failure surfaced somewhere else entirely. This is
    // the same bug on the HOTTEST money path, which had simply never been
    // subjected to that drill.
    client.release(failure ?? undefined);
  }
}

/** Normalise legs to one signed delta per column, carrying the negative guard. */
function mergeLegs(legs, allowNegative) {
  const merged = new Map(); // column → { delta, allowNegative }
  for (const leg of legs) {
    if (!Number.isInteger(leg.deltaPaise)) {
      throw new TypeError(`leg '${leg.field}': deltaPaise must be an integer number of paise, got ${leg.deltaPaise}`);
    }
    const column = columnFor(leg.field);
    const prior = merged.get(column) || { delta: 0, allowNegative: false };
    merged.set(column, {
      delta: prior.delta + leg.deltaPaise,
      allowNegative: prior.allowNegative || allowNegative || leg.allowNegative === true,
    });
  }
  return merged;
}

/**
 * Apply merged legs to the locked row. The negative guard lives in the UPDATE's
 * WHERE clause, so a debit that would overdraw simply matches no row — it
 * cannot be lost to a race between a read and a write. Returns the post-state,
 * or null when a guard refused.
 */
async function moveBalances(client, uid, merged) {
  const params = [uid];
  const sets = [];
  const guards = [];
  for (const [column, { delta, allowNegative }] of merged) {
    params.push(delta);
    const placeholder = `$${params.length}`;
    sets.push(`${column} = ${column} + ${placeholder}`);
    if (delta < 0 && !allowNegative) guards.push(`AND ${column} + ${placeholder} >= 0`);
  }
  const { rows } = await client.query(
    `UPDATE wallets SET ${sets.join(', ')}, updated_at = now()
      WHERE user_id = $1 ${guards.join(' ')}
      RETURNING ${BALANCE_COLUMNS}`,
    params,
  );
  return rows.length ? rowToBalances(rows[0]) : null;
}

/**
 * Append the audit rows in the SAME transaction as the balance move: a balance
 * can never shift without its ledger row. Returns false on a UNIQUE tx_id
 * collision — that is not an error, it is the idempotency gate firing, and the
 * caller unwinds the whole movement.
 *
 * ── Sign convention ─────────────────────────────────────────────────────────
 * Callers pass `amountPaise` SIGNED because that is what a balance leg means,
 * but the row is STORED the way the forward mirror stores it: a positive
 * magnitude with the direction in `tx_type`. That is not a style choice —
 * `WalletLedger.amount` is a positive Number on the Mongo side, and the
 * reverse mirror copies `amount_paise` straight into it. Storing −500 here
 * would push a negative amount back into Mongo on rollback and make every
 * sum-based check disagree between the two stores.
 */
async function appendLedgerRows(client, uid, rows, after) {
  try {
    for (const row of rows) {
      const balanceAfter = after[row.field];
      const magnitude = Math.abs(row.amountPaise);
      const direction = row.type || (row.amountPaise < 0 ? 'DEBIT' : 'CREDIT');
      const balanceBefore = direction === 'DEBIT'
        ? balanceAfter + magnitude
        : balanceAfter - magnitude;
      await client.query(
        `INSERT INTO wallet_ledger
           (tx_id, user_id, field, amount_paise, balance_before_paise, balance_after_paise, tx_type, description, ref_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          row.txId, uid, row.field, magnitude, balanceBefore, balanceAfter,
          direction, row.reason ?? null, row.refId ? String(row.refId) : null,
        ],
      );
    }
    return true;
  } catch (error) {
    if (error.code === '23505') return false; // unique_violation on tx_id
    throw error;
  }
}

function validateLedgerRows(ledger) {
  for (const row of ledger) {
    if (!row.txId) throw new Error('every ledger row needs a txId (idempotency key)');
    columnFor(row.field);
    if (!Number.isInteger(row.amountPaise)) {
      throw new TypeError(`ledger row '${row.txId}': amountPaise must be an integer, got ${row.amountPaise}`);
    }
  }
}

/**
 * What the ORIGINAL movement produced, looked up after a replay was refused. A
 * replay must answer the same thing the first call did, however many unrelated
 * movements have landed since — so this reads the ledger, not today's balance.
 */
async function replayedBalances(txIds) {
  const { rows } = await pgQuery(
    `SELECT tx_id, balance_after_paise FROM wallet_ledger WHERE tx_id = ANY($1)`,
    [txIds], 'wallet_replay',
  );
  return Object.fromEntries(rows.map((r) => [r.tx_id, toPaise(r.balance_after_paise)]));
}

// ── The mutation API ─────────────────────────────────────────────────────────

/**
 * applyMovementPaise — THE general mutation: move N balance fields and append M
 * ledger rows, atomically, under one row lock.
 *
 * Why N legs and M rows rather than a series of single-field calls: a Mongo
 * movement like "lock a withdrawal" is ONE `$inc` touching winnings and locked
 * together with ONE ledger row. Composing that from two independent
 * single-field transactions would open a window where the money is in neither
 * pocket, and would write twice the ledger rows the forward mirror has been
 * producing.
 *
 * ── txId parity (the reason ledger rows are caller-supplied) ────────────────
 * The caller passes the EXACT txId strings the Mongo path uses
 * (`wd_lock_<id>`, `bet_<u>_<c>_<b>_dep`, …). That is not cosmetic:
 *   • the reverse mirror copies these rows back into Mongo, where
 *     `WalletLedger.findOne({ txId })` is the idempotency gate — a rolled-back
 *     deployment must recognise movements made while Postgres was
 *     authoritative, or it will replay them;
 *   • reconcile matches wallet_ledger.tx_id against WalletLedger.txId, so a
 *     divergent key scheme would read as permanent drift.
 * Generating keys here instead would break both.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {Array<{field:string, deltaPaise:number, allowNegative?:boolean}>} args.legs
 * @param {Array<{txId:string, field:string, amountPaise:number, type?:string,
 *                reason?:string, refId?:string}>} args.ledger
 *   A ledger row's `field` must be a field the movement actually touched: the
 *   reverse mirror reads it to know which balance the row describes.
 * @param {boolean} [args.allowNegative=false] blanket override for every leg.
 *
 * @returns {Promise<{ok, idempotent, insufficient?, balancesAfterPaise, replayedLedger?}>}
 */
export async function applyMovementPaise({ userId, legs, ledger, allowNegative = false }) {
  if (!Array.isArray(legs) || !legs.length) {
    throw new Error('applyMovementPaise requires at least one balance leg');
  }
  if (!Array.isArray(ledger) || !ledger.length) {
    throw new Error('applyMovementPaise requires at least one ledger row — a balance must never move unaudited');
  }
  validateLedgerRows(ledger);
  const merged = mergeLegs(legs, allowNegative);

  const outcome = await withWalletLock(userId, async (ctx) => {
    const value = await applyMovementWithin(ctx, { merged, ledger });
    return { commit: value.ok && !value.idempotent, value };
  });

  // The replay lookup has to happen out here: inside the transaction the
  // connection is still poisoned by the constraint violation that got us here.
  if (outcome.idempotent) {
    outcome.replayedLedger = await replayedBalances(ledger.map((r) => r.txId));
  }
  return outcome;
}

/**
 * The movement itself, executed inside a lock someone else opened.
 *
 * Split out from applyMovementPaise so a caller that must do MORE than move a
 * balance — write a bet row and its stake debit, in the same transaction or not
 * at all — can compose with it instead of opening a second one. betPg is that
 * caller, and the composition is the entire point of the domain: the Mongo
 * original writes the bet, moves the balance and appends the ledger as three
 * separate operations, which is defect M-4 (money moves unaudited when the
 * ledger write fails, and the ledger is what reconciliation is computed from,
 * so the failure erases its own symptom).
 *
 * Does NOT commit or roll back. The lock holder decides that, because only it
 * knows whether the rest of the transaction succeeded.
 *
 * `merged` is pre-normalised leg output from mergeLegs(); callers outside this
 * module should pass `legs`/`allowNegative` and let it normalise.
 */
export async function applyMovementWithin({ client, uid }, { legs, merged, ledger, allowNegative = false }) {
  if (!merged) {
    if (!Array.isArray(legs) || !legs.length) {
      throw new Error('applyMovementWithin requires at least one balance leg');
    }
    if (!Array.isArray(ledger) || !ledger.length) {
      throw new Error('applyMovementWithin requires at least one ledger row — a balance must never move unaudited');
    }
    validateLedgerRows(ledger);
  }
  const columns = merged ?? mergeLegs(legs, allowNegative);

  const after = await moveBalances(client, uid, columns);
  if (!after) {
    return { ok: false, insufficient: true, idempotent: false, balancesAfterPaise: null };
  }
  if (!await appendLedgerRows(client, uid, ledger, after)) {
    return { ok: true, idempotent: true, balancesAfterPaise: null };
  }
  return { ok: true, idempotent: false, balancesAfterPaise: after };
}

/**
 * applyDeltaPaise — move one balance field by a signed paise amount.
 *
 * @param {object}  args
 * @param {string}  args.userId
 * @param {string}  args.field       one of BALANCE_FIELDS
 * @param {number}  args.deltaPaise  signed; negative debits
 * @param {string}  args.txId        idempotency key (required — a money movement
 *                                   without one cannot be safely retried)
 * @param {string}  [args.type]      ledger tx_type
 * @param {string}  [args.reason]
 * @param {string}  [args.refId]
 * @param {boolean} [args.allowNegative=false] only for corrective admin paths
 *
 * @returns {Promise<{ok, idempotent, balanceAfterPaise, insufficient?}>}
 *   ok:false + insufficient:true when the guard refused the debit — the caller
 *   decides how to surface it, exactly as the Mongo path does.
 */
export async function applyDeltaPaise({
  userId, field, deltaPaise, txId,
  type = null, reason = null, refId = null, allowNegative = false,
}) {
  if (!txId) throw new Error('applyDeltaPaise requires a txId (idempotency key)');
  if (!Number.isInteger(deltaPaise)) {
    throw new TypeError(`deltaPaise must be an integer number of paise, got ${deltaPaise}`);
  }
  const result = await applyMovementPaise({
    userId,
    legs: [{ field, deltaPaise }],
    ledger: [{ txId, field, amountPaise: deltaPaise, type, reason, refId }],
    allowNegative,
  });
  return {
    ok: result.ok,
    idempotent: result.idempotent,
    ...(result.insufficient ? { insufficient: true } : {}),
    balanceAfterPaise: result.balancesAfterPaise
      ? result.balancesAfterPaise[field]
      : (result.replayedLedger?.[txId] ?? null),
  };
}

/** Rupee-denominated convenience over applyDeltaPaise, for Mongo-shaped callers. */
export async function applyDeltaRupees({ userId, field, deltaRupees, ...rest }) {
  return applyDeltaPaise({ userId, field, deltaPaise: rupeesToPaise(deltaRupees), ...rest });
}

/**
 * transferPaise — move value between two fields of the SAME user atomically
 * (locking a withdrawal, releasing a stake). Both legs and both ledger rows
 * commit together or not at all; the two-write window the Mongo path has
 * between them does not exist here.
 *
 * Ledger rows are keyed `${txId}:from` / `${txId}:to` so the pair replays as a
 * unit under one caller-supplied idempotency key. Callers that must reproduce
 * a specific Mongo ledger shape (one row for a two-pocket move) should use
 * applyMovementPaise directly and supply the exact txIds instead.
 */
export async function transferPaise({
  userId, fromField, toField, amountPaise, txId,
  type = null, reason = null, refId = null,
}) {
  if (!txId) throw new Error('transferPaise requires a txId (idempotency key)');
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new TypeError(`amountPaise must be a positive integer, got ${amountPaise}`);
  }
  if (fromField === toField) throw new Error('transferPaise needs two different fields');

  const result = await applyMovementPaise({
    userId,
    legs: [
      { field: fromField, deltaPaise: -amountPaise },
      { field: toField,   deltaPaise:  amountPaise },
    ],
    ledger: [
      { txId: `${txId}:from`, field: fromField, amountPaise: -amountPaise, type, reason, refId },
      { txId: `${txId}:to`,   field: toField,   amountPaise:  amountPaise, type, reason, refId },
    ],
  });

  if (!result.ok) return { ok: false, insufficient: true, idempotent: false };
  if (result.idempotent) return { ok: true, idempotent: true };
  return {
    ok: true, idempotent: false,
    fromAfterPaise: result.balancesAfterPaise[fromField],
    toAfterPaise:   result.balancesAfterPaise[toField],
  };
}

/**
 * debitSpendOrderPaise — spend a single amount across several pockets in
 * priority order (deposit first, winnings covers the shortfall, and for bets a
 * reserve slice on top). This is what `debitForBet` and bet placement do.
 *
 * ── Why this cannot be composed from applyMovementPaise ─────────────────────
 * The split depends on the balances, so it has to be decided while the row is
 * locked. Deciding it from an unlocked read and hoping the guard catches a
 * stale split is not merely racy, it is UNSAFE for idempotency: a replay whose
 * fresh split happens to draw nothing from deposit would write no `_dep` row,
 * miss the UNIQUE collision that makes a replay a no-op, and debit twice.
 *
 * Under the lock the probe below is exact: if any ledger row already exists
 * for one of the keys THIS movement would write, the movement has happened and
 * we stop. The Mongo path's equivalent pre-read is explicitly documented there
 * as a fast path rather than a guarantee — here it is a guarantee.
 *
 * ── Why the probe enumerates keys instead of matching a prefix ───────────────
 * This was `tx_id LIKE '<txId>%'`, which is wrong in two ways that both END IN
 * AN UNCHARGED DEBIT — the probe reports "already done" and the caller is told
 * the spend succeeded while no money moved:
 *   • `%` and `_` are LIKE metacharacters. `debitForBet` is reached from the
 *     game-provider wallet webhook, whose txId is taken verbatim from the
 *     provider payload, so a txId of `%` expands to `%%` and matches ANY
 *     existing row for that user — every bet becomes free.
 *   • even with inert input it is a PREFIX test, so a later txId that happens
 *     to be a prefix of an earlier one (`…_b1` arriving after `…_b10`) matches
 *     a row belonging to a DIFFERENT movement.
 * The keys this movement can write are known exactly — one per pocket — so the
 * probe tests for those and nothing else. A pocket the original skipped
 * (`take === 0`, so no row) is still covered, because any ONE surviving row
 * proves the movement ran.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {string} args.txId  BASE key; per-pocket rows are `${txId}${suffix}`
 * @param {Array<{field:string, suffix:string, capPaise?:number, reason?:string}>} args.pockets
 *   drawn in order until the amount is covered; `capPaise` limits how much a
 *   pocket may contribute (the reserve slice uses it).
 * @param {number} args.amountPaise
 *
 * @returns {Promise<{ok, idempotent, insufficient?, availablePaise?, split?, balancesAfterPaise?}>}
 */
export async function debitSpendOrderPaise({
  userId, amountPaise, txId, pockets,
  type = 'DEBIT', reason = null, refId = null,
}) {
  if (!txId) throw new Error('debitSpendOrderPaise requires a txId (idempotency key)');
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new TypeError(`amountPaise must be a positive integer, got ${amountPaise}`);
  }
  if (!Array.isArray(pockets) || !pockets.length) {
    throw new Error('debitSpendOrderPaise requires at least one pocket');
  }
  for (const pocket of pockets) columnFor(pocket.field);

  const outcome = await withWalletLock(userId, async ({ client, uid, balances }) => {
    // Durable idempotency probe — exact because we hold this user's lock, and
    // literal because it names the keys rather than pattern-matching them.
    const seen = await client.query(
      `SELECT 1 FROM wallet_ledger WHERE user_id = $1 AND tx_id = ANY($2) LIMIT 1`,
      [uid, pockets.map((p) => `${txId}${p.suffix}`)],
    );
    if (seen.rows.length) {
      return { commit: false, value: { ok: true, idempotent: true } };
    }

    let remaining = amountPaise;
    const split = [];
    for (const pocket of pockets) {
      if (remaining <= 0) break;
      const available = Math.max(0, balances[pocket.field]);
      const ceiling = Number.isInteger(pocket.capPaise)
        ? Math.min(available, pocket.capPaise)
        : available;
      const take = Math.min(ceiling, remaining);
      if (take > 0) {
        split.push({ field: pocket.field, suffix: pocket.suffix, amountPaise: take, reason: pocket.reason });
        remaining -= take;
      }
    }

    if (remaining > 0) {
      const availablePaise = pockets.reduce((sum, p) => sum + Math.max(0, balances[p.field]), 0);
      return { commit: false, value: { ok: false, insufficient: true, idempotent: false, availablePaise } };
    }

    const after = await moveBalances(
      client, uid,
      mergeLegs(split.map((s) => ({ field: s.field, deltaPaise: -s.amountPaise })), false),
    );
    // Unreachable in practice — the split was computed from the locked row —
    // but a guard that refused means the arithmetic disagreed with the DB, and
    // that must never be committed.
    if (!after) {
      return { commit: false, value: { ok: false, insufficient: true, idempotent: false } };
    }

    const ledger = split.map((s) => ({
      txId: `${txId}${s.suffix}`, field: s.field, amountPaise: -s.amountPaise,
      type, reason: s.reason || reason, refId,
    }));
    if (!await appendLedgerRows(client, uid, ledger, after)) {
      return { commit: false, value: { ok: true, idempotent: true } };
    }

    return {
      commit: true,
      value: {
        ok: true, idempotent: false, balancesAfterPaise: after,
        split: Object.fromEntries(split.map((s) => [s.field, s.amountPaise])),
      },
    };
  });

  return outcome;
}
