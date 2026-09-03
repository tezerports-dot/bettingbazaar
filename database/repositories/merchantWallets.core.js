// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/merchantWalletPg.js — the Postgres merchant token wallet.
 *
 * A merchant's money, in pockets, with an append-only entry per movement. It
 * replaced a single mutable counter on the merchant record; every
 * user<->merchant settlement and admin<->merchant issuance runs through here,
 * and a counter cannot say where the value came from or where it went.
 *
 * ── The shape ───────────────────────────────────────────────────────────────
 * The same as the player wallet: one transaction per movement, the row locked
 * with SELECT … FOR UPDATE, the guard in the UPDATE's WHERE clause, and the
 * ledger row written in the SAME transaction. A balance can never move without
 * its entry.
 *
 * Two defects of the shape it replaced are deliberately NOT carried across:
 * moving the balance and writing the ledger as two separate operations (M-4),
 * and no idempotency key on the movement (M-2).
 *
 * The reserve->move->complete idea IS carried across, but expressed properly:
 * instead of a row with a null balanceAfter that a crash can strand, a
 * reservation is a real balance movement (available -> reserved) inside one
 * transaction. It cannot be half-done.
 *
 * ── Pockets ─────────────────────────────────────────────────────────────────
 *   available   spendable now
 *   reserved    committed to an in-flight settlement, not yet applied
 *   settlement  owed out, awaiting payout
 * liability = reserved + settlement.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 * `tx_id` is UNIQUE. A replay collides INSIDE the transaction and the whole
 * movement unwinds, returning `{ idempotent: true }`. That is the gate; there
 * is no pre-read, because a pre-read is a race two concurrent callers can both
 * pass (the lesson recorded in GOVERNANCE §20 and re-proven by the LIKE-probe
 * bug this audit found in walletPg).
 */
import { getPool, pgQuery, connectGuarded } from '../client.js';

/** The pockets a merchant balance is divided into. */
export const POCKETS = Object.freeze({
  AVAILABLE:  'available',
  RESERVED:   'reserved',
  SETTLEMENT: 'settlement',
});

const POCKET_COLUMN = Object.freeze({
  [POCKETS.AVAILABLE]:  'available_paise',
  [POCKETS.RESERVED]:   'reserved_paise',
  [POCKETS.SETTLEMENT]: 'settlement_paise',
});

const ALL_POCKETS = Object.freeze(Object.keys(POCKET_COLUMN));
const BALANCE_COLUMNS = ALL_POCKETS.map((p) => POCKET_COLUMN[p]).join(', ');

function columnFor(pocket) {
  const column = POCKET_COLUMN[pocket];
  if (!column) {
    throw new Error(`Unknown merchant pocket '${pocket}'. Known: ${ALL_POCKETS.join(', ')}`);
  }
  return column;
}

/** pg returns BIGINT as a string; every balance crosses this boundary as paise. */
const toPaise = (v) => Number(v ?? 0);

function rowToBalances(row = {}) {
  const balances = Object.fromEntries(ALL_POCKETS.map((p) => [p, toPaise(row[POCKET_COLUMN[p]])]));
  // Derived, never stored: storing it would be a fourth number that can
  // disagree with the three it summarises.
  balances.liability = balances.reserved + balances.settlement;
  return balances;
}

/** Every pocket for a merchant, in integer paise. Zeros for an unknown merchant. */
export async function getMerchantBalances(merchantId) {
  const { rows } = await pgQuery(
    `SELECT ${BALANCE_COLUMNS} FROM merchant_wallets WHERE merchant_id = $1`,
    [String(merchantId)],
    'merchant_wallet_read',
  );
  return rowToBalances(rows[0]);
}

/**
 * Open a transaction, materialise the merchant's wallet row, lock it, and hand
 * the callback the balances AS OF that lock. Same contract as walletPg's
 * withWalletLock — see there for why the lock rather than a hopeful pre-read.
 */
/**
 * Spendable balances for MANY merchants, in one round trip.
 *
 * Assignment picks a merchant for every deposit, so this is on the hot path of
 * a money movement. A read per candidate turns one decision into N round trips
 * and gives each candidate a slightly different moment to be judged at; one
 * query judges them all against the same snapshot.
 *
 * A merchant with NO wallet row is absent from the result rather than reported
 * as zero, and the difference matters at the call site: no row means the money
 * system has never seen this merchant, which routes differently from a merchant
 * that is merely empty.
 *
 * @returns {Promise<Map<string, number>>} merchant id -> available paise
 */
export async function getAvailablePaiseFor(merchantIds = []) {
  const ids = [...new Set(merchantIds.filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const { rows } = await pgQuery(
    `SELECT merchant_id, ${POCKET_COLUMN[POCKETS.AVAILABLE]} AS available
       FROM merchant_wallets WHERE merchant_id = ANY($1::text[])`,
    [ids], 'merchant_wallet_read_many',
  );
  // BIGINT arrives as a string; uncast, '900' >= 1000 is true and every
  // eligibility comparison built on this map is wrong.
  return new Map(rows.map((r) => [r.merchant_id, toPaise(r.available)]));
}

export async function withMerchantLock(merchantId, fn) {
  const mid = String(merchantId);
  const pool = await getPool();
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL unset)');
  const client = await connectGuarded(pool);
  let failure = null;

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO merchant_wallets (merchant_id) VALUES ($1) ON CONFLICT (merchant_id) DO NOTHING`,
      [mid],
    );
    const locked = await client.query(
      `SELECT ${BALANCE_COLUMNS} FROM merchant_wallets WHERE merchant_id = $1 FOR UPDATE`, [mid],
    );
    const { commit, value } = await fn({ client, mid, balances: rowToBalances(locked.rows[0]) });
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return value;
  } catch (error) {
    failure = error;
    try { await client.query('ROLLBACK'); } catch { /* already unwound */ }
    throw error;
  } finally {
    // Passing the error DESTROYS the client instead of returning it to the
    // pool. That matters when the backend went away mid-transaction — a
    // Postgres restart, a failover, an admin pg_terminate_backend: the socket
    // is dead but a plain release() puts it back in rotation, and the NEXT
    // caller inherits "terminating connection due to administrator command" on
    // a query of its own. Found by killing a backend mid-transition in the
    // settlement suite, where the failure surfaced two statements later in an
    // unrelated read.
    client.release(failure ?? undefined);
  }
}

/**
 * Apply signed deltas to the locked row. Guards live in the WHERE clause, so a
 * movement that would overdraw matches no row rather than being caught by a
 * read that a concurrent writer could already have invalidated.
 */
async function movePockets(client, mid, legs, { allowNegativeAvailable = false } = {}) {
  const params = [mid];
  const sets = [];
  const guards = [];
  for (const [pocket, delta] of Object.entries(legs)) {
    if (!delta) continue;
    const column = columnFor(pocket);
    params.push(delta);
    const ph = `$${params.length}`;
    sets.push(`${column} = ${column} + ${ph}`);
    // reserved/settlement are also protected by CHECK constraints, but a guard
    // here turns a violation into a clean refusal rather than an exception.
    const guarded = pocket !== POCKETS.AVAILABLE || !allowNegativeAvailable;
    if (delta < 0 && guarded) guards.push(`AND ${column} + ${ph} >= 0`);
  }
  if (!sets.length) throw new Error('movePockets called with no non-zero legs');

  const { rows } = await client.query(
    `UPDATE merchant_wallets SET ${sets.join(', ')}, updated_at = now()
      WHERE merchant_id = $1 ${guards.join(' ')}
      RETURNING ${BALANCE_COLUMNS}`,
    params,
  );
  return rows.length ? rowToBalances(rows[0]) : null;
}

/**
 * Append the entries in the SAME transaction as the movement. Returns false on
 * a UNIQUE tx_id collision — the idempotency gate firing, not an error.
 */
async function appendEntries(client, mid, entries) {
  try {
    for (const e of entries) {
      await client.query(
        `INSERT INTO merchant_wallet_entries
           (tx_id, movement_id, merchant_id, pocket, amount_paise, balance_before_paise, balance_after_paise,
            entry_type, operation, actor, reason, ref_model, ref_id, correlation_id, reverses_tx_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          e.txId, e.movementId ?? e.txId, mid, e.pocket, Math.abs(e.amountPaise),
          e.balanceBefore, e.balanceAfter,
          e.entryType, e.operation, e.actor ?? null, e.reason ?? null,
          e.refModel ?? null, e.refId ? String(e.refId) : null,
          e.correlationId ?? null, e.reversesTxId ?? null,
        ],
      );
    }
    return true;
  } catch (error) {
    if (error.code === '23505') return false; // unique_violation on tx_id
    throw error;
  }
}

/**
 * applyMerchantMovement — THE general mutation. Every operation below is a thin
 * wrapper over this, so there is exactly one place where a merchant balance can
 * change and exactly one place that guarantees the entry accompanies it.
 *
 * @param {object}   args
 * @param {string}   args.merchantId
 * @param {string}   args.txId        idempotency key (required)
 * @param {string}   args.operation   e.g. 'ADMIN_ISSUANCE', 'RESERVE', 'SETTLE'
 * @param {object}   args.legs        { available?: signedPaise, reserved?: …, settlement?: … }
 * @param {boolean} [args.allowNegativeAvailable=false] authorised corrections only
 */
export async function applyMerchantMovement({
  merchantId, txId, operation, legs,
  actor = null, reason = null, refModel = null, refId = null,
  correlationId = null, reversesTxId = null, allowNegativeAvailable = false,
}) {
  if (!txId) throw new Error('applyMerchantMovement requires a txId (idempotency key)');
  if (!operation) throw new Error('applyMerchantMovement requires an operation');
  for (const [pocket, delta] of Object.entries(legs || {})) {
    columnFor(pocket);
    if (!Number.isInteger(delta)) {
      throw new TypeError(`leg '${pocket}': must be an integer number of paise, got ${delta}`);
    }
  }
  if (!Object.values(legs || {}).some((d) => d)) {
    throw new Error('applyMerchantMovement requires at least one non-zero leg');
  }

  return withMerchantLock(merchantId, async (ctx) => {
    const value = await applyMovementWithin(ctx, {
      txId, operation, legs, actor, reason, refModel, refId,
      correlationId, reversesTxId, allowNegativeAvailable,
    });
    return { commit: value.ok && !value.idempotent, value };
  });
}

/**
 * The movement itself, executed inside a lock someone else opened.
 *
 * Split out from applyMerchantMovement so a caller that must do MORE than move
 * pockets — advance a settlement's state, in the same transaction, or not at
 * all — can compose with it instead of opening a second transaction.
 * merchantSettlements is that caller, and the composition is the whole point:
 * moving state and money separately is what creates the stranding window this
 * design exists to close.
 *
 * Does NOT commit or roll back. The lock holder decides that, because only it
 * knows whether the rest of the transaction succeeded.
 */
export async function applyMovementWithin(
  { client, mid, balances },
  {
    txId, operation, legs, actor = null, reason = null, refModel = null, refId = null,
    correlationId = null, reversesTxId = null, allowNegativeAvailable = false,
  },
) {
  const after = await movePockets(client, mid, legs, { allowNegativeAvailable });
  if (!after) return { ok: false, insufficient: true, idempotent: false, balances };

  // One entry per pocket that moved, each carrying its own before/after so a
  // reader never has to recompute them from a running total.
  const movedPockets = Object.keys(legs).filter((p) => legs[p]);
  const entries = movedPockets.map((pocket, index) => ({
    // Per-pocket suffix keeps every entry's tx_id unique while the whole
    // movement still replays under one caller-supplied key.
    txId: movedPockets.length > 1 ? `${txId}:${pocket}` : txId,
    movementId: txId,
    pocket,
    amountPaise: legs[pocket],
    balanceBefore: balances[pocket],
    balanceAfter: after[pocket],
    entryType: legs[pocket] > 0 ? 'CREDIT' : 'DEBIT',
    operation, actor, reason, refModel, refId, correlationId,
    reversesTxId: index === 0 ? reversesTxId : null,
  }));

  if (!await appendEntries(client, mid, entries)) {
    return { ok: true, idempotent: true, balances };
  }
  // `entries` travels back out so a caller reports exactly what committed
  // rather than reconstructing it. A reconstruction that drifted from what the
  // transaction actually wrote would describe a movement that did not happen.
  return { ok: true, idempotent: false, balances: after, entries };
}

// ── Operations ───────────────────────────────────────────────────────────────

/** Admin mints tokens into a merchant's available pocket. */
export const adminIssueToMerchant = ({ merchantId, amountPaise, txId, actor, reason, refId, correlationId }) =>
  requirePositive(amountPaise, 'adminIssueToMerchant') && applyMerchantMovement({
    merchantId, txId, operation: 'ADMIN_ISSUANCE', legs: { available: amountPaise },
    actor, reason, refModel: 'MerchantAdminTokenOrder', refId, correlationId,
  });

/** Admin removes tokens. Refuses to overdraw unless explicitly authorised. */
export const adminDeductFromMerchant = ({ merchantId, amountPaise, txId, actor, reason, refId, correlationId, allowNegativeAvailable = false }) =>
  requirePositive(amountPaise, 'adminDeductFromMerchant') && applyMerchantMovement({
    merchantId, txId, operation: 'ADMIN_DEDUCTION', legs: { available: -amountPaise },
    actor, reason, refModel: 'AdminAdjustment', refId, correlationId, allowNegativeAvailable,
  });

/** Commit tokens to an in-flight settlement: available → reserved. */
export const reserveForSettlement = ({ merchantId, amountPaise, txId, reason, refId, correlationId }) =>
  requirePositive(amountPaise, 'reserveForSettlement') && applyMerchantMovement({
    merchantId, txId, operation: 'RESERVE',
    legs: { available: -amountPaise, reserved: amountPaise },
    reason, refModel: 'PaymentOrder', refId, correlationId,
  });

/** Give a reservation back when the settlement does not happen. */
export const cancelReservation = ({ merchantId, amountPaise, txId, reason, refId, correlationId }) =>
  requirePositive(amountPaise, 'cancelReservation') && applyMerchantMovement({
    merchantId, txId, operation: 'RESERVE_CANCEL',
    legs: { reserved: -amountPaise, available: amountPaise },
    reason, refModel: 'PaymentOrder', refId, correlationId,
  });

/** Complete a settlement: reserved → settlement (owed out, awaiting payout). */
export const completeReservation = ({ merchantId, amountPaise, txId, reason, refId, correlationId }) =>
  requirePositive(amountPaise, 'completeReservation') && applyMerchantMovement({
    merchantId, txId, operation: 'RESERVE_COMPLETE',
    legs: { reserved: -amountPaise, settlement: amountPaise },
    reason, refModel: 'PaymentOrder', refId, correlationId,
  });

/** Pay out what is owed, clearing the settlement pocket. */
export const payoutSettlement = ({ merchantId, amountPaise, txId, actor, reason, refId, correlationId }) =>
  requirePositive(amountPaise, 'payoutSettlement') && applyMerchantMovement({
    merchantId, txId, operation: 'PAYOUT', legs: { settlement: -amountPaise },
    actor, reason, refModel: 'MerchantPayout', refId, correlationId,
  });

/**
 * Reverse a completed movement by posting the opposite entry. Corrections are
 * new offsetting rows, never edits — the append-only trigger enforces that at
 * the database level, so this is the only way a mistake can be undone.
 */
export const reverseMovement = ({ merchantId, txId, reversesTxId, legs, actor, reason, correlationId }) =>
  applyMerchantMovement({
    merchantId, txId, operation: 'REVERSAL', legs,
    actor, reason, correlationId, reversesTxId, allowNegativeAvailable: true,
  });

function requirePositive(amountPaise, fn) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new TypeError(`${fn}: amountPaise must be a positive integer, got ${amountPaise}`);
  }
  return true;
}

/**
 * Does the ledger explain the balance? The reconciliation primitive — sums the
 * entries per pocket and compares with the stored balance. Any difference means
 * a balance moved without its entry, which this module's transaction structure
 * is designed to make impossible; a non-zero result is therefore evidence of
 * something outside it having written.
 *
 * There is no longer any legitimate source of drift. A mirror used to set a
 * balance directly, so an unexplained figure had a benign explanation and this
 * check had to be read with a caveat; there is nothing outside this module that
 * writes a merchant balance now. ANY non-zero drift is a defect.
 */
export async function reconcileMerchant(merchantId) {
  const fromLedger = await ledgerSums(merchantId, pgQuery);
  const balances = await getMerchantBalances(merchantId);
  const drift = Object.fromEntries(ALL_POCKETS.map((p) => [p, balances[p] - fromLedger[p]]));
  return {
    ok: ALL_POCKETS.every((p) => drift[p] === 0),
    balances, fromLedger, drift,
  };
}

/** Net per pocket from the entries, in paise. `run` is pgQuery or a locked client. */
async function ledgerSums(merchantId, run) {
  const { rows } = await run(
    `SELECT pocket,
            COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN amount_paise ELSE -amount_paise END), 0) AS net
       FROM merchant_wallet_entries WHERE merchant_id = $1 GROUP BY pocket`,
    [String(merchantId)], 'merchant_wallet_reconcile',
  );
  const sums = Object.fromEntries(ALL_POCKETS.map((p) => [p, 0]));
  for (const r of rows) sums[r.pocket] = toPaise(r.net);
  return sums;
}

