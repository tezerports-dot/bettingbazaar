// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * mobileInText.js — the one JavaScript reading of "a mobile number written
 * into text" (owner, 2026-10-03: nobody's mobile number may be exposed
 * anywhere; CLAUDE.md §24).
 *
 * The database's `bb_text_has_a_mobile` (database/schema.sql) is the same
 * rule, refusing rows; this module refuses input before it is written (a cash
 * QR's name and note, a team name) and hides numbers in text another person
 * typed (what a supervisor reads). The two change together, and
 * `mobileInTextPg.test.js` holds them to the same answers.
 *
 * ── What counts ─────────────────────────────────────────────────────────────
 * Ten digits starting 6–9, standing alone, with 91 / +91 / 091 / 0091 / 0 in
 * front or not. Between digits, up to two characters that are neither a digit
 * nor a Latin letter: "98765  43210", "(987) 654-3210", "98765/43210", an en
 * dash, a newline. Digits in other scripts count as digits: Devanagari and the
 * other Indian scripts, Arabic-Indic, full-width. Three separators, or a
 * letter, end the run, so "9,000 + 5,000 + 1,000" is three amounts.
 */

/** The ZERO of each digit set read as 0–9; each set's ten digits are consecutive. */
const DIGIT_ZEROS = Object.freeze([
  0xFF10, // full-width
  0x0660, // Arabic-Indic
  0x06F0, // Extended Arabic-Indic (Urdu)
  0x0966, // Devanagari
  0x09E6, // Bengali
  0x0A66, // Gurmukhi
  0x0AE6, // Gujarati
  0x0B66, // Odia
  0x0BE6, // Tamil
  0x0C66, // Telugu
  0x0CE6, // Kannada
  0x0D66, // Malayalam
]);

const TO_ASCII = new Map(DIGIT_ZEROS.flatMap((zero) =>
  Array.from({ length: 10 }, (_, i) => [String.fromCodePoint(zero + i), String(i)])));
const NON_ASCII_DIGIT = new RegExp(`[${[...TO_ASCII.keys()].join('')}]`, 'gu');

/** Every digit in `text` as an ASCII digit; everything else unchanged. */
export function asciiDigits(text) {
  return String(text).replace(NON_ASCII_DIGIT, (d) => TO_ASCII.get(d));
}

/** Lookarounds rather than consumed edges, so a replace keeps the characters either side. */
const MOBILE = '(?<![0-9])(?:(?:00|\\+|0)?91[^0-9A-Za-z]{0,2}|0)?[6-9](?:[^0-9A-Za-z]{0,2}[0-9]){9}(?![0-9])';
const MOBILE_ONCE = new RegExp(MOBILE);
const MOBILE_EVERY = new RegExp(MOBILE, 'g');

/** Whether `text` carries a mobile number in any spelling above. */
export function textHasAMobile(text) {
  return text != null && MOBILE_ONCE.test(asciiDigits(text));
}

/** `text` with every mobile number replaced by "[number hidden]"; null and undefined pass through. */
export function hideMobiles(text) {
  return text == null ? text : asciiDigits(text).replace(MOBILE_EVERY, '[number hidden]');
}

/** The refusal of a merchant username that is, or carries, a mobile number (`merchants_name_not_a_mobile`). */
export const NAME_IS_A_MOBILE_MESSAGE =
  'Your username is shown to other people (your supervisor, your team, admins), so it cannot be or contain a '
  + 'phone number. Choose another username.';
