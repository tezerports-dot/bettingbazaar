// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/disputes/disputeOutcome.service.js — what a decided dispute costs the
 * party that was wrong (2c+, owner 2026-10-02 21:13).
 *
 * "In these cases the one who was wrong will be suspended completely and only a
 * sub admin can lift the suspension … if someone crosses these kind of disputes
 * three times he will be suspended and again sent to admin review in high risk
 * case."
 *
 * ── Who was wrong is a function of the OUTCOME ─────────────────────────────
 * The order's type and whether the decision completed it say it exactly:
 *
 *                   completed (the money went the way the order asked)   not completed
 *   BUY  (DEPOSIT)  the player DID pay; the member who said not -> MEMBER     the player did not pay -> PLAYER
 *   SELL            the member DID pay; the player who said not -> PLAYER    the member did not pay -> MEMBER
 *
 * ── Every route that decides a dispute calls this, and only after its
 *    guarded transition committed ───────────────────────────────────────────
 * The Dispute Manager, the Payment Control Centre's resolve, and the queue
 * action on a DISPUTED order all end disputes (§32 S3: two routes reaching one
 * state must admit the same consequences). The record is keyed by the order,
 * so a replayed decision suspends nobody twice.
 */
import { db } from '#db';
import { FAULT_PARTIES, HIGH_RISK_LOSSES } from '#db/repositories/disputeFaults.js';
import { notify } from '../communication/communication.service.js';
import { sendAlert } from '../../services/alerting.service.js';

/** Who lost the dispute on `order`, given whether the decision completed it. */
export function partyAtFault(order, { completed }) {
  if (order.type === 'DEPOSIT') return completed ? FAULT_PARTIES.MERCHANT : FAULT_PARTIES.PLAYER;
  return completed ? FAULT_PARTIES.PLAYER : FAULT_PARTIES.MERCHANT;
}

/**
 * Suspend the party that lost the dispute on `order`, count the loss, and open
 * high-risk review on the third.
 *
 * @param {object} order  the order AS READ BEFORE the decision — a dispute is
 *   only a dispute if it was DISPUTED when the decision was taken
 * @param {{completed: boolean, decision: string, by: string|null}} decided
 */
export async function recordDisputeLoser(order, { completed, decision, by = null }) {
  if (!order || order.status !== 'DISPUTED') return { ok: false, reason: 'not_a_dispute' };
  const party = partyAtFault(order, { completed });
  if (party === FAULT_PARTIES.MERCHANT && !order.merchantId) {
    // A dispute with no member on it decided against "the member": there is
    // nobody to suspend. Said, so a person can see it, rather than dropped.
    console.error(`[dispute-outcome] ${order.orderId} decided against the member, but no member is on the order`);
    return { ok: false, reason: 'no_member' };
  }

  const recorded = await db.disputeFaults.recordDisputeFault({
    orderId: order.orderId, party,
    userId: order.userId ? String(order.userId) : null,
    merchantId: order.merchantId ? String(order.merchantId) : null,
    decision, decidedBy: by,
  });
  if (!recorded.ok) {
    sendAlert('dispute-fault-not-recorded', 'A dispute was decided but the party at fault could not be suspended', {
      orderId: order.orderId, party, reason: recorded.reason,
    }).catch(() => {});
    return recorded;
  }
  if (recorded.already) return recorded;

  // Everything below narrates a suspension that has COMMITTED (§21): none of
  // it may undo or block the decision.
  await db.audit.recordDetailed({
    performedBy: by ? String(by) : 'system', action: 'DISPUTE_LOST_SUSPENDED', category: 'DISPUTE',
    targetType: party === FAULT_PARTIES.PLAYER ? 'User' : 'Merchant',
    targetId: String(party === FAULT_PARTIES.PLAYER ? order.userId : order.merchantId),
    details: { orderId: order.orderId, decision, lostDisputes: recorded.lostCount, highRisk: recorded.highRisk },
  }).catch(() => {});

  if (party === FAULT_PARTIES.PLAYER) {
    await notify({
      userId: String(order.userId),
      type: 'ALERT',
      title: 'Your account has been suspended',
      message: `The dispute on order ${order.orderId} was decided against you, so your account is suspended `
        + 'until a staff member reviews it.'
        + (recorded.highRisk
          ? ` You have lost ${recorded.lostCount} disputes, so an admin must review your account before it can be used again.`
          : ''),
    }).catch(() => {});
  }
  if (recorded.newlyHighRisk) {
    sendAlert('account-high-risk', `An account lost its ${HIGH_RISK_LOSSES}rd dispute and needs admin review`, {
      party, orderId: order.orderId,
      account: String(party === FAULT_PARTIES.PLAYER ? order.userId : order.merchantId),
      lostDisputes: recorded.lostCount,
    }).catch(() => {});
  }
  return recorded;
}
