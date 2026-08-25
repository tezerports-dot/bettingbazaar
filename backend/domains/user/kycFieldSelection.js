// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/user/kycFieldSelection.js — which KYC fields the Postgres adoption
 * sweep may ask for.
 *
 * ── The rule: name leaves, never a parent AND its child ─────────────────────
 * Kept as a named constant even though `kycData` no longer holds anything
 * `select: false`, because the rule it encodes is the one that bites. Writing
 *
 *     .select('kycStatus kycData +kycData.someHiddenField')
 *
 * compiles to `{kycStatus: 1, kycData: 1, 'kycData.someHiddenField': 1}`, and
 * **MongoDB 4.4+ refuses a projection containing both a path and its prefix**:
 * "Path collision at kycData.someHiddenField". That throws at runtime, against
 * a real server only — the Postgres suite has no Mongo in it, so it passes and
 * CI's integration step is the first thing to see it. Enumerating leaves here
 * keeps the next person who adds a hidden field from rediscovering that.
 *
 * ── What is no longer here ──────────────────────────────────────────────────
 * nameOnAadhaar, nameOnPAN, panNumber, idProofUrl, photoUrl, idProofKey and
 * photoKey were removed on 2026-08-25 with the document-upload path. Nothing
 * collects a name, a PAN or a document any more; identity lives in
 * KycVerification and never travels through this sweep. The matching columns
 * remain in `user_kyc` — a mirror keeps its history — and simply stay null.
 */

/** Every `kycData` field the Postgres mirror still writes into `user_kyc`. */
export const KYC_MIRROR_SELECT = [
  'kycStatus',
  'kycData.submittedAt',
  'kycData.rejectionReason',
  'kycData.reviewedBy',
  'kycData.reviewedAt',
].join(' ');
