// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * paymentMode.service.js — flipping the settlement rail, and telling everybody.
 *
 * The repository publishes the version. This is the one place that decides what
 * else has to happen when it does, so a second caller cannot publish a version
 * and forget half of it.
 *
 * ── Why a merchant is told three ways ───────────────────────────────────────
 * Switching the rail changes the workflow a merchant performs: on P2P_UPI they
 * take a UTR against their own UPI, on CASH_ATM they scan an ATM QR and deposit
 * cash at a CDM. A merchant still running yesterday's workflow is a player
 * waiting for a payment that is never coming, so the news has to survive a
 * merchant being offline, having no linked player account, or having their
 * socket drop:
 *
 *   1. A notification row, durable, for every merchant that has an inbox.
 *   2. A socket push, for panels open right now.
 *   3. `GET /api/merchant/payment-mode`, read on panel load.
 *
 * The third is the one that actually guarantees correctness. The first two are
 * promptness. A design where the merchant only learns by notification has a
 * silent failure for every merchant who missed it.
 *
 * ── What is deliberately NOT done here ──────────────────────────────────────
 * Nothing touches orders in flight. They carry the rail they were created under
 * (`order_states.payment_mode`, immutable), and both rails run side by side
 * until the last pre-flip order settles. A "migrate the open orders" step is
 * exactly the thing the snapshot exists to make unnecessary.
 */
import { db } from '#db';
import {
  PAYMENT_MODES, getActivePolicy, getPolicyHistory, publishPolicyVersion,
} from '#db/repositories/paymentModePolicy.js';
import { emitAllMerchantsUpdate, emitAdminUpdate } from '../notification/realtimeEmitters.js';

export { PAYMENT_MODES, getActivePolicy, getPolicyHistory };

/** What a merchant is told the rail is called, and what it asks of them. */
const MODE_COPY = Object.freeze({
  [PAYMENT_MODES.P2P_UPI]: {
    label: 'UPI settlement',
    merchantMessage: 'Buy orders are paid to your UPI and confirmed by UTR. Withdrawals are paid from your account into the player\'s bank.',
  },
  [PAYMENT_MODES.CASH_ATM]: {
    label: 'ATM cash settlement',
    merchantMessage: 'Buy orders are served by scanning an ATM cash-withdrawal QR and supplying the link. Withdrawals are settled by depositing cash at a CDM and submitting the receipt.',
  },
});

export function modeCopy(mode) {
  return MODE_COPY[mode] ?? { label: String(mode), merchantMessage: '' };
}

/**
 * Publish a new policy version and announce it.
 *
 * Announcement happens only on success, and only AFTER the row is committed. A
 * notification sent before the write lands is a merchant told to change
 * workflow by a switch that then failed its CHECK.
 */
export async function switchPaymentMode({
  activeMode = undefined, timers = {}, justification = '',
  actorId = null, actorName = '',
} = {}) {
  const before = await getActivePolicy();
  const result = await publishPolicyVersion({
    activeMode, timers, justification,
    changedBy: actorId, changedByName: actorName,
  });
  if (!result.ok) return result;

  const policy = result.policy;
  const railChanged = before?.activeMode !== policy.activeMode;

  // Timer-only edits do not change what a merchant DOES, so they do not
  // interrupt every merchant with a notification. The rail changing does.
  if (railChanged) {
    const copy = modeCopy(policy.activeMode);
    await db.engagement.notifyMerchants({
      kind: 'WARNING',
      title: `Settlement is now ${copy.label}`,
      message: `${copy.merchantMessage} Orders you already hold keep the process they were created under.`,
      actionUrl: '/orders',
      actionLabel: 'Open my orders',
      relatedType: 'PaymentModePolicy',
      relatedId: String(policy.version),
    });
  }

  // Panels open right now, so a merchant mid-shift is not left on the old
  // workflow until their next page load.
  const payload = {
    activeMode: policy.activeMode,
    version: policy.version,
    railChanged,
    timers: publicTimers(policy),
  };
  emitAllMerchantsUpdate('payment_mode_changed', payload);
  emitAdminUpdate('payment_mode_changed', payload);

  return result;
}

/**
 * The timers, without the policy's authorship.
 *
 * A merchant reads the windows they are held to; `changedBy`, the justification
 * and the version history are an admin surface and are not part of this.
 */
export function publicTimers(policy) {
  if (!policy) return null;
  return {
    assignmentWaitSeconds:   policy.assignmentWaitSeconds,
    processingWindowSeconds: policy.processingWindowSeconds,
    utrSubmitSeconds:        policy.utrSubmitSeconds,
    disputeWindowSeconds:    policy.disputeWindowSeconds,
    linkExpirySeconds:       policy.linkExpirySeconds,
    linkMinRemainingSeconds: policy.linkMinRemainingSeconds,
  };
}
