// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)


import mongoose from 'mongoose';

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
      const User  = mongoose.model('User');
      const fresh = await User.findById(userId)
        .select('depositBalance winningsBalance reserveBalance lockedBalance').lean();
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

    // SSE (primary transport for wallet updates)
    if (global.sseManager) {
      global.sseManager.sendToUser(String(userId), 'balance_update', payload);
    }
    
    if (global.io) {
      global.io.to(`user-${userId}`).emit('user_balance_update', payload);
    }
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
 * @param {object} params.io - Socket.IO server
 * @param {Array<{userId:string,payout:number,betAmount:number}>} params.payouts
 * @param {Object<string, object>} params.balanceMap - keyed by user id
 * @param {string} params.cycleId
 * @param {string} params.winner
 * @param {number} [params.batchSize]
 * @returns {Promise<number>} sent packet count
 */
export async function emitPayoutSuccessBatch({ io, payouts, balanceMap, cycleId, winner, batchSize = 500 }) {
  if (!io || !Array.isArray(payouts) || payouts.length === 0) return 0;
  const size = Math.max(1, Number(batchSize) || 500);
  let sent = 0;

  for (let i = 0; i < payouts.length; i += size) {
    const batch = payouts.slice(i, i + size);
    for (const wp of batch) {
      const freshUser = balanceMap?.[wp.userId];
      if (!freshUser) continue;
      io.to(`user-${wp.userId}`).emit('payout_success', {
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
export function emitOrderUpdate(userId, event, data) {
  try {
    if (global.sseManager) {
      global.sseManager.sendToUser(String(userId), event, data);
    }
    
    if (global.io) {
      global.io.to(`user-${userId}`).emit('order_update', { type: 'ORDER_UPDATE', event, ...data });
    }
  } catch (err) {
    console.warn('[realtimeEmitters] emitOrderUpdate error:', err.message);
  }
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
// These events are registered in docs/governance/04-GOVERNANCE.md §11 event table.
// order_assigned → server→user: when merchant assigned to order
// order_expired  → server→user: when order hits expiry
// order_disputed → server→admin: when either party disputes
// merchant_score_update → server→merchant: after each order completes

// Note: emitOrderUpdate and emitMerchantUpdate already handle these event names
// as generic wrappers. The names listed here are the canonical SSE event strings
// passed as the `event` argument per GOVERNANCE §11.
