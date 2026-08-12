// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/user/kycFieldSelection.js — which KYC fields a query may ask for.
 *
 * Two projections, in one place, because getting either one wrong is silent
 * until it is not.
 *
 * ── The rule: name leaves, never a parent AND its child ─────────────────────
 * `kycData.idProofKey` and `kycData.photoKey` are `select: false`, so a query
 * that wants them has to say so. The obvious way to write that —
 *
 *     .select('kycStatus kycData +kycData.idProofKey')
 *
 * — compiles to `{kycStatus: 1, kycData: 1, 'kycData.idProofKey': 1}`, and
 * **MongoDB 4.4+ refuses a projection containing both a path and its prefix**:
 * "Path collision at kycData.idProofKey". Every query built that way throws at
 * runtime, not at load, and only against a real server — the Postgres suite has
 * no Mongo in it, so it passed and CI's integration step was the first thing to
 * see it.
 *
 * So: enumerate the leaves. Both constants below are exported precisely so a
 * test can compile them against the real schema and assert no key is a prefix
 * of another (`kycFieldSelection.test.js`).
 */

/**
 * Every `kycData` field the Postgres mirror writes into `user_kyc`.
 *
 * Deliberately WITHOUT `aadhaarNumber`, which is also `select: false`. The
 * adoption sweep never had it — it selected the parent, and a `select: false`
 * child does not come with its parent — so `pan_number` has always been null
 * for an Aadhaar-only user. Adding it here would change what the mirror stores
 * and pull an identity number into a bulk sweep; that is a decision to take
 * deliberately, not a side effect of fixing a projection.
 *
 * The `idProofUrl` / `photoUrl` entries are the pre-cutover public URLs. Nothing
 * writes them any more, but naming them keeps a record written before the
 * private store mirrorable.
 */
export const KYC_MIRROR_SELECT = [
  'kycStatus',
  'kycData.nameOnAadhaar',
  'kycData.nameOnPAN',
  'kycData.panNumber',
  'kycData.idProofUrl',
  'kycData.photoUrl',
  'kycData.idProofKey',
  'kycData.photoKey',
  'kycData.submittedAt',
  'kycData.rejectionReason',
].join(' ');

/**
 * The two document keys, and nothing else.
 *
 * For the admin review endpoint, which needs a key to mint a grant from and has
 * no business receiving the rest of a user document to do it. Naming a
 * `select: false` path in an inclusive projection is what includes it; the `+`
 * prefix is only needed when adding to the DEFAULT projection, and using both
 * spellings at once is how the collision above gets reintroduced.
 */
export const KYC_DOCUMENT_KEY_SELECT = 'kycData.idProofKey kycData.photoKey';
