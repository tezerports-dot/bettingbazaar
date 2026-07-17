// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Serializable Postgres-first money block for bet placement.
 *
 * The debit, ledger entry, and operational-write intent commit atomically. The
 * external operational write runs only after that commit and is keyed by the
 * immutable referenceId, so a retry can safely complete a pending outbox item.
 */
import crypto from 'crypto';
import { getPool, pgConfigured } from './pgClient.js';

function decimal8(value) {
  if (typeof value !== 'string') throw new Error(`Invalid monetary amount: ${value}`);
  const decimal = value.trim();
  if (!/^\d+(?:\.\d{1,8})?$/.test(decimal) || !/[1-9]/.test(decimal.replace('.', ''))) {
    throw new Error(`Invalid monetary amount: ${value}`);
  }
  return decimal;
}

export function secureBetReference(prefix = 'tx_bet') {
  return `${prefix}_${Date.now()}_${crypto.randomUUID()}`;
}

async function runOperationalWrite(pool, { referenceId, runningBalance, operationalWrite }) {
  try {
    const operationalResult = await operationalWrite({ referenceId, runningBalance });
    await pool.query(
      `UPDATE operational_bet_outbox SET processed_at = CURRENT_TIMESTAMP, attempts = attempts + 1, last_error = NULL
       WHERE reference_id = $1`, [referenceId],
    );
    return { success: true, referenceId, runningBalance, operationalResult };
  } catch (error) {
    await pool.query(
      `UPDATE operational_bet_outbox SET attempts = attempts + 1, last_error = $2 WHERE reference_id = $1`,
      [referenceId, String(error.message || error).slice(0, 1000)],
    );
    console.error('CRITICAL: secure bet operational write is pending retry:', error.message);
    throw error;
  }
}

export async function processSecureBetPlacement({ userId, betAmount, currency = 'USD', referenceId = secureBetReference(), operationalWrite }) {
  if (!pgConfigured()) throw new Error('Postgres not configured (DATABASE_URL unset)');
  if (typeof operationalWrite !== 'function') throw new Error('operationalWrite callback is required');
  const amount = decimal8(betAmount);
  const uid = String(userId);
  const requestedCurrency = String(currency).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(requestedCurrency)) throw new Error('INVALID_CURRENCY');

  const pool = await getPool();
  const existing = await pool.query(
    `SELECT reference_id, running_balance, processed_at FROM operational_bet_outbox WHERE reference_id = $1`,
    [referenceId],
  );
  if (existing.rows.length) {
    if (existing.rows[0].processed_at) {
      return { success: true, referenceId, runningBalance: existing.rows[0].running_balance, alreadyProcessed: true };
    }
    return runOperationalWrite(pool, { referenceId, runningBalance: existing.rows[0].running_balance, operationalWrite });
  }

  const client = await pool.connect();
  let runningBalance;
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query(
      `INSERT INTO user_wallets (user_id, currency)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [uid, requestedCurrency],
    );

    const locked = await client.query(
      `SELECT balance, currency FROM user_wallets WHERE user_id = $1 FOR UPDATE`,
      [uid],
    );
    if (!locked.rows.length) throw new Error('WALLET_NOT_FOUND');
    if (locked.rows[0].currency !== requestedCurrency) throw new Error('CURRENCY_MISMATCH');

    const debited = await client.query(
      `UPDATE user_wallets
         SET balance = balance - $1::NUMERIC, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $2 AND balance >= $1::NUMERIC
       RETURNING balance`,
      [amount, uid],
    );
    if (!debited.rows.length) throw new Error('INSUFFICIENT_FUNDS');

    runningBalance = debited.rows[0].balance;
    await client.query(
      `INSERT INTO financial_ledger (user_id, transaction_type, amount, running_balance, currency, reference_id)
       VALUES ($1, 'BET_PLACE', $2::NUMERIC, $3::NUMERIC, $4, $5)`,
      [uid, amount, runningBalance, requestedCurrency, referenceId],
    );
    await client.query(
      `INSERT INTO operational_bet_outbox (reference_id, user_id, amount, running_balance, currency)
       VALUES ($1, $2, $3::NUMERIC, $4::NUMERIC, $5)`,
      [referenceId, uid, amount, runningBalance, requestedCurrency],
    );
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore rollback errors */ }
    console.error('CRITICAL: secure bet execution rolled back cleanly:', error.message);
    throw error;
  } finally {
    client.release();
  }

  return runOperationalWrite(pool, { referenceId, runningBalance, operationalWrite });
}
