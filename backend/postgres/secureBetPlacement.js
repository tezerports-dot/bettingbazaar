// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Serializable Postgres-first money block for bet placement.
 *
 * Postgres locks and deducts the financial wallet before the caller writes the
 * operational MongoDB bet/session record. If that operational write fails, the
 * SQL transaction rolls back completely, preventing a split-state "free bet".
 */
import crypto from 'crypto';
import { getPool, pgConfigured } from './pgClient.js';

function decimal8(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid monetary amount: ${value}`);
  return n.toFixed(8);
}

export function secureBetReference(prefix = 'tx_bet') {
  return `${prefix}_${Date.now()}_${crypto.randomUUID()}`;
}

export async function processSecureBetPlacement({ userId, betAmount, currency = 'USD', referenceId = secureBetReference(), operationalWrite }) {
  if (!pgConfigured()) throw new Error('Postgres not configured (DATABASE_URL unset)');
  if (typeof operationalWrite !== 'function') throw new Error('operationalWrite callback is required');

  const pool = await getPool();
  const client = await pool.connect();
  const amount = decimal8(betAmount);
  const uid = String(userId);

  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query(
      `INSERT INTO user_wallets (user_id, currency)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [uid, currency],
    );

    const locked = await client.query(
      `SELECT balance FROM user_wallets WHERE user_id = $1 FOR UPDATE`,
      [uid],
    );
    if (!locked.rows.length) throw new Error('WALLET_NOT_FOUND');

    const debited = await client.query(
      `UPDATE user_wallets
         SET balance = balance - $1::NUMERIC(20,8), updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $2 AND balance >= $1::NUMERIC(20,8)
       RETURNING balance`,
      [amount, uid],
    );
    if (!debited.rows.length) throw new Error('INSUFFICIENT_FUNDS');

    const runningBalance = debited.rows[0].balance;
    await client.query(
      `INSERT INTO financial_ledger (user_id, transaction_type, amount, running_balance, reference_id)
       VALUES ($1, 'BET_PLACE', $2::NUMERIC(20,8), $3::NUMERIC(20,8), $4)`,
      [uid, amount, runningBalance, referenceId],
    );

    const operationalResult = await operationalWrite({ referenceId, runningBalance, pgClient: client });
    await client.query('COMMIT');
    return { success: true, referenceId, runningBalance, operationalResult };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore rollback errors */ }
    console.error('CRITICAL: secure bet execution rolled back cleanly:', error.message);
    throw error;
  } finally {
    client.release();
  }
}
