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
import { getPool, pgQuery } from './pgClient.js';
import { rupeesToPaise, paiseToRupees } from '../shared/money.js';

/** Mongo balance field → its paise column on `wallets`. */
export const FIELD_COLUMN = Object.freeze({
  depositBalance:  'deposit_paise',
  winningsBalance: 'winnings_paise',
  tokenBalance:    'token_paise',
  reserveBalance:  'reserve_paise',
  lockedBalance:   'locked_paise',
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
    `SELECT deposit_paise, winnings_paise, token_paise, reserve_paise, locked_paise
       FROM wallets WHERE user_id = $1`,
    [String(userId)],
    'wallet_read',
  );
  const row = rows[0] || {};
  return {
    depositBalance:  toPaise(row.deposit_paise),
    winningsBalance: toPaise(row.winnings_paise),
    tokenBalance:    toPaise(row.token_paise),
    reserveBalance:  toPaise(row.reserve_paise),
    lockedBalance:   toPaise(row.locked_paise),
  };
}

/** The same balances in rupees, for callers still speaking the Mongo shape. */
export async function getBalancesRupees(userId) {
  const paise = await getBalancesPaise(userId);
  return Object.fromEntries(
    Object.entries(paise).map(([field, value]) => [field, paiseToRupees(value)]),
  );
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
  const column = columnFor(field);
  const uid = String(userId);

  const pool = await getPool();
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL unset)');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Materialise the wallet row so FOR UPDATE has something to lock. A
    // first-ever movement and a concurrent one race here; ON CONFLICT makes the
    // loser a no-op rather than an error.
    await client.query(
      `INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [uid],
    );

    // Serialise every movement for this user behind the row lock.
    await client.query(`SELECT 1 FROM wallets WHERE user_id = $1 FOR UPDATE`, [uid]);

    // The guard lives in the UPDATE's WHERE clause, so a debit that would go
    // negative simply matches no row — it cannot be lost to a race between a
    // read and a write.
    const guard = allowNegative || deltaPaise >= 0 ? '' : `AND ${column} + $2 >= 0`;
    const updated = await client.query(
      `UPDATE wallets SET ${column} = ${column} + $2, updated_at = now()
        WHERE user_id = $1 ${guard}
        RETURNING ${column} AS balance_after`,
      [uid, deltaPaise],
    );

    if (!updated.rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, insufficient: true, idempotent: false, balanceAfterPaise: null };
    }

    const balanceAfterPaise = toPaise(updated.rows[0].balance_after);

    // Same transaction as the balance move: a balance can never shift without
    // its ledger row, and the UNIQUE tx_id is what makes a replay a no-op.
    try {
      await client.query(
        `INSERT INTO wallet_ledger
           (tx_id, user_id, field, amount_paise, balance_after_paise, tx_type, description, ref_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [txId, uid, field, deltaPaise, balanceAfterPaise, type, reason, refId ? String(refId) : null],
      );
    } catch (error) {
      if (error.code === '23505') { // unique_violation on tx_id — this movement already happened
        await client.query('ROLLBACK');
        const { rows } = await pgQuery(
          `SELECT balance_after_paise FROM wallet_ledger WHERE tx_id = $1`, [txId], 'wallet_replay',
        );
        return {
          ok: true, idempotent: true,
          balanceAfterPaise: rows.length ? toPaise(rows[0].balance_after_paise) : null,
        };
      }
      throw error;
    }

    await client.query('COMMIT');
    return { ok: true, idempotent: false, balanceAfterPaise };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* already unwound */ }
    throw error;
  } finally {
    client.release();
  }
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
 * unit under one caller-supplied idempotency key.
 */
export async function transferPaise({
  userId, fromField, toField, amountPaise, txId,
  type = null, reason = null, refId = null,
}) {
  if (!txId) throw new Error('transferPaise requires a txId (idempotency key)');
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new TypeError(`amountPaise must be a positive integer, got ${amountPaise}`);
  }
  const fromColumn = columnFor(fromField);
  const toColumn = columnFor(toField);
  if (fromField === toField) throw new Error('transferPaise needs two different fields');

  const uid = String(userId);
  const pool = await getPool();
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL unset)');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [uid]);
    await client.query(`SELECT 1 FROM wallets WHERE user_id = $1 FOR UPDATE`, [uid]);

    const moved = await client.query(
      `UPDATE wallets
          SET ${fromColumn} = ${fromColumn} - $2,
              ${toColumn}   = ${toColumn}   + $2,
              updated_at = now()
        WHERE user_id = $1 AND ${fromColumn} - $2 >= 0
        RETURNING ${fromColumn} AS from_after, ${toColumn} AS to_after`,
      [uid, amountPaise],
    );

    if (!moved.rows.length) {
      await client.query('ROLLBACK');
      return { ok: false, insufficient: true, idempotent: false };
    }

    const fromAfter = toPaise(moved.rows[0].from_after);
    const toAfter = toPaise(moved.rows[0].to_after);

    try {
      await client.query(
        `INSERT INTO wallet_ledger (tx_id, user_id, field, amount_paise, balance_after_paise, tx_type, description, ref_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8), ($9,$2,$10,$11,$12,$6,$7,$8)`,
        [
          `${txId}:from`, uid, fromField, -amountPaise, fromAfter, type, reason,
          refId ? String(refId) : null,
          `${txId}:to`, toField, amountPaise, toAfter,
        ],
      );
    } catch (error) {
      if (error.code === '23505') {
        await client.query('ROLLBACK');
        return { ok: true, idempotent: true };
      }
      throw error;
    }

    await client.query('COMMIT');
    return { ok: true, idempotent: false, fromAfterPaise: fromAfter, toAfterPaise: toAfter };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* already unwound */ }
    throw error;
  } finally {
    client.release();
  }
}
