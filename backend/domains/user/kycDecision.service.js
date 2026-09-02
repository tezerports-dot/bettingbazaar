// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/user/kycDecision.service.js — the one place a KYC status changes.
 *
 * The same seam the order lifecycle got, for the same reasons and with one
 * extra: this one closes a live bug rather than only a race.
 *
 * ── The live bug ────────────────────────────────────────────────────────────
 * `routes/admin/kyc.admin.routes.js` rejects like this:
 *
 *     user.kycStatus = 'REJECTED';
 *     if (user.kyc) { user.kyc.rejectionReason = reason; … }
 *
 * The User schema has NO `kyc` subdocument — only `kycData`. Verified against
 * the compiled schema: `kyc.rejectionReason` is not a path, `kycData.rejectionReason`
 * is. So `user.kyc` is `undefined`, the guarded block never runs, and the
 * reason is dropped on the floor. The reason a rejected user is actually shown
 * comes from `kycData.rejectionReason` (kycPublicData.js) — which nothing
 * writes. Every rejected user is told they were rejected and never told why,
 * so they cannot fix the submission and resubmit.
 *
 * `reviewedBy` and `reviewedAt` are lost to the same dead branch, so no
 * approval on the Mongo path records who made it.
 *
 * ── The race ────────────────────────────────────────────────────────────────
 * That route also reads the user, assigns the status and saves — a
 * read-modify-write on a stale read. Two reviewers deciding at once both pass
 * the read; the last save wins and nothing records that the other decision
 * happened. The expected previous status now goes in the FILTER, so exactly one
 * reviewer's decision lands.
 *
 * ── One rule table, shared with Postgres ────────────────────────────────────
 * KYC_ALLOWED_FROM is imported from postgres/kycPg.js rather than restated, for
 * the same reason the order seam does it: two copies are two rules the moment
 * either changes, and a decision Postgres refuses while Mongo permits is a
 * disagreement no reconciliation can tell apart from real drift.
 */
import { db } from '#db';
import { KYC_STATES, KYC_ALLOWED_FROM } from '#db/repositories/kyc.core.js';

export { KYC_STATES };

export const KYC_OUTCOME = Object.freeze({
  APPLIED:            'applied',
  ILLEGAL_TRANSITION: 'illegal_transition',
  ALREADY_THERE:      'already_there',
  NOT_FOUND:          'not_found',
});


/**
 * Move a user's KYC to `to`, but only from a status the rules allow.
 *
 * `reason` is written to `kycData.rejectionReason` — the field the user-facing
 * projection actually reads — in the SAME update as the status, so a rejection
 * without its reason is not representable on this path either.
 */
export async function decideKyc(userId, to, { actor = null, reason = null, set = {}, txId = null } = {}) {
  const allowed = KYC_ALLOWED_FROM[to];
  if (!allowed) throw new Error(`decideKyc: '${to}' is not a status anything transitions into`);
  if (to === KYC_STATES.REJECTED && !String(reason ?? '').trim()) {
    throw new Error('decideKyc: a REJECTED decision requires a reason — it is what the user is shown.');
  }

  // ── One decision, and it is this one ──────────────────────────────────────
  // This used to ask a resolver and then carry a whole second implementation
  // for the case where it declined. Both wrote a status; only one of them wrote
  // the audit trail, and neither wrote `users.kyc_status` — the column every
  // authorisation gate in the app actually reads. An approved player was still
  // refused a withdrawal.
  //
  // `decideKyc` in the repository now moves `user_kyc`, appends to
  // `kyc_transitions` and updates `users.kyc_status` in ONE transaction, so the
  // decision, its evidence and the copy authorisation reads cannot disagree.
  return db.kyc.decideKyc(userId, to, { actor, reason, set, txId });
}

export const submitKycForReview = (id, o) => decideKyc(id, KYC_STATES.PENDING_APPROVAL, o);
export const approveKyc         = (id, o) => decideKyc(id, KYC_STATES.APPROVED, o);
export const rejectKyc          = (id, o) => decideKyc(id, KYC_STATES.REJECTED, o);
