// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
//
// What the member's scanner read off a cash machine, said back to them before
// it goes to the player (Step 2d).
//
// A preview, not the rule. The server decides whether a link may be attached
// (backend/domains/payment/cashLink.js, `checkCashLink`) and refuses anything
// else by name; this only lets the member see the payee and the amount, and
// catches the commonest mistake (the wrong amount picked on the machine) while
// they are still standing at it. §11: UI-only, never used for validation.

export type CashLinkReading =
  | { ok: true; link: string; payee: string; amountRupees: number }
  | { ok: false; message: string };

const PREFIX = 'upi://pay?';

/** Mirror the server's MOBILE_IN_HANDLE and MOBILE_IN_TEXT (backend/domains/payment/cashLink.js). §11: a preview only. */
const MOBILE_IN_HANDLE = /(?:^|\D)(?:0{0,2}91|0)?[6-9]\d{9}(?:\D|$)/;
const MOBILE_IN_TEXT = /(?:^|[^0-9])(?:(?:00|\+)?91[ -]?|0)?[6-9](?:[ .-]?[0-9]){9}(?:[^0-9]|$)/;

const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;

/** Read a decoded QR against the order it is for. */
export function readCashLink(raw: string, orderAmountRupees: number): CashLinkReading {
  const text = String(raw ?? '').trim();
  if (text.slice(0, PREFIX.length).toLowerCase() !== PREFIX) {
    return { ok: false, message: 'That QR is not a UPI payment QR. Scan the QR the machine shows for UPI cash withdrawal.' };
  }
  const params = new URLSearchParams(text.slice(PREFIX.length));
  const payee = params.get('pa') ?? '';
  const am = Number(params.get('am'));
  if (!payee) {
    return { ok: false, message: 'That QR names no payee. Scan the QR the machine shows for UPI cash withdrawal.' };
  }
  if (MOBILE_IN_HANDLE.test(payee.split('@')[0])) {
    return { ok: false, message: 'That QR pays a mobile number, so it is a person\'s QR, not a cash machine\'s. Scan the QR the machine shows for UPI cash withdrawal.' };
  }
  if (['pn', 'tn'].some((key) => MOBILE_IN_TEXT.test(params.get(key) ?? ''))) {
    return { ok: false, message: 'That QR has a mobile number in its name or note, so it is a person\'s QR, not a cash machine\'s. Scan the QR the machine shows for UPI cash withdrawal.' };
  }
  if (!Number.isFinite(am) || am <= 0) {
    return { ok: false, message: `That QR has no amount. Choose ${rupees(orderAmountRupees)} on the machine first, then scan its QR.` };
  }
  if (Math.round(am * 100) !== Math.round(orderAmountRupees * 100)) {
    return {
      ok: false,
      message: `That QR is for ${rupees(am)}, but this order is ${rupees(orderAmountRupees)}. Choose ${rupees(orderAmountRupees)} on the machine and scan again.`,
    };
  }
  return { ok: true, link: text, payee, amountRupees: am };
}
