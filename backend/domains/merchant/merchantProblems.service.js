// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant account's problems, and who hears when they flag it (owner,
 * 2026-10-11 — Phase B). The rows are `database/repositories/merchantProblems.js`;
 * this records one from the paths that find it and tells the admin about a flag.
 *
 * For a merchant account (a DIRECT team's owner) a refusal, an unpaid buy
 * counted against it and a lost dispute are PROBLEMS, not strikes: nothing
 * suspends or pauses it automatically. When one IST day's problems reach the
 * admin's threshold it is flagged once that day, and the admin is told here.
 * An agent keeps its suspension and pause rules unchanged.
 */
import { db } from '#db';
import { getSystemConfig } from '#db/repositories/config.js';
import { flagThresholdOf } from '#db/repositories/merchantProblems.js';
import { sendAlert } from '../../services/alerting.service.js';
import { emitAdminUpdate } from '../notification/realtimeEmitters.js';

/** Whether this merchant is a merchant account (problems flag it; nothing suspends it). */
export const isMerchantAccount = (merchantId) => db.merchantProblems.isDirectMerchant(merchantId);

/**
 * Record one problem against a merchant account and announce a flag it
 * raises. Never throws: the order it is about has already moved.
 */
export async function recordMerchantAccountProblem({ merchantId, kind, orderId }) {
  try {
    const out = await db.merchantProblems.recordProblem({
      merchantId, kind, orderId, threshold: flagThresholdOf(await getSystemConfig()),
    });
    if (out.flagged) announceMerchantFlag(out.flag);
    return out;
  } catch (error) {
    console.error(`[merchant-problem] ${merchantId} on ${orderId} (${kind}):`, error?.message || error);
    return { ok: false, recorded: false, flagged: false };
  }
}

/** The admin is told about a flag: the live screen and the alert channel. */
export function announceMerchantFlag(flag) {
  if (!flag) return;
  emitAdminUpdate('merchant_flag_raised', {
    merchantId: String(flag.merchantId),
    day: flag.day,
    problemCount: flag.problemCount,
    threshold: flag.threshold,
    server_ts: Date.now(),
  });
  sendAlert(
    `merchant-flag-${flag.merchantId}-${flag.day}`,
    `A merchant account reached ${flag.problemCount} problems today (threshold ${flag.threshold}). It is flagged, not suspended.`,
    { merchantId: String(flag.merchantId), day: flag.day, problemCount: flag.problemCount },
  ).catch(() => {});
}
