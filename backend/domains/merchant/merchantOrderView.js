// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * merchantOrderView.js — the ONLY shape of an order a merchant may receive.
 *
 * ── Why this is an allowlist ───────────────────────────────────────────────
 * The projection this replaces was a denylist: it deleted `userPhone` and
 * `merchantSnapshot`, and deleted the player's payout destinations only when
 * the order was a DEPOSIT. Two things follow from that shape, and both were
 * live:
 *
 *   1. On a WITHDRAWAL the merchant received `userBankDetails.upiId`, because
 *      the delete ran only on the deposit branch. The merchant panel had a
 *      render for it — OrderCard's "Send to user UPI" — so the player's UPI ID
 *      was on screen. A merchant may see the bank account they must pay and
 *      the name on it. Nothing else identifies the player to them.
 *
 *   2. A denylist fails OPEN. `order_states` grows a column, `toOrder` maps it,
 *      and it reaches every merchant with no test failing — the new field is
 *      simply not in the delete list. The failure is silent and the direction
 *      of the mistake is always "too much", never "too little".
 *
 * An allowlist fails CLOSED: a field nobody named is absent, and the symptom is
 * a missing value on a screen rather than a leak nobody sees.
 *
 * ── What a merchant is NOT told ────────────────────────────────────────────
 * Beyond the player's identity: the platform's treasury split
 * (`depositAllocation`, `reserveAllocation`, `depositPolicySnapshot`), the risk
 * verdicts on their own conduct (`redFlagged*`, `requiresReview`, the review
 * notes), the admin actors behind a decision (`assignedBy`, `reviewedBy`,
 * `disputeResolvedBy`, `mediatorId`), and the tamper tag (`orderHmac`). A
 * merchant told they are red-flagged is a merchant told to change behaviour
 * before an investigation finishes.
 */

/**
 * Top-level fields a merchant may see. Anything absent here does not reach
 * them, whatever `toOrder` maps or `order_states` grows.
 */
export const MERCHANT_ORDER_FIELDS = Object.freeze([
  // Identity and routing.
  'orderId', '_id', 'id', 'userId', 'merchantId',
  'type', 'orderType', 'status', 'state', 'currency',

  // The amounts, and the merchant's own economics.
  'tokenAmount', 'fiatAmount', 'amount', 'rateUsed',
  'merchantProfit', 'merchantFee', 'payoutFee',

  // Escrow and the credit hold — the merchant's own money, so their own view.
  'escrowStatus', 'escrowLocked', 'escrowAmount',
  'merchantCreditStatus', 'merchantCreditHoldUntil',
  'merchantCreditReversedAt', 'merchantCreditReversedReason',

  // Payment evidence the merchant verifies against.
  'utr', 'utrNumber', 'proofScreenshot', 'proofExpiresAt',
  'utrWarning', 'utrWarningMessage',

  // Why an order ended the way it did. `rejectedReason` is the server's name
  // for this and the panel must read that name — it read `rejectionReason`,
  // which no responder has ever sent, so every rejection rendered its generic
  // fallback and the merchant never saw the reason.
  'rejectedReason', 'rejectionProofUrl', 'cancelReason',

  // The dispute, from the side the merchant is a party to.
  'disputeReason', 'disputeRaisedAt', 'disputeRaisedBy',
  'disputeEscalated', 'disputeResolvedAt',
  'disputeDecision', 'disputeResolution', 'refundedAmount',

  // The rail this order was BORN on — not the rail that is live now. The two
  // rails ask different things of a merchant (a UTR against their own UPI, or
  // cash at a machine and a CDM slip), and after an admin switches, both run
  // side by side until the last pre-flip order settles. A panel that branched
  // on the LIVE rail would put yesterday's workflow on today's order, so the
  // order carries its own answer.
  'paymentMode',

  // On a USDT order, the chain the PLAYER chose. The merchant has to watch the
  // right network: a payment on BNB Smart Chain never appears in a Tron
  // explorer, and a merchant looking at the wrong one sees nothing and assumes
  // they were not paid.
  'usdtChain',

  // Workflow timestamps.
  'assignedAt', 'processingAt', 'merchantPanelUrl', 'merchantResponseMinutes',
  'approvedAt', 'rejectedAt', 'cancelledAt',
  'paidAt', 'completedAt', 'expiresAt',
  'bulkPayoutDate', 'bulkPaidAt', 'bulkPayoutBatch',

  'createdAt', 'updatedAt',
]);

/**
 * The only parts of a player's bank details a merchant may see, and only on a
 * WITHDRAWAL — the order where the merchant has to send money somewhere.
 *
 * `upiId` is deliberately NOT here. It is a contact handle: it resolves to a
 * name and, on most UPI apps, to a phone number, so sending it to a merchant
 * defeats the rule that the merchant never learns the player's number.
 */
export const MERCHANT_BANK_FIELDS = Object.freeze([
  'accountNumber', 'ifscCode', 'bankName', 'accountHolderName',
]);

/**
 * Fields that must never appear in a merchant-facing order payload, named so a
 * build-time check can assert their absence rather than trusting review.
 */
export const MERCHANT_FORBIDDEN_ORDER_FIELDS = Object.freeze([
  'userPhone', 'upiId', 'userUsdtAddress', 'merchantSnapshot',
  'depositAllocation', 'reserveAllocation', 'depositPolicySnapshot',
  'redFlagged', 'redFlagReason', 'redFlaggedBy', 'redFlaggedAt',
  'requiresReview', 'reviewedBy', 'reviewedAt', 'reviewAction', 'reviewNotes',
  'assignedBy', 'approvedBy', 'rejectedBy', 'disputeResolvedBy',
  'disputeEscalationNotes', 'mediatorId', 'orderHmac',
  'warningIssued', 'requiresVideoKYC', 'utrWarningData', 'platformFeeRate',
]);

/** The four permitted bank fields, and nothing that arrived alongside them. */
function bankDetailsFor(order) {
  const bank = order?.userBankDetails;
  if (!bank || typeof bank !== 'object') return undefined;
  const out = {};
  for (const key of MERCHANT_BANK_FIELDS) {
    if (bank[key] !== undefined && bank[key] !== null) out[key] = bank[key];
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Project one order into the merchant-facing shape.
 *
 * Accepts either a plain row from `toOrder` or anything exposing `toObject`,
 * so it behaves identically wherever it is called.
 */
export function toMerchantOrderView(order) {
  if (!order) return null;
  const plain = typeof order.toObject === 'function' ? order.toObject() : order;

  const view = {};
  for (const key of MERCHANT_ORDER_FIELDS) {
    if (plain[key] !== undefined) view[key] = plain[key];
  }

  // A deposit is money coming IN to the merchant. There is nowhere for them to
  // send anything, so the player's payout destination is not part of the job.
  const type = plain.type ?? plain.orderType;
  if (type === 'WITHDRAWAL') {
    const bank = bankDetailsFor(plain);
    if (bank) view.userBankDetails = bank;
  }

  return view;
}

export function toMerchantOrderViews(orders) {
  return (orders || []).map((order) => toMerchantOrderView(order));
}
