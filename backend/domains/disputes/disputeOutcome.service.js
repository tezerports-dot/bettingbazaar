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
 * ── Only a dispute about whether a PAYMENT was made ────────────────────────
 * The rule is about one kind of dispute: the player (or the platform, on the
 * player's behalf) says a payment was or was not made, and the other side said
 * the opposite. So it counts only when
 *   - the player or the platform raised it (`disputeRaisedBy` 'user' or
 *     'system'): a member's red flag is a report to staff, not a claim that
 *     somebody lied, and suspends nobody;
 *   - and the order was disputed FROM a state where that question was open: a
 *     buy that was PAID (waiting for the member) or REJECTED (the member said
 *     no money came), a sell the member marked PAID or COMPLETED (inside its
 *     hold). A buy disputed after it COMPLETED has already been delivered, and
 *     dismissing that dispute says nothing against the member who confirmed it.
 * Security review, 2026-10-03: before this, deciding any DISPUTED order
 * suspended somebody — a member for confirming a buy the player later
 * disputed, a player for a red flag they never answered.
 *
 * ── Then who was wrong is a function of the OUTCOME ────────────────────────
 *
 *                   completed (the money went the way the order asked)   not completed
 *   BUY  (DEPOSIT)  the player DID pay; the member who said not -> MEMBER     the player did not pay -> PLAYER
 *   SELL            the member DID pay; the player who said not -> PLAYER    the member did not pay -> MEMBER
 *
 * A member is "the one who said not" on a buy only if they rejected it or sat
 * on a payment reference they were shown. A cash buy the platform disputed
 * because the player never submitted a reference was never put to the member.
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

/** The states a payment dispute is raised from, per order type. */
export const PAYMENT_DISPUTE_FROM = Object.freeze({
  DEPOSIT:    Object.freeze(['PAID', 'REJECTED']),
  WITHDRAWAL: Object.freeze(['PAID', 'COMPLETED']),
});

/**
 * Who lost the dispute on `order`, given whether the decision completed it and
 * the state it was disputed from — or null when the decision suspends nobody.
 */
export function partyAtFault(order, { completed, disputedFrom }) {
  if (!['user', 'system'].includes(order.disputeRaisedBy)) return null;
  if (!PAYMENT_DISPUTE_FROM[order.type]?.includes(disputedFrom)) return null;
  if (order.type === 'DEPOSIT') {
    if (!completed) return FAULT_PARTIES.PLAYER;
    return disputedFrom === 'REJECTED' || order.utr ? FAULT_PARTIES.MERCHANT : null;
  }
  return completed ? FAULT_PARTIES.PLAYER : FAULT_PARTIES.MERCHANT;
}

/**
 * What each decision on a DISPUTED order would cost, for the screen that takes
 * it: the party suspended if the order completes, and if it does not. The
 * panel shows this rather than keeping its own copy of the rule (§5).
 */
export function faultPreview(order, disputedFrom) {
  return {
    ifCompleted: partyAtFault(order, { completed: true, disputedFrom }),
    ifNotCompleted: partyAtFault(order, { completed: false, disputedFrom }),
  };
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
  const disputedFrom = await db.orders.disputedFromState(order.orderId);
  const party = partyAtFault(order, { completed, disputedFrom });
  if (!party) return { ok: false, reason: 'not_a_payment_dispute' };
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
