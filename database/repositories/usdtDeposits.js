// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * USDT deposits paid to the platform (owner, 2026-10-18: BSC only, one address
 * per order). The ONE writer of `usdt_deposit_addresses`,
 * `usdt_deposit_transfers`, `usdt_chain_cursors` and `usdt_final_wallets`
 * (schema.sql, "USDT DEPOSITS TO THE PLATFORM").
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
 *
 * ── A merchant's pool buy (owner, 2026-10-21) ───────────────────────────────
 * The same three steps for a BUY `team_pool_requests` row: `openPoolUsdtBuy`
 * writes the request and its own address (`pool_usdt_addresses`, the same
 * index sequence, so no address is shared with an order), the watcher records
 * what arrives (`pool_usdt_transfers`), and `creditPoolUsdtBuyWithin` fulfils
 * the request once it covers the frozen price (`teamPools.fulfilBuyWithin`).
 * The id a sweep line carries is the order's or the request's.
 */
import { pgQuery, withTransaction } from '../client.js';
import { ACCOUNTS, postMovement } from './treasury.js';
import { lockWalletWithin } from './wallets.core.js';
import { creditBuyWithin } from './wallets.js';
import { creditFirstDepositBonusWithin } from './promo.js';
import { claimUtrWithin } from './utr.js';
import { prepareOrderRecord } from './orders.record.js';
import { createRequestWithin, fulfilBuyWithin, PoolRefused } from './teamPools.js';
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

/** Micro-USDT in a frozen price: the tokens at the rate, rounded UP to a hundredth of a USDT. */
export function poolUsdtPriceMicro(tokenAmountPaise, rate) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) throw new Error(`poolUsdtPriceMicro: rate ${rate}`);
  // paise ÷ (₹ per USDT) = hundredths of a USDT.
  return BigInt(Math.ceil(Number(tokenAmountPaise) / r)) * MICRO_PER_HUNDREDTH;
}

/**
 * Open a merchant's pool buy paid in USDT: the BUY request and its own
 * address, the price frozen, in one commit. Refusals of the request are its
 * own (`team_not_found`, `request_pending`) and write nothing.
 */
export async function openPoolUsdtBuy({ teamId, supervisorId, tokenAmountPaise, rate, note = null, keyId, deriveAddress, windowSeconds }) {
  const usdtMicro = poolUsdtPriceMicro(tokenAmountPaise, rate);
  const { rows: seq } = await pgQuery(`SELECT nextval('usdt_deposit_index_seq')::int AS i`, [], 'usdt_pool_next_index');
  const index = seq[0].i;
  const address = String(deriveAddress(index)).toLowerCase();
  return withTransaction(async (client) => {
    const made = await createRequestWithin(client, { teamId, supervisorId, direction: 'BUY', tokenAmountPaise, note });
    if (!made.ok) return made;
    const { rows } = await client.query(
      `INSERT INTO pool_usdt_addresses (request_id, chain, address, key_id, derivation_index, usdt_micro, rate_used, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' seconds')::interval)
       RETURNING expires_at`,
      [made.requestId, USDT_DEPOSIT_CHAIN, address, keyId, index, String(usdtMicro), Number(rate), String(windowSeconds)]);
    return {
      ok: true, requestId: made.requestId, address, chain: USDT_DEPOSIT_CHAIN,
      usdt: Number(usdtMicro) / 1e6, rate: Number(rate), expiresAt: rows[0].expires_at,
    };
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
     UNION ALL
     SELECT p.address, NULL
       FROM pool_usdt_addresses p
       JOIN team_pool_requests r ON r.request_id = p.request_id
      WHERE p.chain = $1
        AND (r.status = 'PENDING' OR r.decided_at > now() - make_interval(hours => $2::int))`,
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

/**
 * A failed read, kept on the cursor so the admin page can say the watcher is
 * stuck. Before the first good read there is no cursor and none is made here:
 * a made-up starting block would send the watcher back to it (block 0 is the
 * chain's start, months of blocks away). Returns whether it was recorded.
 */
export async function recordCursorError({ chain = USDT_DEPOSIT_CHAIN, message }) {
  const { rowCount } = await pgQuery(
    `UPDATE usdt_chain_cursors SET last_error = $2, last_error_at = now(), updated_at = now() WHERE chain = $1`,
    [chain, String(message ?? 'unknown error').slice(0, 500)], 'usdt_cursor_error');
  return rowCount === 1;
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
  if (rows[0]) return { recorded: true, orderId: rows[0].order_id, orderState: rows[0].order_state_at_arrival };
  // Not an order's address: a merchant's pool buy, or nobody's.
  const { rows: pool } = await pgQuery(
    `INSERT INTO pool_usdt_transfers
       (chain, tx_hash, log_index, request_id, from_address, amount_micro, block_number, status_at_arrival)
     SELECT p.chain, $2, $3, p.request_id, $5, $6, $7, r.status
       FROM pool_usdt_addresses p JOIN team_pool_requests r ON r.request_id = p.request_id
      WHERE p.address = $4 AND p.chain = $1
     ON CONFLICT (chain, tx_hash, log_index) DO NOTHING
     RETURNING request_id, status_at_arrival`,
    [USDT_DEPOSIT_CHAIN, String(txHash).toLowerCase(), Number(logIndex), String(to).toLowerCase(),
      String(from).toLowerCase(), String(amountMicro), Number(blockNumber)], 'usdt_pool_transfer_record');
  return pool[0]
    ? { recorded: true, requestId: pool[0].request_id, requestStatus: pool[0].status_at_arrival }
    : { recorded: false };
}

/** Pending pool buys whose address has received something: the watcher credits them. */
export async function pendingPoolBuysWithTransfers() {
  const { rows } = await pgQuery(
    `SELECT DISTINCT t.request_id
       FROM pool_usdt_transfers t
       JOIN team_pool_requests r ON r.request_id = t.request_id
      WHERE r.status = 'PENDING'`, [], 'usdt_pool_pending_with_transfers');
  return rows.map((r) => r.request_id);
}

/**
 * Fulfil a pool buy whose transfers cover its frozen price, in one
 * transaction with the pool, the treasury and the USDT consideration (valued
 * at the frozen rate). Short of the price, nothing moves:
 * `{ credited: false, reason: 'not_covered' }`.
 */
export async function creditPoolUsdtBuy(requestId, { actor = 'usdt-watcher' } = {}) {
  try {
    return await withTransaction((client) => creditPoolUsdtBuyWithin(client, requestId, { actor }));
  } catch (e) {
    if (e instanceof PoolRefused) return { credited: false, reason: e.reason };
    throw e;
  }
}

export async function creditPoolUsdtBuyWithin(client, requestId, { actor = 'usdt-watcher' } = {}) {
  const rid = String(requestId);
  const { rows: r } = await client.query(
    `SELECT r.supervisor_id, r.team_id, r.token_amount_paise, r.status, r.direction, p.usdt_micro, p.rate_used
       FROM team_pool_requests r JOIN pool_usdt_addresses p ON p.request_id = r.request_id
      WHERE r.request_id = $1 FOR UPDATE OF r`, [rid]);
  const req = r[0];
  if (!req) return { credited: false, reason: 'not_found' };
  if (req.status !== 'PENDING' || req.direction !== 'BUY') return { credited: false, reason: 'not_pending' };
  const { rows: sum } = await client.query(
    'SELECT COALESCE(SUM(amount_micro), 0) AS received FROM pool_usdt_transfers WHERE request_id = $1', [rid]);
  const requiredMicro = big(req.usdt_micro);
  const receivedMicro = big(sum[0].received);
  if (receivedMicro < requiredMicro) return { credited: false, reason: 'not_covered', requiredMicro, receivedMicro };
  const done = await fulfilBuyWithin(client, {
    requestId: rid, supervisorId: req.supervisor_id, tokenAmountPaise: Number(req.token_amount_paise), actor,
    consideration: { currency: 'USDT', fiatAmountMinor: Number(requiredMicro / MICRO_PER_HUNDREDTH), rateUsed: Number(req.rate_used) },
  });
  return {
    credited: true, teamId: req.team_id, supervisorId: req.supervisor_id,
    tokenAmountPaise: Number(req.token_amount_paise), pool: done.pool,
    requiredMicro, receivedMicro, excessMicro: receivedMicro - requiredMicro,
  };
}

/** Pending pool buys past their payment window, oldest first (the watcher asks `usdtBuyMayLapse` of each). */
export async function overduePoolBuys() {
  const { rows } = await pgQuery(
    `SELECT p.request_id, p.expires_at FROM pool_usdt_addresses p
       JOIN team_pool_requests r ON r.request_id = p.request_id
      WHERE r.status = 'PENDING' AND p.expires_at < now()
      ORDER BY p.expires_at`, [], 'usdt_pool_overdue');
  return rows.map((x) => ({ requestId: x.request_id, expiresAt: x.expires_at }));
}

/**
 * A pool buy whose window ended unpaid is cancelled; one paid short stays for
 * an admin (it shows as needing attention), never cancelled under its money.
 */
export async function lapsePoolUsdtBuy(requestId) {
  const { rowCount } = await pgQuery(
    `UPDATE team_pool_requests r
        SET status = 'CANCELLED', decided_by = 'usdt-watcher', decided_at = now(),
            decision_note = 'The USDT payment window ended with nothing received.'
       FROM pool_usdt_addresses p
      WHERE r.request_id = $1 AND p.request_id = r.request_id AND r.status = 'PENDING' AND p.expires_at < now()
        AND NOT EXISTS (SELECT 1 FROM pool_usdt_transfers t WHERE t.request_id = r.request_id)`,
    [String(requestId)], 'usdt_pool_lapse');
  return rowCount === 1;
}

/** A transfer's payment reference in `utr_registry`: its transaction hash and log index. */
export const paymentReferenceOf = (t) => `${String(t.tx_hash ?? t.txHash).toLowerCase()}:${Number(t.log_index ?? t.logIndex)}`;

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
  // reference per order, so the FIRST transfer is the one claimed, named by its
  // hash AND log index (`paymentReferenceOf`): one transaction may pay several
  // orders (an exchange's batch payout), each by its own log, and the hash
  // alone would refuse every order after the first. Each log already belongs
  // to exactly one order through the primary key of `usdt_deposit_transfers`.
  const reference = paymentReferenceOf(transfers[0]);
  const claimed = await claimUtrWithin(client, { utr: reference, orderId: oid, userId: o[0].user_id });
  if (!claimed.ok) {
    throw new UsdtCreditRefused('reference_taken', { reference, heldBy: claimed.entry?.orderId ?? null });
  }

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

/**
 * Every merchant pool buy paid in USDT, newest first, with what arrived and
 * why it needs a person, if it does: LATE (money at a request no longer
 * waiting, other than the fulfilled one's price), SHORT (its window ended with
 * less than the price), OVERPAID (fulfilled with more than the price).
 */
export async function listPoolDeposits({ limit = 100 } = {}) {
  const { rows } = await pgQuery(
    `SELECT x.*, CASE
         WHEN x.status IN ('CANCELLED', 'REJECTED') AND x.open_micro > 0 THEN 'LATE'
         WHEN x.status = 'PENDING' AND x.expires_at < now() AND x.open_micro > 0 THEN 'SHORT'
         WHEN x.status = 'FULFILLED' AND x.open_micro > 0 AND x.received_micro > x.usdt_micro THEN 'OVERPAID'
         ELSE NULL END AS attention
       FROM (
         SELECT p.request_id, p.address, p.usdt_micro, p.rate_used, p.expires_at, p.created_at,
                p.swept_at, p.swept_tx_hash, r.status, r.token_amount_paise, r.team_id, t.name AS team_name,
                m.name AS requester_name,
                COALESCE(SUM(tr.amount_micro), 0) AS received_micro,
                COALESCE(SUM(tr.amount_micro) FILTER (WHERE tr.handled_at IS NULL), 0) AS open_micro,
                COUNT(tr.tx_hash)::int AS transfers
           FROM pool_usdt_addresses p
           JOIN team_pool_requests r ON r.request_id = p.request_id
           JOIN teams t ON t.team_id = r.team_id
           JOIN merchants m ON m.merchant_id = r.supervisor_id
           LEFT JOIN pool_usdt_transfers tr ON tr.request_id = p.request_id
          GROUP BY p.request_id, r.request_id, t.name, m.name) x
      ORDER BY x.created_at DESC LIMIT $1`,
    [Math.max(1, Math.min(Number(limit) || 100, 1000))], 'usdt_pool_deposits_list');
  return rows.map((r) => ({
    requestId: r.request_id, teamId: r.team_id, teamName: r.team_name, requesterName: r.requester_name,
    address: r.address, status: r.status, tokens: paiseToRupees(Number(r.token_amount_paise)),
    usdtRequired: Number(r.usdt_micro) / 1e6, usdtReceived: Number(r.received_micro) / 1e6,
    rate: Number(r.rate_used), expiresAt: r.expires_at, createdAt: r.created_at,
    transfers: r.transfers, attention: r.attention, sweptAt: r.swept_at, sweptTxHash: r.swept_tx_hash,
  }));
}

/** The transfers that arrived at one order's address, or one pool buy's (by its request id). */
export async function transfersFor(orderId) {
  const { rows } = await pgQuery(
    `SELECT tx_hash, log_index, from_address, amount_micro, block_number, order_state_at_arrival,
            seen_at, handled_at, handled_by, handled_note
       FROM usdt_deposit_transfers WHERE order_id = $1
     UNION ALL
     SELECT tx_hash, log_index, from_address, amount_micro, block_number, status_at_arrival,
            seen_at, handled_at, handled_by, handled_note
       FROM pool_usdt_transfers WHERE request_id = $1
     ORDER BY block_number, log_index`,
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
  if (rows.length) return { marked: rows.length };
  // A pool buy's: once it is no longer waiting, or still waiting past its window.
  const { rows: pool } = await pgQuery(
    `UPDATE pool_usdt_transfers t
        SET handled_at = now(), handled_by = $2, handled_note = $3
       FROM team_pool_requests r, pool_usdt_addresses p
      WHERE t.request_id = $1 AND r.request_id = t.request_id AND p.request_id = t.request_id
        AND t.handled_at IS NULL AND (r.status <> 'PENDING' OR p.expires_at < now())
      RETURNING t.tx_hash`,
    [String(orderId), String(actor), text], 'usdt_pool_mark_handled');
  return { marked: pool.length };
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
  if (rows.length === 1) return { ok: true };
  const { rows: pool } = await pgQuery(
    `UPDATE pool_usdt_addresses p
        SET swept_at = now(), swept_tx_hash = $2, swept_by = $3
       FROM team_pool_requests r
      WHERE p.request_id = $1 AND r.request_id = p.request_id AND p.swept_at IS NULL
        AND r.status <> 'PENDING'
        AND EXISTS (SELECT 1 FROM pool_usdt_transfers t WHERE t.request_id = p.request_id)
      RETURNING p.request_id`,
    [String(orderId), hash, String(actor)], 'usdt_pool_record_sweep');
  return { ok: pool.length === 1 };
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
                      WHERE s.swept_at IS NULL), 0)
            + COALESCE((SELECT SUM(t.amount_micro) FROM pool_usdt_transfers t
                       JOIN pool_usdt_addresses s ON s.request_id = t.request_id
                      WHERE s.swept_at IS NULL), 0) AS unswept_micro,
            COALESCE((SELECT SUM(amount_micro) FROM pool_usdt_transfers), 0) AS pool_received_micro
       FROM usdt_deposit_addresses a JOIN order_states o ON o.order_id = a.order_id`,
    [], 'usdt_deposit_totals');
  const r = rows[0];
  return {
    waiting: r.waiting, credited: r.credited,
    creditedTokens: paiseToRupees(Number(r.credited_tokens_paise)),
    usdtReceived: Number(r.received_micro) / 1e6,
    // Every address's coins, players' and merchants' pool buys alike: what a sweep would move.
    usdtUnswept: Number(r.unswept_micro) / 1e6,
    poolUsdtReceived: Number(r.pool_received_micro) / 1e6,
  };
}

/**
 * What the offline sweep tool moves out (scripts/usdt-sweep.mjs): every address
 * whose order has ended, holding coins not yet recorded as swept. An open order
 * is left alone, so a sweep never races the credit. Oldest first.
 */
export async function sweepCandidates() {
  const { rows } = await pgQuery(
    `SELECT a.order_id, o.usdt_pay_address AS address, a.key_id, a.derivation_index, o.state,
            COALESCE((SELECT SUM(t.amount_micro) FROM usdt_deposit_transfers t WHERE t.order_id = a.order_id), 0) AS received_micro,
            a.created_at
       FROM usdt_deposit_addresses a JOIN order_states o ON o.order_id = a.order_id
      WHERE a.swept_at IS NULL AND o.state NOT IN ('PENDING_QUEUE', 'PROCESSING')
        AND EXISTS (SELECT 1 FROM usdt_deposit_transfers t WHERE t.order_id = a.order_id)
     UNION ALL
     -- A merchant's pool buy, once it is no longer waiting: its request id
     -- stands where an order id does, and the sweep is recorded against it.
     SELECT p.request_id, p.address, p.key_id, p.derivation_index, r.status,
            (SELECT SUM(t.amount_micro) FROM pool_usdt_transfers t WHERE t.request_id = p.request_id), p.created_at
       FROM pool_usdt_addresses p JOIN team_pool_requests r ON r.request_id = p.request_id
      WHERE p.swept_at IS NULL AND r.status <> 'PENDING'
        AND EXISTS (SELECT 1 FROM pool_usdt_transfers t WHERE t.request_id = p.request_id)
      ORDER BY created_at, order_id`,
    [], 'usdt_sweep_candidates');
  return rows.map((r) => ({
    orderId: r.order_id, address: r.address, keyId: r.key_id, derivationIndex: r.derivation_index,
    state: r.state, usdtReceived: Number(r.received_micro) / 1e6,
  }));
}

// ── The final wallet ─────────────────────────────────────────────────────────

/** A BSC address as typed: 0x and 40 hexadecimal characters, any case. */
export const FINAL_WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

const toFinalWallet = (r) => (r ? { address: r.address, setBy: r.set_by, setAt: r.set_at } : null);

/** The wallet swept USDT goes to now (the newest row), or null when none is set. */
export async function finalWallet() {
  const { rows } = await pgQuery(
    'SELECT address, set_by, set_at FROM usdt_final_wallets ORDER BY id DESC LIMIT 1', [], 'usdt_final_wallet');
  return toFinalWallet(rows[0]);
}

/** Every final wallet ever set, newest first: who changed it and when. */
export async function finalWalletHistory({ limit = 20 } = {}) {
  const { rows } = await pgQuery(
    'SELECT address, set_by, set_at FROM usdt_final_wallets ORDER BY id DESC LIMIT $1',
    [Math.max(1, Math.min(Number(limit) || 20, 100))], 'usdt_final_wallet_history');
  return rows.map(toFinalWallet);
}

/**
 * Set the owner's wallet the sweep sends to. A new row, never an edit, so the
 * history stays. Saving the address already in use writes nothing.
 * @returns {Promise<{changed: boolean, wallet: object}>}
 */
export async function setFinalWallet({ address, actor }) {
  const text = String(address ?? '').trim();
  if (!FINAL_WALLET_RE.test(text) || /^0x0{40}$/i.test(text)) {
    throw Object.assign(new Error('Enter your BEP-20 wallet address: 0x followed by 40 letters and numbers (0-9, a-f).'),
      { status: 400, code: 'INVALID_FINAL_WALLET' });
  }
  const lower = text.toLowerCase();
  return withTransaction(async (client) => {
    // One change at a time, so two admins saving at once cannot both think theirs is current.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('usdt_final_wallet'))");
    const { rows: [now] } = await client.query(
      'SELECT address, set_by, set_at FROM usdt_final_wallets ORDER BY id DESC LIMIT 1');
    if (now?.address === lower) return { changed: false, wallet: toFinalWallet(now) };
    const { rows: [row] } = await client.query(
      'INSERT INTO usdt_final_wallets (address, set_by) VALUES ($1, $2) RETURNING address, set_by, set_at',
      [lower, String(actor)]);
    return { changed: true, wallet: toFinalWallet(row) };
  });
}
