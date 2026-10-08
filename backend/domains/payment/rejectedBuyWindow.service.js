// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/payment/rejectedBuyWindow.service.js — the BUY escrow window (2c+).
 *
 * ── The rule (owner, 2026-10-02 21:13) ─────────────────────────────────────
 * A player taps Paid and gives a UTR; the team member says the money never
 * arrived and rejects the buy. That is one side's word, so the team's tokens
 * held for the buy stay in ESCROW and the player is told, with a deadline:
 * `SystemConfig.rejectedBuyDisputeMinutes` (default 15) to raise a dispute.
 *
 *   no dispute in the window   the buy is CANCELLED and the hold goes back
 *                              to the team pool — this sweep
 *   a dispute in the window    the hold stays, with no time limit, until the
 *                              dispute manager decides (the resolve routes)
 *
 * The deadline is written by the database clock in the transition that
 * rejects the buy, and the dispute route refuses on the same clock inside its
 * own transition, so "too late to dispute" and "the window has closed" are one
 * instant, not two.
 *
 * ── Why a sweep and not a timer ────────────────────────────────────────────
 * The window outlives any request and must survive a restart. The sweep is
 * idempotent and leader-locked by the job platform: closing a window is a
 * guarded REJECTED -> CANCELLED transition, so a dispute that lands first wins
 * (the order is no longer REJECTED) and two sweeps close it once.
 */
import { db } from '#db';
import { getSystemConfig } from '#db/repositories/config.js';
import { cancelOrder, canTransition, ORDER_STATES } from './orderLifecycle.service.js';
import { emitOrderUpdate, emitAdminUpdate, emitMerchantUpdate } from '../notification/realtimeEmitters.js';

/** schema default: 15 (SYSTEM_CONFIG_SPEC.rejectedBuyDisputeMinutes, bounded 5–1440). */
const DEFAULT_WINDOW_MINUTES = 15;

/** What a member is told on a buy the player has not marked paid. */
const NOT_PAID_YET_MESSAGE =
  'The player has not tapped Paid on this buy yet, so there is no payment to reject. '
  + 'Wait for their Paid tap, then check your account and confirm the money or reject it; '
  + 'a buy that is never paid expires on its own.';

/**
 * May a member say this buy's money never arrived? Null when they may; else
 * the refusal, with its status (§32 S35) and a message they can act on (S14).
 *
 * ── Only once the player has tapped Paid (owner, 2026-10-07) ──────────────
 * "Payment not received" denies a payment the player CLAIMED. Before the Paid
 * tap there is no claim, and the button warned and flagged a player who had
 * said nothing yet. The rule is the state machine's, not this function's:
 * REJECTED's one edge is from PAID (`ALLOWED_FROM`, in the transition's WHERE),
 * so this reads the table rather than keeping a second list. What it adds is
 * the wording, early: a buy that may still become PAID is "not yet" (400), and
 * anything past PAID is a conflict with where the order now stands (409).
 *
 * Asked by BOTH doors to the rejection, so they cannot admit different states
 * (§32 S3): the proof upload (`upload.routes.js`) and the reject itself
 * (`merchant.routes.js`), before and after its transition.
 *
 * @param {{ type: string, status: string }} order
 * @returns {null | { status: 400|409, code: string, message: string }}
 */
export function unpaidRejectRefusal(order) {
  if (order.type !== 'DEPOSIT') {
    return { status: 400, code: 'NOT_A_BUY', message: 'Only a buy order can be rejected as unpaid.' };
  }
  if (canTransition(order.status, ORDER_STATES.REJECTED)) return null;
  if (canTransition(order.status, ORDER_STATES.PAID)) {
    return { status: 400, code: 'NOT_PAID_YET', message: NOT_PAID_YET_MESSAGE };
  }
  return {
    status: 409,
    code: 'NOT_REJECTABLE',
    message: `This buy is ${order.status ?? 'missing'} now, so it cannot be rejected as unpaid.`,
  };
}

/** How long a player has to dispute a buy the member rejected as unpaid. */
export async function rejectedBuyDisputeMinutes() {
  try {
    const m = (await getSystemConfig())?.rejectedBuyDisputeMinutes;
    if (Number.isInteger(m) && m >= 5 && m <= 1440) return m;
  } catch { /* fall through to the schema default */ }
  return DEFAULT_WINDOW_MINUTES;
}

/**
 * Close every rejected buy whose window passed with no dispute: cancel it and
 * give the team its escrowed tokens back, in one transaction.
 *
 * Each order is isolated — one failure logs and the loop continues, because a
 * stuck order must not hold every other team's tokens.
 *
 * @returns {Promise<number>} how many windows THIS call closed.
 */
export async function closeRejectedBuyWindows({ limit = 200 } = {}) {
  const due = await db.orders.findClosedRejectedWindows({ limit });
  let closed = 0;
  for (const order of due) {
    try {
      const moved = await cancelOrder(order.orderId, {
        expectFrom: 'REJECTED',
        actor: 'system:reject-window',
        reason: 'No dispute raised inside the window',
        set: { cancelReason: 'MERCHANT_REJECTED', cancelledAt: new Date() },
        within: async (client) => {
          await db.teamPools.releaseBuyHoldWithin(client, order.orderId, {
            actor: 'system:reject-window', reason: 'Rejected as unpaid; no dispute inside the window',
          });
        },
      });
      // Disputed (or closed by another sweep) since it was read: nothing to do.
      if (!moved.ok || moved.idempotent) continue;
      closed += 1;
      emitOrderUpdate(String(order.userId), 'order_update', {
        orderId: order.orderId, _id: order.orderId, status: 'CANCELLED',
        message: 'The window to dispute this rejected payment has closed.',
        server_ts: Date.now(),
      });
      if (order.merchantId) {
        emitMerchantUpdate(String(order.merchantId), 'order_update', {
          orderId: order.orderId, status: 'CANCELLED', server_ts: Date.now(),
        });
      }
      emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'CANCELLED', server_ts: Date.now() });
    } catch (err) {
      console.error(`[reject-window] close failed for ${order.orderId}:`, err.message);
    }
  }
  return closed;
}
