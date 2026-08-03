// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/merchantWalletPg.js — the Postgres merchant token wallet.
 *
 * Domain 1 of the full-authority migration (docs/POSTGRES_FULL_AUTHORITY_PLAN.md).
 * The Mongo original, domains/merchant/merchantWallet.service.js, is the sole
 * writer of `Merchant.tokenBalance` and had no Postgres counterpart at all —
 * only its ledger was mirrored, never the balance. That made it the single
 * largest gap: every user↔merchant settlement and admin↔merchant issuance runs
 * through it, so no "Postgres owns the money" claim was possible without it.
 *
 * ── Which shape this copies, and which it does not ──────────────────────────
 * It follows walletPg.js: one transaction per movement, the wallet row locked
 * with SELECT … FOR UPDATE, the guard in the UPDATE's WHERE clause, and the
 * ledger row written in the SAME transaction. A balance can never move without
 * its entry.
 *
 * It deliberately does NOT copy _mongoBetStake, which moves the balance and
 * writes the ledger as two separate operations (M-4) with no idempotency key on
 * the movement (M-2). Those defects are recorded in docs/MONGO_MONEY_AUDIT.md
 * and must not be carried across.
 *
 * The Mongo merchant path's own reserve→move→complete idea IS carried across,
 * but expressed properly: instead of a row with a null balanceAfter that a
 * crash can strand, a reservation is a real balance movement (available →
 * reserved) inside one transaction. It cannot be half-done.
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
import { getPool, pgQuery, connectGuarded } from './pgClient.js';

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
async function withMerchantLock(merchantId, fn) {
  const mid = String(merchantId);
  const pool = await getPool();
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL unset)');
  const client = await connectGuarded(pool);

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
    try { await client.query('ROLLBACK'); } catch { /* already unwound */ }
    throw error;
  } finally {
    client.release();
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
           (tx_id, merchant_id, pocket, amount_paise, balance_before_paise, balance_after_paise,
            entry_type, operation, actor, reason, ref_model, ref_id, correlation_id, reverses_tx_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          e.txId, mid, e.pocket, Math.abs(e.amountPaise), e.balanceBefore, e.balanceAfter,
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

  return withMerchantLock(merchantId, async ({ client, mid, balances }) => {
    const after = await movePockets(client, mid, legs, { allowNegativeAvailable });
    if (!after) {
      return { commit: false, value: { ok: false, insufficient: true, idempotent: false, balances } };
    }

    // One entry per pocket that moved, each carrying its own before/after so a
    // reader never has to recompute them from a running total.
    const entries = Object.entries(legs)
      .filter(([, delta]) => delta)
      .map(([pocket, delta], index) => ({
        // Per-pocket suffix keeps every entry's tx_id unique while the whole
        // movement still replays under one caller-supplied key.
        txId: Object.keys(legs).filter((p) => legs[p]).length > 1 ? `${txId}:${pocket}` : txId,
        pocket,
        amountPaise: delta,
        balanceBefore: balances[pocket],
        balanceAfter: after[pocket],
        entryType: delta > 0 ? 'CREDIT' : 'DEBIT',
        operation, actor, reason, refModel, refId, correlationId,
        reversesTxId: index === 0 ? reversesTxId : null,
      }));

    if (!await appendEntries(client, mid, entries)) {
      return { commit: false, value: { ok: true, idempotent: true, balances } };
    }
    // `entries` travels back out so the caller can mirror exactly what
    // committed rather than reconstructing it — merchantWalletPgAuthority's
    // rollback leg copies these rows into Mongo, and a reconstruction that
    // drifted from what the transaction actually wrote would make the fallback
    // silently wrong.
    return { commit: true, value: { ok: true, idempotent: false, balances: after, entries } };
  });
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
 * ONE such thing exists by design: the Phase A dual-write
 * (dualWrite.mirrorMerchantBalance) sets available_paise directly from Mongo,
 * because during Phase A Mongo owns the movement and its ledger. Balances that
 * arrived that way are unexplained here until recordOpeningBalances() posts the
 * opening entry — which is the cutover step that makes this check meaningful
 * from the flip forward. Before that step, drift equal to the mirrored balance
 * is expected, not a defect.
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

/**
 * recordOpeningBalances — the cutover step that gives the Postgres ledger a
 * starting point.
 *
 * THE ONLY FUNCTION HERE THAT WRITES AN ENTRY WITHOUT MOVING A BALANCE, and it
 * is deliberate. At cutover, merchant_wallets already holds each merchant's
 * balance — put there by the Phase A mirror, which is a projection of movements
 * that were ledgered in MONGO. Postgres has the number but not the history, so
 * `reconcileMerchant` would report drift equal to the opening balance forever
 * and the entries-explain-balance invariant could never hold.
 *
 * Posting an opening entry per pocket closes that gap the way a ledger
 * migration is supposed to: the pre-migration history stays where it happened,
 * and one entry states the position it left behind. From that point every
 * further movement writes its own entry inside its own transaction, so the
 * invariant holds from the flip forward.
 *
 * Idempotent by construction — `mw_opening_<merchantId>_<pocket>` is UNIQUE, so
 * a second run inserts nothing. Safe to re-run, and safe to run before the flip.
 *
 * @returns {{ merchantId: string, posted: string[], balances: object, conflicts: string[] }}
 */
export async function recordOpeningBalances(merchantId, { actor = 'cutover' } = {}) {
  return withMerchantLock(merchantId, async ({ client, mid, balances }) => {
    const sums = await ledgerSums(mid, (text, params) => client.query(text, params));
    const posted = [];

    for (const pocket of ALL_POCKETS) {
      const delta = balances[pocket] - sums[pocket];
      // Nothing to open: the ledger already explains this pocket. This is the
      // ordinary second-run outcome, and it is not a conflict.
      if (delta === 0) continue;

      const txId = `mw_opening_${mid}_${pocket}`;
      const ok = await appendEntries(client, mid, [{
        txId,
        pocket,
        amountPaise: delta,
        // before = what the ledger already explains; after = the real balance.
        // The arithmetic CHECK holds by construction, and a partially-opened
        // wallet (some entries already present) opens for the remainder only.
        balanceBefore: sums[pocket],
        balanceAfter: balances[pocket],
        entryType: delta > 0 ? 'CREDIT' : 'DEBIT',
        operation: 'OPENING_BALANCE',
        actor,
        reason: 'Opening balance at PostgreSQL cutover — history predates this ledger',
      }]);

      // The key collided while the pocket STILL does not reconcile. That is not
      // a repeat run — it means the balance moved after this pocket was opened,
      // without writing an entry. Something outside this module wrote. Unwind
      // and report it rather than papering over it with a second opening entry,
      // which would silently launder the unexplained movement into the ledger.
      if (!ok) {
        return {
          commit: false,
          value: { merchantId: mid, posted: [], balances, conflicts: [pocket] },
        };
      }
      posted.push(txId);
    }

    return { commit: posted.length > 0, value: { merchantId: mid, posted, balances, conflicts: [] } };
  });
}
