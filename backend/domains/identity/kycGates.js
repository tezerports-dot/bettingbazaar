// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * kycGates.js — which KYC statuses may move money, and what a refusal says.
 *
 * ── Why this is its own module ─────────────────────────────────────────────
 * Two places have to answer "may this player fund an account?": the middleware
 * on the route, and `createDepositOrder` behind it. They used to answer
 * differently — the middleware admitted PENDING_APPROVAL, the service demanded
 * APPROVED — so a player passed the gate built to let them through and was
 * refused one layer down by a message that named neither their status nor what
 * to do. Two copies of one rule, and the stricter copy silently won.
 *
 * The gate stays in BOTH places deliberately: a rule enforced only in a route
 * is a rule the next route forgets. What must not be duplicated is the RULE
 * ITSELF, so it lives here and both import it.
 *
 * This module holds no imports and runs no side effects, which is the reason it
 * is not simply exported from `auth.middleware.js`: importing that file boots
 * the token layer and refuses to load without `PASETO_SECRET_KEY`, and the
 * payment service has no business requiring an auth secret to decide whether an
 * Aadhaar is on file.
 */

/**
 * Identity is LINKED — enough to put money IN.
 *
 * PENDING_APPROVAL counts: the Aadhaar is captured and queued, verification
 * runs in batches, and the player can do nothing to hurry it. Holding deposits
 * behind it loses the player without protecting anyone (owner decision).
 *
 * REJECTED does not count. An Aadhaar that came back not matching the issuing
 * authority means the details given were wrong, and the benefit of the doubt is
 * the wrong default on a money platform.
 */
export const KYC_LINKED_STATUSES = Object.freeze(['APPROVED', 'PENDING_APPROVAL']);

export const isKycLinked = (status) => KYC_LINKED_STATUSES.includes(status);

/**
 * Money OUT is a different rule and deliberately stricter: a withdrawal needs
 * an APPROVED Aadhaar. The asymmetry is the point — getting it wrong on the way
 * in costs a delay, getting it wrong on the way out cannot be undone.
 */
export const isKycApproved = (status) => status === 'APPROVED';

/**
 * What a refused player is told, per status.
 *
 * One wording, so the sentence a player reads does not depend on which layer
 * happened to refuse them.
 */
export const KYC_REFUSAL = Object.freeze({
  // Signed up through the bot: the Aadhaar is captured and queued. Nothing to do.
  PENDING_APPROVAL: 'Your Aadhaar is being verified. This is done in batches and needs nothing '
    + 'from you — you will be able to play as soon as it clears.',
  // No Aadhaar was ever captured. This is the only status a player can act on,
  // and the action is to finish signing up in the bot.
  PENDING_SUBMISSION: 'Finish signing up in our Telegram bot — we still need your Aadhaar number '
    + 'before you can play.',
  REJECTED: 'Your Aadhaar could not be verified against the issuing authority. Please contact '
    + 'support — this usually means a mismatch we can sort out for you.',
});

/** The sentence for a status, never silence for one nobody listed. */
export const kycRefusalFor = (status) => KYC_REFUSAL[status] || KYC_REFUSAL.PENDING_SUBMISSION;
