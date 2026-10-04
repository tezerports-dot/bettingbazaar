// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * cashLink.js — the payment link a cash buy is paid through, and what a
 * legitimate one looks like.
 *
 * ── The owner's rule (PROJECT_STATUS §3.10, Step 2d) ─────────────────────────
 * For a CASH buy the member stands at an ATM that offers UPI cash withdrawal.
 * The machine shows a QR; the member scans it with the scanner in their order
 * screen, and the link it decodes — a `upi://pay` intent with the amount
 * already in it — is attached to the order. The player sees one "Pay ₹amount"
 * button, pays it from their own UPI app, and the machine dispenses the cash to
 * the member. The member's own UPI handle is never where a cash buy is paid.
 *
 * ── Why the server checks a link a camera read ─────────────────────────────
 * The link is handed to a PLAYER as a button that opens their banking app, so
 * whatever is stored here is what somebody else pays. The member's panel is
 * the one that decodes it, and a panel is a client: anything it sends is a
 * request, not a fact. So the server holds the link to the shape of the thing
 * the owner described, and refuses everything else by name:
 *
 *   • a `upi://pay` intent and nothing else — never a web URL, never a
 *     `javascript:` string a screen would render as a live link;
 *   • a bounded length and a URL-safe alphabet, so nothing a camera misread
 *     (or a hand typed) can carry markup, whitespace or a control character;
 *   • exactly one of each parameter, so the amount a reader sees is the amount
 *     the banking app uses;
 *   • a payee address shaped like a UPI address, and no mobile number in it
 *     or in the name and note the player's UPI app shows (§24);
 *   • an amount EQUAL to the order's — a QR for a different sum is a different
 *     purchase, and the player would pay it for the tokens of this one;
 *   • rupees, when the currency is named at all.
 *
 * The link is otherwise stored as scanned. A machine's QR can carry a
 * signature over its parameters, and re-encoding them would break it.
 */
import { textHasAMobile } from '../identity/mobileInText.js';

/** Longest link accepted. A real ATM or merchant QR is a few hundred characters. */
export const CASH_LINK_MAX_LENGTH = 1024;

/** RFC 3986 unreserved + reserved characters, minus `#`, `[` and `]`. */
const URL_SAFE = /^[A-Za-z0-9\-._~:/?@!$&'()*+,;=%]+$/;

/** A UPI virtual payment address: handle@provider. */
const VPA = /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,64}$/;

/**
 * A mobile number inside a handle's name: a whole run of digits that is one,
 * with or without 91 or 0 in front. A cash machine's handle names the bank's
 * ATM service; a handle that is a phone number is a PERSON, and the player's
 * UPI app would show them that number (§24, owner 2026-10-03).
 */
const MOBILE_IN_HANDLE = /(?:^|\D)(?:0{0,2}91|0)?[6-9]\d{9}(?:\D|$)/;

/** A rupee amount with at most two decimals, as UPI writes it. */
const AMOUNT = /^\d{1,9}(\.\d{1,2})?$/;

const PREFIX = 'upi://pay?';

const refuse = (message) => Object.assign(new Error(message), { status: 400, code: 'INVALID_CASH_LINK' });

/**
 * Check a scanned link against the order it is for.
 *
 * @param {unknown} raw          what the member's scanner decoded
 * @param {number}  amountRupees the order's own amount, in rupees
 * @returns {string} the link to store (the scheme lower-cased, nothing else changed)
 * @throws  400 INVALID_CASH_LINK naming what is wrong
 */
export function checkCashLink(raw, amountRupees) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw refuse('Scan the payment QR on the machine — no link was received.');
  }
  const scanned = raw.trim();
  if (scanned.length > CASH_LINK_MAX_LENGTH) {
    throw refuse('That QR is not a UPI payment link (it is far too long). Scan the QR the machine shows for UPI cash withdrawal.');
  }
  if (scanned.slice(0, PREFIX.length).toLowerCase() !== PREFIX) {
    throw refuse('That QR is not a UPI payment link. Scan the QR the machine shows for UPI cash withdrawal.');
  }
  if (!URL_SAFE.test(scanned)) {
    throw refuse('That QR contains characters a UPI payment link never has. Scan it again.');
  }
  const link = PREFIX + scanned.slice(PREFIX.length);

  let params;
  try {
    params = [...new URLSearchParams(link.slice(PREFIX.length))];
  } catch {
    throw refuse('That QR could not be read as a UPI payment link. Scan it again.');
  }
  const seen = new Map();
  for (const [key, value] of params) {
    if (seen.has(key)) throw refuse(`That payment link names "${key}" twice, so it cannot be trusted. Scan the QR again.`);
    seen.set(key, value);
  }

  const payee = seen.get('pa');
  if (!payee || !VPA.test(payee)) {
    throw refuse('That payment link has no valid UPI payee address. Scan the QR the machine shows for UPI cash withdrawal.');
  }
  if (MOBILE_IN_HANDLE.test(payee.split('@')[0])) {
    throw refuse('That QR pays a mobile number, so it is a person\'s QR, not a cash machine\'s, and the player would see the number. Scan the QR the machine shows for UPI cash withdrawal.');
  }
  // A mobile written into the name or note a UPI app shows the payer, in any
  // spelling `textHasAMobile` reads (the database's `bb_text_has_a_mobile`).
  if (['pn', 'tn'].some((key) => textHasAMobile(seen.get(key) ?? ''))) {
    throw refuse('That QR has a mobile number in its name or note, so it is a person\'s QR, not a cash machine\'s, and the player would see the number. Scan the QR the machine shows for UPI cash withdrawal.');
  }

  const am = seen.get('am');
  const want = Math.round(Number(amountRupees) * 100);
  if (!am || !AMOUNT.test(am)) {
    throw refuse('That payment link has no amount in it. Choose the order amount on the machine first, then scan its QR.');
  }
  if (Math.round(Number(am) * 100) !== want) {
    throw refuse(`That QR is for ₹${Number(am).toLocaleString('en-IN')}, but this order is ₹${(want / 100).toLocaleString('en-IN')}. Choose ₹${(want / 100).toLocaleString('en-IN')} on the machine and scan again.`);
  }

  const cu = seen.get('cu');
  if (cu !== undefined && cu !== 'INR') {
    throw refuse('That payment link is not in rupees. Scan the QR the machine shows for UPI cash withdrawal.');
  }
  return link;
}

export default checkCashLink;
