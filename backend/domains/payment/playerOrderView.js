// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * playerOrderView.js — the ONLY shape of an order a player may receive.
 *
 * The mirror of `merchantOrderView.js`, pointing the other way. That file exists
 * because a denylist protecting the PLAYER failed open; this one exists because
 * nothing at all was protecting the MERCHANT.
 *
 * ── What was being sent ────────────────────────────────────────────────────
 * `buildMerchantSnapshot` put on every order, and every player-facing response
 * carried:
 *
 *     upiId          the merchant's UPI handle
 *     qrCodeUrl      their own QR image
 *     bankName       ┐
 *     accountNo      │ their BANK ACCOUNT
 *     ifsc           │
 *     accountHolder  ┘ and the name on it
 *     usdtAddress    their settlement wallet
 *
 * The player's screen rendered the handle in a copy-to-clipboard row. None of
 * the bank fields is needed to pay a UPI handle — they were pure disclosure, and
 * a player could read, copy and keep a merchant's account number and IFSC from
 * a single deposit.
 *
 * The rule is the reverse of the merchant one and just as short: **a player sees
 * where to pay and nothing about who they are paying.** They get a payment link
 * and an opaque reference; the merchant's identity, credentials and account are
 * not theirs to have.
 *
 * ── An allowlist, for the reason the other one is ──────────────────────────
 * A denylist admits the next field added to the snapshot by default, and the
 * mistake is always "too much". This admits nothing it does not name, so a new
 * field's symptom is a blank on a screen somebody notices rather than a leak
 * nobody does.
 *
 * ── The snapshot is KEPT on the order, and not sent ────────────────────────
 * `merchant_snapshot` records what was true at assignment, which is what a
 * dispute is decided from months later. So the row keeps it and this projection
 * refuses to pass it on: the admin and the disputes desk read the row, the
 * player reads this.
 */

/**
 * Top-level fields a player may see of their own order. Anything absent here
 * does not reach them, whatever `toOrder` maps or `order_states` grows.
 */
export const PLAYER_ORDER_FIELDS = Object.freeze([
  // Identity and routing. Their own order, their own id.
  'orderId', '_id', 'id', 'userId',
  'type', 'orderType', 'status', 'state', 'currency',

  // The money, from their side.
  'tokenAmount', 'fiatAmount', 'amount', 'rateUsed', 'payoutFee',

  // How their OWN deposit splits between the betting balance and the reserve.
  // Their money, and the creation response already says it in words — hiding
  // the machine-readable half while printing the human-readable one is theatre.
  // The POLICY that produced the split (`depositPolicySnapshot`) is not theirs
  // and stays out.
  'depositAllocation', 'reserveAllocation',

  // Where a withdrawal will be paid — the player's own bank account, which the
  // sell screen renders masked so they can check it before the money moves.
  'userBankDetails',

  // The rail this order runs on, so the screen knows which workflow to show.
  // Not the merchant's rail — the ORDER's, stamped at creation.
  'paymentMode',

  // Which chain THIS player chose to pay on. Their own choice, and the screen
  // has to keep showing it: a player who picked BEP-20 and is shown a Tron
  // address has lost their money, so the two are rendered together everywhere.
  'usdtChain',

  // Their own payment evidence, and the deadline for it.
  'utr', 'utrNumber', 'proofScreenshot', 'proofExpiresAt',
  'utrGraceAt', 'expiresAt',

  // Their own dispute.
  'disputeReason', 'disputeRaisedAt', 'disputeEscalated',
  'disputeResolvedAt', 'disputeDecision', 'disputeResolution', 'refundedAmount',

  // Why it ended, when it did.
  'rejectedReason', 'cancelReason', 'cancelledAt',

  // Their own escrow, so a sell screen can say the tokens are held.
  'escrowStatus', 'escrowLocked', 'escrowAmount',

  // The label grouping the separate withdrawals one request produced, so the
  // player is told "part 2 of 4" instead of finding four unexplained orders.
  'withdrawalBatchRef',

  // Where in the queue, and whether this was a second attempt — both about
  // their own order, and both things a screen explains to them.
  'assignmentPriority', 'retryOfOrderId',

  // Workflow timestamps.
  'assignedAt', 'processingAt', 'paidAt', 'completedAt',
  'createdAt', 'updatedAt',
]);

/**
 * Fields that must never appear in a player-facing order payload, named so a
 * build-time check can assert their absence rather than trusting review.
 *
 * `merchantSnapshot` heads the list: it is the container the credentials
 * travelled in, and the whole leak was that it was passed through whole.
 */
export const PLAYER_FORBIDDEN_ORDER_FIELDS = Object.freeze([
  // ── Who they are paying ───────────────────────────────────────────────────
  'merchantSnapshot', 'merchantId',
  'upiId', 'qrCodeUrl',
  // The merchant's stored addresses, as columns. What the player DOES receive
  // is `payTo.usdtAddress` — the one chain their own order named — which is a
  // payment destination, the wallet equivalent of the UPI intent. These two are
  // the merchant's credentials for BOTH chains and are not.
  'usdtAddressTrc20', 'usdtAddressBep20', 'usdtWalletAddress',
  'bankName', 'accountNo', 'ifsc', 'accountHolder',
  'merchantPanelUrl', 'merchantResponseMinutes',
  // The merchant's credit standing with the platform, and the batch the
  // platform pays them in. Neither is about this player's order.
  'merchantCreditStatus', 'merchantCreditHoldUntil',
  'merchantCreditReversedAt', 'merchantCreditReversedReason',
  'bulkPayoutDate', 'bulkPaidAt', 'bulkPayoutBatch',
  // The merchant's own evidence upload when they reject. `rejectedReason` is
  // the player's answer; the image behind it is the merchant's document and can
  // be a bank statement with their name on it.
  'rejectionProofUrl',

  // ── The platform's economics ──────────────────────────────────────────────
  'merchantProfit', 'merchantFee', 'platformFeeRate', 'depositPolicySnapshot',

  // ── Verdicts about the player, mid-investigation ──────────────────────────
  // A player told they are red-flagged is a player told to change behaviour
  // before anybody has finished looking.
  'redFlagged', 'redFlagReason', 'redFlaggedBy', 'redFlaggedAt',
  'requiresReview', 'reviewedBy', 'reviewedAt', 'reviewAction', 'reviewNotes',
  'requiresVideoKYC', 'warningIssued', 'utrWarningData',

  // ── Who acted on it, inside the company ───────────────────────────────────
  'assignedBy', 'approvedBy', 'rejectedBy', 'disputeResolvedBy',
  'disputeEscalationNotes', 'mediatorId', 'orderHmac',

  // ── Admin and disputes only ───────────────────────────────────────────────
  // The CDM slip, including from the player whose account it names. `toOrder`
  // does not map it; this says so too.
  'cdmTransactionId', 'cdmReceiptUrl', 'cdmReceiptAt',
]);

/*
 * Two fields are deliberately in NEITHER list.
 *
 * `userPhone` and the player's own identifiers are theirs: sending someone
 * their own phone number is not a disclosure, so forbidding it would be a false
 * alarm. They are simply not in the allowlist, so the projection does not emit
 * them and nothing has to remember to strip them.
 */

/**
 * What a player is told about the merchant serving their order: a payment link,
 * an opaque reference, and when the link stops being good for.
 *
 * The reference is `Merchant #<publicRef>` — a label that names nobody. It
 * exists so a player and support can talk about the same order without the
 * player learning who the person is.
 */
function counterpartyFor(order) {
  const snapshot = order?.merchantSnapshot;
  if (!snapshot || typeof snapshot !== 'object') return undefined;

  const view = {};
  // Built at assignment by `buildMerchantSnapshot`, from the merchant's own
  // credentials, on the server. The player never sees the parts it was built
  // from — see the module header on what a UPI intent does and does not hide.
  if (snapshot.paymentLink) view.paymentLink = snapshot.paymentLink;
  if (snapshot.merchantRef) view.merchantRef = snapshot.merchantRef;
  if (snapshot.expiresAt) view.expiresAt = snapshot.expiresAt;

  // ── The USDT rail's payment destination ────────────────────────────────
  // A wallet address IS where to pay, exactly as the UPI intent is on the INR
  // rail — so it belongs in `payTo` and nowhere else in the payload. What stays
  // out is the merchant's address on the OTHER chain, which is not part of this
  // order.
  //
  // The chain travels WITH the address, always. An address on its own is how
  // somebody sends on the wrong network and loses the tokens, and this is the
  // one field on this platform where the mistake cannot be undone.
  if (snapshot.usdtPayTo && snapshot.usdtChain) {
    view.usdtAddress = snapshot.usdtPayTo;
    view.usdtChain = snapshot.usdtChain;
    if (snapshot.usdtChainLabel) view.usdtChainLabel = snapshot.usdtChainLabel;
  }
  return Object.keys(view).length ? view : undefined;
}

/** Project one order into the player-facing shape. */
export function toPlayerOrderView(order) {
  if (!order) return null;
  const plain = typeof order.toObject === 'function' ? order.toObject() : order;

  const view = {};
  for (const key of PLAYER_ORDER_FIELDS) {
    if (plain[key] !== undefined) view[key] = plain[key];
  }

  const counterparty = counterpartyFor(plain);
  if (counterparty) view.payTo = counterparty;

  return view;
}

export function toPlayerOrderViews(orders) {
  return (orders || []).map((order) => toPlayerOrderView(order));
}
