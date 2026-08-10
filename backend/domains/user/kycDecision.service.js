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
import mongoose from 'mongoose';
import { KYC_STATES, KYC_ALLOWED_FROM } from '../../postgres/kycPg.js';
import { decideKycOnPostgres } from '../../postgres/kycPgAuthority.js';

export { KYC_STATES };

export const KYC_OUTCOME = Object.freeze({
  APPLIED:            'applied',
  ILLEGAL_TRANSITION: 'illegal_transition',
  ALREADY_THERE:      'already_there',
  NOT_FOUND:          'not_found',
});

const User = () => mongoose.model('User');

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

  // The resolver, asked once. KYC cuts over LAST, so this returns
  // `handled: false` until every path it gates has moved.
  const routed = await decideKycOnPostgres(userId, to, { actor, reason, set, txId });
  if (routed.handled) {
    const { handled, ...answer } = routed;
    return answer;
  }

  const patch = {
    kycStatus: to,
    // Written to the field the projection reads, which is the whole fix.
    // Cleared on any non-rejection so an approved user does not carry the
    // reason they were once refused.
    'kycData.rejectionReason': to === KYC_STATES.REJECTED ? String(reason).trim() : undefined,
    'kycData.reviewedBy':      actor ?? undefined,
    'kycData.reviewedAt':      actor ? new Date() : undefined,
    ...set,
  };
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
  const unset = to === KYC_STATES.REJECTED ? {} : { 'kycData.rejectionReason': '' };

  const updated = await User().findOneAndUpdate(
    { _id: userId, kycStatus: { $in: allowed } },
    { $set: patch, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    { new: true },
  ).lean();

  if (updated) {
    return { ok: true, idempotent: false, reason: KYC_OUTCOME.APPLIED, status: to, user: updated };
  }

  // Why did it match nothing? Re-read AFTER the fact, so it can never be the gate.
  const current = await User().findById(userId).select('kycStatus').lean();
  if (!current) return { ok: false, reason: KYC_OUTCOME.NOT_FOUND };
  if (current.kycStatus === to) {
    return { ok: true, idempotent: true, reason: KYC_OUTCOME.ALREADY_THERE, status: to };
  }
  return {
    ok: false, reason: KYC_OUTCOME.ILLEGAL_TRANSITION,
    status: current.kycStatus, attempted: to, allowedFrom: allowed,
  };
}

export const submitKycForReview = (id, o) => decideKyc(id, KYC_STATES.PENDING_APPROVAL, o);
export const approveKyc         = (id, o) => decideKyc(id, KYC_STATES.APPROVED, o);
export const rejectKyc          = (id, o) => decideKyc(id, KYC_STATES.REJECTED, o);
