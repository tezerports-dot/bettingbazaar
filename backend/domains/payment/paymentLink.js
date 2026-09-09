// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * paymentLink.js — the per-order payment link, built once, on the server.
 *
 * ── Why the server builds it ───────────────────────────────────────────────
 * The user panel used to assemble the UPI intent itself, out of the merchant's
 * handle and name off the order. Two things followed, and both were live:
 *
 *   1. The panel had to be GIVEN the merchant's UPI id to do it. Everything
 *      below in `playerOrderView.js` about a player never learning who they are
 *      paying is unachievable while the client needs the handle to construct the
 *      link.
 *
 *   2. The amount and the reference were formatted client-side. A mistyped or
 *      mis-rounded `am=` is a payment the merchant cannot match against their
 *      statement, and the whole point of a pre-filled link is that there is
 *      nothing left to get wrong. The panel is also the one part of this system
 *      an attacker can edit.
 *
 * So the link has one owner and the client renders what it is handed.
 *
 * ── What this does NOT claim ───────────────────────────────────────────────
 * A `upi://pay` intent carries the payee address — that is the protocol, not a
 * choice available here. When the player taps this, their UPI app will show them
 * the payee it is about to pay.
 *
 * What that means honestly: this removes the merchant's handle, QR, BANK
 * ACCOUNT, IFSC and account-holder name from the platform's own responses and
 * screens, where a player could read, copy and keep them. It does not and cannot
 * hide the payee from the payer's own banking app at the moment of payment.
 * Making the platform the payee needs a payment aggregator in the middle, which
 * is a commercial decision and not something code can assert.
 */

/**
 * The UPI intent for one order.
 *
 * `am` is fixed to two decimals because a UPI app rejects more, and the amount
 * is the one field a merchant matches on. `tr` is the order id: it comes back on
 * the bank statement, which is what lets a merchant reconcile a payment whose
 * UTR the player mistyped.
 *
 * Returns null when the payee is missing rather than a link with an empty `pa=`.
 * A link that opens a UPI app with no payee is a player tapping a button that
 * does nothing, which this codebase has shipped before as an empty state.
 */
export function upiPaymentLink({ payeeUpiId, payeeName, amountRupees, orderId }) {
  const payee = String(payeeUpiId || '').trim();
  const amount = Number(amountRupees);
  if (!payee || !Number.isFinite(amount) || amount <= 0) return null;

  const params = new URLSearchParams({
    pa: payee,
    pn: String(payeeName || 'Merchant'),
    am: amount.toFixed(2),
    cu: 'INR',
    tn: `BettingBazaar-${orderId}`,
    tr: String(orderId),
  });
  return `upi://pay?${params.toString()}`;
}

export default upiPaymentLink;
