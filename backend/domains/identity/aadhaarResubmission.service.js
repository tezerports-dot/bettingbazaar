// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * aadhaarResubmission.service.js — a REJECTED player corrects their Aadhaar.
 *
 * ── Why this moved out of the Telegram domain ──────────────────────────────
 * It lived in `telegramOnboarding.service.js` because the bot was the only
 * surface a player had: their account was created in a chat, so a correction
 * had to arrive in a chat too. The form changed that. A player submits a
 * corrected number on the SAME screen that told them it was rejected, through
 * `POST /api/v1/auth/kyc/resubmit`, and Telegram has nothing to do with it.
 *
 * The rest of the file is unchanged, and unchanged on purpose: the attempt cap,
 * the claim-before-work ordering and the release-on-refusal are the parts that
 * make "submit a number, be told whether it is registered" stop being an
 * enumeration oracle, and they were got right once already.
 */
import {
  getUser, claimKycSubmission, releaseKycSubmission,
} from '#db/repositories/users.js';
import { getIdentityByUserId } from '#db/repositories/telegram.js';
import {
  findRegisteredAadhaar, submitVerification, releaseFailedSubmission,
} from '#db/repositories/identity.js';
import { hashAadhaar, hashAadhaarCandidates } from './aadhaarHash.util.js';
import { encryptField } from './fieldCrypto.util.js';
import { isValidAadhaar } from './signupFields.js';

/**
 * How many Aadhaar numbers one account may ever submit.
 *
 * The first is the signup. The rest are corrections. Bounded because
 * "submit a number, be told whether it is already registered" is an enumeration
 * oracle the moment it can be repeated freely — the cap is what keeps this a
 * correction path rather than a probe. Someone who genuinely exhausts it has a
 * problem support should look at anyway.
 */
export const MAX_KYC_SUBMISSIONS = 3;


/**
 * Replace a rejected Aadhaar with a new one.
 *
 * ── Why this has to exist ───────────────────────────────────────────────────
 * The Aadhaar is immutable once verified, which is correct. But a player who
 * mistyped a digit is rejected through no fault of the design, and without this
 * their account is permanently dead: the signup conversation is over, so
 * sending a new number did nothing, and support had no code path either.
 *
 * ── Why the old row is gone by the time we get here ─────────────────────────
 * `releaseFailedSubmissions` (kycBulk) deletes a failed submission once the
 * verdict is on the user. That releases the unique `aadhaarHash` — which is
 * what makes a re-submission possible at all, and also un-breaks the stranger
 * whose Aadhaar the typo was occupying.
 *
 * @returns {Promise<{ok: true, last4: string} | {ok: false, reason: string}>}
 */
export async function resubmitAadhaar({ userId, aadhaar }) {
  const user = await getUser(userId);
  if (!user) return { ok: false, reason: 'no_user' };

  // Only a rejected account may resubmit. An APPROVED Aadhaar is immutable, and
  // a PENDING one is already queued — letting either through would be a way to
  // change a verified identity, which is the thing the whole model forbids.
  if (user.kycStatus !== 'REJECTED') return { ok: false, reason: 'not_rejected' };

  if (!isValidAadhaar(aadhaar)) return { ok: false, reason: 'invalid_format' };

  /**
   * The attempt is CLAIMED before any work, in one statement that both checks
   * the cap and consumes an attempt.
   *
   * It used to read the count near the top and increment at the very bottom,
   * which left the whole submission between them: two reapplies arriving
   * together both read the same count, both passed, and the cap was exceeded
   * by exactly the number of requests in flight. That cap is the only thing
   * stopping "submit a number, be told whether it is registered" from being a
   * repeatable enumeration oracle, so a concurrency hole in it is the hole.
   *
   * The trade is deliberate: a refused submission below RELEASES the attempt,
   * but a crash between the claim and the release burns one. Burning an attempt
   * on a rare crash is a support ticket; an unbounded oracle is not.
   */
  const claimed = await claimKycSubmission(userId, MAX_KYC_SUBMISSIONS);
  if (claimed === null) return { ok: false, reason: 'too_many_attempts' };

  /** Give the attempt back — this submission never entered the queue. */
  const release = () => releaseKycSubmission(userId).catch(() => {});

  const normalised = String(aadhaar).replace(/[\s-]/g, '');
  const hash = hashAadhaar(normalised);

  // Their own live row would mean the release did not happen; anyone else's
  // means the number genuinely belongs to another account. Checked across
  // every candidate hash, so a number registered under a retired HMAC secret
  // still reads as taken.
  if (await findRegisteredAadhaar(hashAadhaarCandidates(normalised))) {
    await release();
    return { ok: false, reason: 'already_registered' };
  }

  const identity = await getIdentityByUserId(userId);

  const submitted = await submitVerification({
    userId,
    aadhaarHash: hash,
    aadhaarEncrypted: encryptField(normalised),
    aadhaarLast4: normalised.slice(-4),
    phone: identity?.phone || '',
  });
  if (!submitted.ok) {
    await release();
    // `user_already_submitted` means the previous row was never released, so
    // this is a state problem rather than a duplicate Aadhaar.
    return { ok: false, reason: 'already_registered' };
  }

  // Back into the queue, through the state machine rather than a raw write, so
  // the transition is checked and recorded like every other KYC decision.
  const { submitKycForReview } = await import('../user/kycDecision.service.js');
  const moved = await submitKycForReview(userId, { reason: null });
  if (!moved.ok) {
    // Do not strand a submission the user cannot see the status of.
    await releaseFailedSubmission(userId).catch(() => {});
    await release();
    return { ok: false, reason: 'state_refused' };
  }

  return { ok: true, last4: normalised.slice(-4) };
}
