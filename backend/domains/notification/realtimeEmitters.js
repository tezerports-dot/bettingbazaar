// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)


// The wallet is the only place a balance is read from. See sseBalancePush.
import { getBalances } from '#db/repositories/wallets.js';
import { encodeCyclePhase, encodeCycleResult } from './realtimeProtocol.js';
import { recordRealtimeEvent } from '../../services/metrics.service.js';

// ─── PUBLIC CYCLE LIFECYCLE ───────────────────────────────────────────────────
/**
 * The one way `cycle_phase` and `cycle_result` are sent, by the engine and by
 * the admin cycle actions alike: encoded in the compact v2 format
 * (`realtimeProtocol.js`) and broadcast on BOTH public transports — SSE for
 * every player, socket.io for connected sockets. The admin actions used to
 * reach socket.io only, so a player on SSE never heard a pause or a cancel.
 *
 * Public by design: these carry no per-user data. Anything per user goes to
 * the `user-<id>` room (below); per-cycle pools go to `cycle:<id>`.
 */
function broadcastPublic(event, payload, { io = global.io, sseManager = global.sseManager } = {}) {
  recordRealtimeEvent(event, payload);
  try { sseManager?.broadcast?.(event, payload); } catch (err) {
    console.warn(`[realtimeEmitters] ${event} SSE broadcast error:`, err.message);
  }
  try { io?.emit?.(event, payload); } catch (err) {
    console.warn(`[realtimeEmitters] ${event} socket broadcast error:`, err.message);
  }
  return payload;
}

/** @param {{cycleId, type?, audience?, phase, at?}} fields  @param {{io?, sseManager?}} [transports] */
export function emitCyclePhase(fields, transports) {
  return broadcastPublic('cycle_phase', encodeCyclePhase(fields), transports);
}

/** @param {{cycleId, type?, audience?, winner, delhiPool?, bombayPool?, forced?, at?}} fields */
export function emitCycleResult(fields, transports) {
  return broadcastPublic('cycle_result', encodeCycleResult(fields), transports);
}

// ─── ONE PLAYER ───────────────────────────────────────────────────────────────
/**
 * The one way a push addressed to ONE player is sent: down that player's own
 * SSE channel (`GET /api/sse/player/events`, `sseManager.sendToUser`), which
 * the Redis relay carries to whichever instance holds their stream.
 *
 * The player app opens no socket (2026-10-10): its live connection is that one
 * stream, so the `user-<id>` socket room this replaced has no member and an
 * emit to it reaches nobody. Every per-player event — `user_balance_update`,
 * `user_update`, `payout_success`, `order_update`, `support_reply`,
 * `chat_banned` — goes through here, under the one name the panel listens for
 * (§12), so no call site picks a transport of its own.
 *
 * Best-effort: a push follows a committed write and must never throw into it.
 */
export function emitToPlayer(userId, event, data) {
  try {
    global.sseManager?.sendToUser?.(String(userId), event, data);
  } catch (err) {
    console.warn(`[realtimeEmitters] ${event} player push error:`, err.message);
  }
}

// ─── WALLET UPDATE ─────────────────────────────────────────────────────────────
/**
 * emitWalletUpdate — Push current wallet balances to a user via SSE.
 * Called after any atomic balance mutation (approve, bet, refund).
 *
 * @param {string|ObjectId} userId
 * @param {object} [balanceOverride] — if provided, skip DB fetch and use these values
 */
export async function emitWalletUpdate(userId, balanceOverride = null) {
  try {
    let payload;
    if (balanceOverride) {
      payload = {
        depositBalance:  balanceOverride.depositBalance  ?? 0,
        winningsBalance: balanceOverride.winningsBalance ?? 0,
        reserveBalance:  balanceOverride.reserveBalance  ?? 0,
        lockedBalance:   balanceOverride.lockedBalance   ?? 0,
        walletBalance:   (balanceOverride.depositBalance ?? 0) + (balanceOverride.winningsBalance ?? 0),
        timestamp: Date.now(),
      };
    } else {
      // From the WALLET. The accounts table has no balance columns — they live
      // in `wallets`, behind the row lock every movement takes — so reading
      // them off an account object returns undefined for all four and pushes
      // ZERO to a player whose money is fine.
      const fresh = await getBalances(String(userId));
      if (!fresh) return;
      payload = {
        depositBalance:  fresh.depositBalance  || 0,
        winningsBalance: fresh.winningsBalance || 0,
        reserveBalance:  fresh.reserveBalance  || 0,
        lockedBalance:   fresh.lockedBalance   || 0,
        walletBalance:   (fresh.depositBalance || 0) + (fresh.winningsBalance || 0),
        timestamp: Date.now(),
      };
    }

    emitToPlayer(userId, 'user_balance_update', payload);
  } catch (err) {
    console.warn('[realtimeEmitters] emitWalletUpdate error:', err.message);
  }
}


function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ─── PAYOUT SUCCESS BATCH ────────────────────────────────────────────────────
/**
 * emitPayoutSuccessBatch — send personalized winner payout updates in bounded
 * chunks. Balances are preloaded by the settlement engine in one DB query; this
 * helper only fans out realtime packets and yields between chunks so a huge
 * winner set cannot monopolize the event loop.
 *
 * @param {object} params
 * @param {Array<{userId:string,payout:number,betAmount:number}>} params.payouts
 * @param {Object<string, object>} params.balanceMap - keyed by user id
 * @param {string} params.cycleId
 * @param {string} params.winner
 * @param {number} [params.batchSize]
 * @returns {Promise<number>} sent packet count
 */
export async function emitPayoutSuccessBatch({ payouts, balanceMap, cycleId, winner, batchSize = 500 }) {
  if (!Array.isArray(payouts) || payouts.length === 0) return 0;
  const size = Math.max(1, Number(batchSize) || 500);
  let sent = 0;

  for (let i = 0; i < payouts.length; i += size) {
    const batch = payouts.slice(i, i + size);
    for (const wp of batch) {
      const freshUser = balanceMap?.[wp.userId];
      if (!freshUser) continue;
      emitToPlayer(wp.userId, 'payout_success', {
        type:            'PAYOUT_SUCCESS',
        cycleId,
        winner,
        amount:          wp.payout,
        betAmount:       wp.betAmount,
        winningsBalance: freshUser.winningsBalance || 0,
        depositBalance:  freshUser.depositBalance  || 0,
        lockedBalance:   freshUser.lockedBalance   || 0,
        walletBalance:   (freshUser.depositBalance || 0) + (freshUser.winningsBalance || 0),
        timestamp:       Date.now(),
      });
      sent += 1;
    }
    if (i + size < payouts.length) await nextTick();
  }

  return sent;
}

// ─── ORDER UPDATE ─────────────────────────────────────────────────────────────
/**
 * emitOrderUpdate — Notify user of order status change via SSE.
 *
 * @param {string|ObjectId} userId
 * @param {string} event — SSE event name, e.g. 'order_assigned', 'order_paid', 'order_completed'
 * @param {object} data  — order payload
 */
/**
 * Push a balance change down the user's SSE channel.
 *
 * Lived in `wallet.service.js` until the document-store wallet was deleted, and
 * was the only thing keeping that 441-line module reachable. It never belonged
 * there: telling a browser about a number is a notification concern, and the
 * wallet's job ends when the transaction commits.
 *
 * Best-effort by construction. A failed push must never unwind a movement that
 * has already committed — the client re-reads its balance on the next request
 * regardless, so a dropped event costs a stale figure for seconds, and throwing
 * here would cost the transaction.
 */
export function sseBalancePush(userId, balances) {
  // The same event, under the same name, as `emitWalletUpdate` (§12): this
  // was `balance_update`, a second name for one change that no panel heard.
  // A pocket the movement did not report is left out, so the panel keeps
  // what it has rather than being told zero.
  const round2 = (n) => Math.round((n || 0) * 100) / 100;
  const payload = { timestamp: Date.now() };
  for (const k of ['depositBalance', 'winningsBalance', 'reserveBalance', 'lockedBalance']) {
    if (typeof balances?.[k] === 'number') payload[k] = round2(balances[k]);
  }
  payload.walletBalance = round2((balances?.depositBalance || 0) + (balances?.winningsBalance || 0));
  emitToPlayer(userId, 'user_balance_update', payload);
}

export function emitOrderUpdate(userId, event, data) {
  // One name, `order_update`, with what happened in `event`. The SSE copy used
  // to go out under `event` itself (order_assigned, order_paid, …) — a second
  // set of names for the same change, on a channel nothing had opened.
  emitToPlayer(userId, 'order_update', { type: 'ORDER_UPDATE', event, ...data });
}

// ─── MERCHANT UPDATE ──────────────────────────────────────────────────────────
/**
 * emitMerchantUpdate — Push order/queue event to a specific merchant via SSE.
 *
 * @param {string|ObjectId} merchantId
 * @param {string} event  — e.g. 'new_order', 'order_paid'
 * @param {object} data
 */
export function emitMerchantUpdate(merchantId, event, data) {
  try {
    if (global.sseManager) {
      global.sseManager.sendToMerchant(String(merchantId), event, data);
    }
  } catch (err) {
    console.warn('[realtimeEmitters] emitMerchantUpdate error:', err.message);
  }
}

/**
 * emitAllMerchantsUpdate — one event to EVERY connected merchant panel.
 *
 * Distinct from `emitMerchantUpdate`, which addresses one merchant by id.
 * Passing a wildcard to that one reaches nobody: it looks the literal string up
 * as a merchant id, finds no client set, and returns silently.
 */
export function emitAllMerchantsUpdate(event, data) {
  try {
    if (global.sseManager) {
      global.sseManager.broadcastToMerchants(event, data);
    }
  } catch (err) {
    console.warn('[realtimeEmitters] emitAllMerchantsUpdate error:', err.message);
  }
}

// ─── ADMIN UPDATE ─────────────────────────────────────────────────────────────

/**
 * emitAdminUpdate — Broadcast event to all connected admins via SSE.
 *
 * @param {string} event — e.g. 'new_order', 'queue_order_update', 'order_completed'
 * @param {object} data
 */
export function emitAdminUpdate(event, data) {
  try {
    if (global.sseManager) {
      global.sseManager.broadcastToAdmins(event, data);
    }
  } catch (err) {
    console.warn('[realtimeEmitters] emitAdminUpdate error:', err.message);
  }
}

// ─── NEW EVENTS (GOVERNANCE §11) ─────────────────────────────────────────────
// These events are registered in CLAUDE.md §11 event table.
// order_assigned → server→user: when merchant assigned to order
// order_expired  → server→user: when order hits expiry
// order_disputed → server→admin: when either party disputes
// merchant_score_update → server→merchant: after each order completes

// Note: emitOrderUpdate and emitMerchantUpdate already handle these event names
// as generic wrappers. The names listed here are the canonical SSE event strings
// passed as the `event` argument per GOVERNANCE §11.
