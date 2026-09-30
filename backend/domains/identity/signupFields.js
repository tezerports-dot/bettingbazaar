// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * signupFields.js — what a valid Aadhaar, mobile and referral code LOOK like.
 *
 * ── Why these live in one module (§2, §5) ──────────────────────────────────
 * The same three questions are now asked from two ends that must agree:
 *
 *   • the SIGNUP FORM, which takes the Aadhaar number and the Aadhaar-linked
 *     mobile the player types, and
 *   • the TELEGRAM CONTACT SHARE, which takes the number Telegram itself has
 *     verified and matches it against what was typed.
 *
 * If those two normalise a phone number differently, the match fails for a
 * player who did nothing wrong, and it fails SILENTLY — they are told to share
 * their contact, they share it, and the screen still says they have not. That
 * is the shape §5 exists to stop: the same value derived in two places drifts.
 *
 * So there is one normaliser per value, here, and both ends import it. They
 * were previously inside `telegramOnboarding.service.js`, which was correct
 * while Telegram was the only door and is wrong now that it is not.
 */

/**
 * Digits only, and the ten that identify an Indian subscriber.
 *
 * Telegram hands the number back as `91XXXXXXXXXX` (sometimes with a `+`), the
 * form takes the ten digits, and `users.mobile` holds the ten. Every shape is
 * reduced to the same ten here — otherwise the form's `9876543210` and
 * Telegram's `919876543210` are two different numbers and no contact share ever
 * matches an account.
 */
export function normalisePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

/**
 * A mobile the form may accept: exactly ten digits, and an Indian mobile.
 *
 * Stricter than `normalisePhone`, deliberately. The normaliser's job is to make
 * two representations of ONE number comparable and it must never reject a
 * number Telegram has already verified; this one is an INPUT check on something
 * a person typed, where "6 to 9" is the real first digit of every Indian mobile
 * and rejecting `1234567890` at the form is kinder than accepting it and
 * telling them months later that no contact share will ever match.
 */
export function isValidMobile(raw) {
  return /^[6-9]\d{9}$/.test(normalisePhone(raw) || '');
}

/** Twelve digits, spaces and dashes forgiven — that is the whole format. */
export function isValidAadhaar(raw) {
  return /^\d{12}$/.test(String(raw || '').replace(/[\s-]/g, ''));
}

/** The 12 digits with nothing around them — what is hashed and encrypted. */
export function normaliseAadhaar(raw) {
  return String(raw || '').replace(/[\s-]/g, '');
}

/**
 * Normalise a referral code.
 *
 * Codes are GENERATED uppercase and looked up by exact match, so a code that
 * arrives in another case matches nothing — and the failure is completely
 * silent: the signup succeeds, the referrer simply never earns, and nobody
 * finds out. That is the worst possible shape for an attribution bug, and it is
 * reachable from an ordinary retype of a link somebody was read out.
 *
 * Anything that is not a plausible code at all becomes null rather than being
 * stored as junk that will never match.
 */
export function normaliseReferralCode(raw) {
  const v = String(raw || '').trim().toUpperCase();
  return /^[A-Z0-9_-]{4,32}$/.test(v) ? v : null;
}
