// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * USDT deposits paid to the platform (owner, 2026-10-18: BSC only, one address
 * per order). The ONE writer of `usdt_deposit_addresses`,
 * `usdt_deposit_transfers` and `usdt_chain_cursors` (schema.sql, "USDT
 * DEPOSITS TO THE PLATFORM").
 *
 * ── The life of a USDT buy ──────────────────────────────────────────────────
 * 1. `openUsdtBuy`: the order and the address derived for it alone are written
 *    in ONE transaction, the order already started (PROCESSING) with its
 *    payment window. No merchant and no team: the platform is the seller.
 * 2. The watcher (`backend/domains/payment/usdtDeposit.service.js`) reads the
 *    chain and `recordTransfer`s every USDT transfer arriving at a watched
 *    address. The address names the order, so there is nothing to guess.
 * 3. `creditUsdtBuyWithin` runs inside the order's COMPLETED transition, under
 *    its lock: when the transfers to its address cover the order's USDT, the
 *    player is credited the order's tokens out of the platform's own holding
 *    (TOKEN_SUPPLY → USER_FLOAT), each transfer's hash is claimed in
 *    `utr_registry` (§27), and the first deposit bonus is asked, all in that
 *    one commit. Short of the amount, it throws and nothing moves.
 *
 * Money arriving at an order that can no longer take it (expired, cancelled,
 * or already completed) is recorded all the same and shown to an admin as
 * needing attention (`listDeposits`), never credited by the server.
 */
import { pgQuery, withTransaction } from '../client.js';
import { ACCOUNTS, postMovement } from './treasury.js';
import { lockWalletWithin } from './wallets.core.js';
import { creditBuyWithin } from './wallets.js';
import { creditFirstDepositBonusWithin } from './promo.js';
import { claimUtrWithin } from './utr.js';
import { prepareOrderRecord } from './orders.record.js';
import { paiseToRupees } from '../../backend/shared/money.js';

export const USDT_DEPOSIT_CHAIN = 'BEP20';
/** Micro-USDT in one hundredth of a USDT (the unit of `fiat_amount_paise` on a USDT order). */
const MICRO_PER_HUNDREDTH = 10_000n;

/** A refusal inside the crediting transaction; the transition unwinds with it. */
export class UsdtCreditRefused extends Error {
  constructor(reason, detail = {}) { super(reason); this.reason = reason; this.detail = detail; }
}

const big = (v) => BigInt(v ?? 0);

/**
 * Open a USDT buy: the order (started, PROCESSING, expiring after
 * `windowSeconds`) and its own address, in one commit.
 *
 * `deriveAddress(index)` turns the next derivation index into the address;
 * it is the caller's (the chain module holds the key). A gap in the indexes
 * (a refused insert) leaves an address nobody was shown, which is harmless.
 */
export async function openUsdtBuy({ orderInput, keyId, deriveAddress, windowSeconds }) {
  // A sequence value is never rolled back, so it is taken outside the
  // transaction: a refused insert leaves a gap, never a reused index.
  const { rows: seq } = await pgQuery(`SELECT nextval('usdt_deposit_index_seq')::int AS i`, [], 'usdt_next_index');
  const index = seq[0].i;
  const address = String(deriveAddress(index)).toLowerCase();
  const insertOrder = await prepareOrderRecord({
    ...orderInput, state: 'PROCESSING', usdtChain: USDT_DEPOSIT_CHAIN, usdtPayAddress: address,
    processingAt: new Date(), expiresAt: new Date(Date.now() + windowSeconds * 1000),
  });
  return withTransaction(async (client) => {
    const order = await insertOrder(client);
    await client.query(
      `INSERT INTO usdt_deposit_addresses (order_id, chain, key_id, derivation_index)
       VALUES ($1, $2, $3, $4)`,
      [order.orderId, USDT_DEPOSIT_CHAIN, keyId, index]);
    return { order, address, derivationIndex: index };
  });
}

/** The address an order is paid to, and what has arrived at it. Null for an order with none. */
export async function depositFor(orderId) {
  const { rows } = await pgQuery(
    `SELECT a.order_id, o.usdt_pay_address AS address, a.chain, a.key_id, a.derivation_index, a.swept_at,
            COALESCE(SUM(t.amount_micro), 0) AS received_micro,
            COUNT(t.tx_hash)::int AS transfers
       FROM usdt_deposit_addresses a
       JOIN order_states o ON o.order_id = a.order_id
       LEFT JOIN usdt_deposit_transfers t ON t.order_id = a.order_id
      WHERE a.order_id = $1
      GROUP BY a.order_id, o.usdt_pay_address, a.chain, a.key_id, a.derivation_index, a.swept_at`, [String(orderId)], 'usdt_deposit_for');
  const r = rows[0];
  return r ? {
    orderId: r.order_id, address: r.address, chain: r.chain,
    keyId: r.key_id, derivationIndex: r.derivation_index,
    receivedMicro: Number(r.received_micro), transfers: r.transfers, sweptAt: r.swept_at,
  } : null;
}

/**
 * The addresses the watcher reads the chain for: every order still open, and
 * every order that ended in the last `lateWatchHours` (a payment sent late is
 * still recorded, for an admin).
 */
export async function watchedAddresses({ lateWatchHours }) {
  const { rows } = await pgQuery(
    `SELECT o.usdt_pay_address AS address, a.order_id
       FROM usdt_deposit_addresses a
       JOIN order_states o ON o.order_id = a.order_id
      WHERE a.chain = $1
        AND (o.state IN ('PENDING_QUEUE', 'PROCESSING')
             OR o.updated_at > now() - make_interval(hours => $2::int))
      ORDER BY a.created_at`,
    [USDT_DEPOSIT_CHAIN, Math.max(1, Number(lateWatchHours) || 1)], 'usdt_watched_addresses');
  return rows.map((r) => ({ address: r.address, orderId: r.order_id }));
}

/** Open orders whose address has received something: the watcher retries their credit. */
export async function processingOrdersWithTransfers() {
  const { rows } = await pgQuery(
    `SELECT DISTINCT t.order_id
       FROM usdt_deposit_transfers t
       JOIN order_states o ON o.order_id = t.order_id
      WHERE o.state = 'PROCESSING'`, [], 'usdt_processing_with_transfers');
  return rows.map((r) => r.order_id);
}

/** The watcher's place on the chain. Null before its first read. */
export async function readCursor(chain = USDT_DEPOSIT_CHAIN) {
  const { rows } = await pgQuery(
    `SELECT chain, next_block, head_block, last_ok_at, last_error, last_error_at, updated_at
       FROM usdt_chain_cursors WHERE chain = $1`, [chain], 'usdt_cursor_read');
  const r = rows[0];
  return r ? {
    chain: r.chain, nextBlock: Number(r.next_block), headBlock: r.head_block === null ? null : Number(r.head_block),
    lastOkAt: r.last_ok_at, lastError: r.last_error, lastErrorAt: r.last_error_at, updatedAt: r.updated_at,
  } : null;
}

/**
 * Move the cursor to `nextBlock`, only forwards (a second instance that read
 * the same range moves nothing back).
 */
export async function advanceCursor({ chain = USDT_DEPOSIT_CHAIN, nextBlock, headBlock }) {
  await pgQuery(
    `INSERT INTO usdt_chain_cursors (chain, next_block, head_block, last_ok_at, updated_at)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (chain) DO UPDATE
        SET next_block = GREATEST(usdt_chain_cursors.next_block, EXCLUDED.next_block),
            head_block = EXCLUDED.head_block, last_ok_at = now(), updated_at = now()`,
    [chain, nextBlock, headBlock], 'usdt_cursor_advance');
}

/** A failed read, kept on the cursor so the admin page can say the watcher is stuck. */
export async function recordCursorError({ chain = USDT_DEPOSIT_CHAIN, message, startBlock = 0 }) {
  await pgQuery(
    `INSERT INTO usdt_chain_cursors (chain, next_block, last_error, last_error_at, updated_at)
     VALUES ($1, $3, $2, now(), now())
     ON CONFLICT (chain) DO UPDATE SET last_error = EXCLUDED.last_error, last_error_at = now(), updated_at = now()`,
    [chain, String(message ?? 'unknown error').slice(0, 500), startBlock], 'usdt_cursor_error');
}

/**
 * Record one transfer seen on chain. Once per (hash, log index): a second
 * sighting is a no-op. The address names the order; a transfer to an address
 * that is not ours is ignored (`recorded: false`).
 *
 * @returns {{recorded: boolean, orderId?: string, orderState?: string}}
 */
export async function recordTransfer({ txHash, logIndex, to, from, amountMicro, blockNumber }) {
  const { rows } = await pgQuery(
    `INSERT INTO usdt_deposit_transfers
       (chain, tx_hash, log_index, order_id, from_address, amount_micro, block_number, order_state_at_arrival)
     SELECT a.chain, $2, $3, a.order_id, $5, $6, $7, o.state
       FROM order_states o JOIN usdt_deposit_addresses a ON a.order_id = o.order_id
      WHERE o.usdt_pay_address = $4 AND a.chain = $1
     ON CONFLICT (chain, tx_hash, log_index) DO NOTHING
     RETURNING order_id, order_state_at_arrival`,
    [USDT_DEPOSIT_CHAIN, String(txHash).toLowerCase(), Number(logIndex), String(to).toLowerCase(),
      String(from).toLowerCase(), String(amountMicro), Number(blockNumber)], 'usdt_transfer_record');
  return rows[0]
    ? { recorded: true, orderId: rows[0].order_id, orderState: rows[0].order_state_at_arrival }
    : { recorded: false };
}

/**
 * The credit for a USDT buy, inside its COMPLETED transition (the order row is
 * locked by it). Throws `UsdtCreditRefused` — unwinding the transition — when
 * the transfers do not cover the order, or anything refuses; otherwise returns
 * what moved.
 *
 * Locks, in order: the order (the transition's), the player's wallet, the
 * treasury — the same order every buy completion takes.
 */
export async function creditUsdtBuyWithin(client, orderId, { actor = 'usdt-watcher' } = {}) {
  const oid = String(orderId);
  const { rows: o } = await client.query(
    `SELECT user_id, order_type, currency, fiat_amount_paise, token_amount_paise,
            deposit_allocation_paise, reserve_allocation_paise, pool_paid_at
       FROM order_states WHERE order_id = $1`, [oid]);
  if (!o[0]) throw new UsdtCreditRefused('not_found');
  if (o[0].order_type !== 'DEPOSIT' || o[0].currency !== 'USDT') throw new UsdtCreditRefused('not_a_usdt_buy');
  if (o[0].pool_paid_at) throw new UsdtCreditRefused('already_credited');

  const { rows: transfers } = await client.query(
    `SELECT tx_hash, log_index, amount_micro FROM usdt_deposit_transfers WHERE order_id = $1 ORDER BY block_number, log_index`,
    [oid]);
  const requiredMicro = big(o[0].fiat_amount_paise) * MICRO_PER_HUNDREDTH;
  const receivedMicro = transfers.reduce((s, t) => s + big(t.amount_micro), 0n);
  if (receivedMicro < requiredMicro) {
    throw new UsdtCreditRefused('not_covered', { requiredMicro, receivedMicro });
  }

  const amount = Number(o[0].token_amount_paise);
  // The marker every buy completion stamps: the tokens are out, the order may
  // only be COMPLETED, and the first deposit bonus counts this buy as paid.
  await client.query('UPDATE order_states SET pool_paid_at = now() WHERE order_id = $1', [oid]);

  // The order's reference, once, for good (§27). The registry holds one
  // reference per order, so the FIRST transfer's hash is the one claimed; every
  // transfer (each log) already belongs to exactly one order through the
  // primary key of `usdt_deposit_transfers`. A hash another order claimed is
  // refused, not credited twice.
  const hash = transfers[0].tx_hash;
  const claimed = await claimUtrWithin(client, { utr: hash, orderId: oid, userId: o[0].user_id });
  if (!claimed.ok) throw new UsdtCreditRefused('reference_taken', { txHash: hash, heldBy: claimed.entry?.orderId ?? null });

  const wallet = await lockWalletWithin(client, o[0].user_id);
  const credited = await creditBuyWithin(wallet, {
    orderId: oid, amountPaise: amount,
    depositAllocationPaise: Number(o[0].deposit_allocation_paise ?? 0),
    reserveAllocationPaise: Number(o[0].reserve_allocation_paise ?? 0),
  });
  if (credited.idempotent) throw new UsdtCreditRefused('already_credited');
  if (!credited.ok) throw new UsdtCreditRefused(credited.refused ?? 'credit_refused');
  const moved = await postMovement({
    client, movementId: `usdt_buy_${oid}`, operation: 'USDT_BUY_PAID',
    legs: { [ACCOUNTS.TOKEN_SUPPLY]: -amount, [ACCOUNTS.USER_FLOAT]: amount },
    actor: String(actor), refModel: 'PaymentOrder', refId: oid, reason: 'Platform sold tokens for USDT received on chain',
  });
  if (!moved.ok) throw new UsdtCreditRefused(moved.reason ?? 'treasury_refused');
  if (moved.idempotent) throw new UsdtCreditRefused('already_credited');

  const bonus = await creditFirstDepositBonusWithin(wallet, { orderId: oid });
  return {
    userId: String(o[0].user_id), amountPaise: amount,
    requiredMicro, receivedMicro, excessMicro: receivedMicro - requiredMicro,
    balances: bonus.balancesAfterPaise ?? credited.balancesAfterPaise,
    firstDepositBonus: bonus,
  };
}

// ── The admin's view ────────────────────────────────────────────────────────

/** What the admin's list can be narrowed to. */
export const DEPOSIT_FILTERS = Object.freeze(['ALL', 'WAITING', 'ATTENTION', 'UNSWEPT']);

/**
 * Why a deposit needs a person, from its own rows, or null:
 *   LATE       money arrived and the order can no longer take it (expired,
 *              cancelled, failed)
 *   OVERPAID   completed with more than the order's USDT
 *   AFTER_CREDIT  a further transfer arrived after the order completed
 * A transfer an admin marked handled no longer counts.
 */
const ATTENTION_SQL = `CASE
    WHEN s.state IN ('CANCELLED', 'FAILED', 'REJECTED') AND s.open_micro > 0 THEN 'LATE'
    WHEN s.state = 'COMPLETED' AND s.open_after_credit > 0 THEN 'AFTER_CREDIT'
    WHEN s.state = 'COMPLETED' AND s.open_micro > 0 AND s.received_micro > s.fiat_amount_paise * 10000 THEN 'OVERPAID'
    ELSE NULL END`;

const DEPOSITS_SQL = `
  SELECT a.order_id, o.usdt_pay_address AS address, a.derivation_index, a.key_id, a.created_at,
         a.swept_at, a.swept_tx_hash, a.swept_by,
         o.user_id, o.state, o.fiat_amount_paise, o.token_amount_paise, o.expires_at, o.pool_paid_at,
         u.username,
         d.received_micro, d.transfers, d.open_micro, d.open_after_credit, d.last_seen_at
    FROM usdt_deposit_addresses a
    JOIN order_states o ON o.order_id = a.order_id
    LEFT JOIN users u ON u.user_id = o.user_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(SUM(t.amount_micro), 0) AS received_micro,
             COUNT(*)::int AS transfers,
             COALESCE(SUM(t.amount_micro) FILTER (WHERE t.handled_at IS NULL), 0) AS open_micro,
             COUNT(*) FILTER (WHERE t.handled_at IS NULL AND t.order_state_at_arrival = 'COMPLETED')::int AS open_after_credit,
             MAX(t.seen_at) AS last_seen_at
        FROM usdt_deposit_transfers t WHERE t.order_id = a.order_id) d`;

function toDeposit(r) {
  const required = Number(r.fiat_amount_paise) * 10000;
  return {
    orderId: r.order_id, userId: r.user_id, username: r.username ?? null,
    address: r.address, derivationIndex: r.derivation_index, keyId: r.key_id,
    state: r.state, createdAt: r.created_at, expiresAt: r.expires_at, creditedAt: r.pool_paid_at,
    usdtRequired: required / 1e6, usdtReceived: Number(r.received_micro) / 1e6,
    receivedMicro: Number(r.received_micro), requiredMicro: required,
    tokens: paiseToRupees(Number(r.token_amount_paise)),
    transfers: r.transfers, lastSeenAt: r.last_seen_at,
    attention: r.attention ?? null,
    sweptAt: r.swept_at, sweptTxHash: r.swept_tx_hash, sweptBy: r.swept_by,
  };
}

/**
 * Every USDT deposit address with what arrived at it, newest first.
 * `filter`: WAITING (still open), ATTENTION (needs a person), UNSWEPT (has
 * coins and is not recorded as swept), ALL.
 */
export async function listDeposits({ filter = 'ALL', limit = 100, offset = 0 } = {}) {
  if (!DEPOSIT_FILTERS.includes(filter)) {
    throw Object.assign(new Error(`Unknown filter '${filter}'. Known: ${DEPOSIT_FILTERS.join(', ')}.`),
      { status: 400, code: 'UNKNOWN_DEPOSIT_FILTER' });
  }
  const where = {
    ALL: 'TRUE',
    WAITING: `x.state IN ('PENDING_QUEUE', 'PROCESSING')`,
    ATTENTION: 'x.attention IS NOT NULL',
    UNSWEPT: 'x.swept_at IS NULL AND x.received_micro > 0',
  }[filter];
  const lim = Math.max(1, Math.min(Number(limit) || 100, 5000));
  const off = Math.max(0, Number(offset) || 0);
  const { rows } = await pgQuery(
    `SELECT x.*, COUNT(*) OVER () AS total FROM (
       SELECT s.*, ${ATTENTION_SQL} AS attention
         FROM (${DEPOSITS_SQL}) s) x
      WHERE ${where}
      ORDER BY x.created_at DESC, x.order_id DESC
      LIMIT $1 OFFSET $2`, [lim, off], 'usdt_deposits_list');
  return { total: rows[0] ? Number(rows[0].total) : 0, rows: rows.map(toDeposit) };
}

/** The transfers that arrived at one order's address. */
export async function transfersFor(orderId) {
  const { rows } = await pgQuery(
    `SELECT tx_hash, log_index, from_address, amount_micro, block_number, order_state_at_arrival,
            seen_at, handled_at, handled_by, handled_note
       FROM usdt_deposit_transfers WHERE order_id = $1 ORDER BY block_number, log_index`,
    [String(orderId)], 'usdt_transfers_for');
  return rows.map((r) => ({
    txHash: r.tx_hash, logIndex: r.log_index, from: r.from_address,
    usdt: Number(r.amount_micro) / 1e6, blockNumber: Number(r.block_number),
    orderStateAtArrival: r.order_state_at_arrival, seenAt: r.seen_at,
    handledAt: r.handled_at, handledBy: r.handled_by, handledNote: r.handled_note,
  }));
}

/**
 * An admin says the money on this order that the server could not credit was
 * dealt with (refunded, or credited by an adjustment), with a note. Marks
 * every unhandled transfer on the order, once. Refused on an order still open.
 */
export async function markHandled(orderId, { actor, note }) {
  const text = String(note ?? '').trim();
  if (!text || text.length > 500) {
    throw Object.assign(new Error('Write what was done, in 1 to 500 characters.'), { status: 400, code: 'NOTE_REQUIRED' });
  }
  const { rows } = await pgQuery(
    `UPDATE usdt_deposit_transfers t
        SET handled_at = now(), handled_by = $2, handled_note = $3
       FROM order_states o
      WHERE t.order_id = $1 AND o.order_id = t.order_id
        AND t.handled_at IS NULL AND o.state NOT IN ('PENDING_QUEUE', 'PROCESSING')
      RETURNING t.tx_hash`,
    [String(orderId), String(actor), text], 'usdt_mark_handled');
  return { marked: rows.length };
}

/**
 * Record that an address's coins were swept out (the sweep tool's transaction),
 * once. Refused while the order is still open, or with nothing received.
 */
export async function recordSweep(orderId, { actor, txHash }) {
  const hash = String(txHash ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) {
    throw Object.assign(new Error('Enter the sweep transaction hash: 0x followed by 64 hexadecimal characters.'),
      { status: 400, code: 'INVALID_SWEEP_HASH' });
  }
  const { rows } = await pgQuery(
    `UPDATE usdt_deposit_addresses a
        SET swept_at = now(), swept_tx_hash = $2, swept_by = $3
       FROM order_states o
      WHERE a.order_id = $1 AND o.order_id = a.order_id AND a.swept_at IS NULL
        AND o.state NOT IN ('PENDING_QUEUE', 'PROCESSING')
        AND EXISTS (SELECT 1 FROM usdt_deposit_transfers t WHERE t.order_id = a.order_id)
      RETURNING a.order_id`,
    [String(orderId), hash, String(actor)], 'usdt_record_sweep');
  return { ok: rows.length === 1 };
}

/** Totals for the admin's header and the token ledger's cash check, in the order's own units. */
export async function depositTotals() {
  const { rows } = await pgQuery(
    `SELECT COUNT(*) FILTER (WHERE o.state = 'PROCESSING')::int AS waiting,
            COUNT(*) FILTER (WHERE o.state = 'COMPLETED')::int AS credited,
            COALESCE(SUM(o.token_amount_paise) FILTER (WHERE o.state = 'COMPLETED'), 0) AS credited_tokens_paise,
            COALESCE((SELECT SUM(amount_micro) FROM usdt_deposit_transfers), 0) AS received_micro,
            COALESCE((SELECT SUM(t.amount_micro) FROM usdt_deposit_transfers t
                       JOIN usdt_deposit_addresses s ON s.order_id = t.order_id
                      WHERE s.swept_at IS NULL), 0) AS unswept_micro
       FROM usdt_deposit_addresses a JOIN order_states o ON o.order_id = a.order_id`,
    [], 'usdt_deposit_totals');
  const r = rows[0];
  return {
    waiting: r.waiting, credited: r.credited,
    creditedTokens: paiseToRupees(Number(r.credited_tokens_paise)),
    usdtReceived: Number(r.received_micro) / 1e6,
    usdtUnswept: Number(r.unswept_micro) / 1e6,
  };
}
