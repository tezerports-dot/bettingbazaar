// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * playerOrderView.js — the ONLY shape of an order a player may receive.
 *
 * The mirror of `merchantOrderView.js`, pointing the other way. That file exists
 * because a denylist protecting the PLAYER failed open; this one exists because
 * nothing at all was protecting the MERCHANT.
 *
 * ── The rule (owner, 2026-10-03) ─────────────────────────────────────────
 * A player sees WHERE TO PAY and an opaque `Merchant #<ref>`, nothing else
 * about the member:
 *
 *   • on an INR bank-transfer buy (the 50,000 / 100,000 / 500,000 sizes), the
 *     assigned member's bank account (holder name, account number, IFSC, bank)
 *     is where to pay, so it is sent, inside `payTo.bankAccount` and only on
 *     that buy;
 *   • on a cash buy, the ATM QR the member scanned;
 *   • on a USDT buy, the address for the order's chain.
 *
 * Never the member's mobile number, and never their UPI handle, which is
 * usually that number. Before this rule every response carried the whole
 * snapshot (handle, QR, bank account, wallets) on every order and every
 * direction; it is the allowlist below that keeps each piece to the one order
 * that needs it.

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

import { PAYMENT_MODES } from '#db/repositories/orderRails.js';

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
  'upiId',
  // The merchant's stored addresses, as columns. What the player DOES receive
  // is `payTo.usdtAddress` — the one chain their own order named — which is a
  // payment destination, the wallet equivalent of the UPI intent. These two are
  // the merchant's credentials for BOTH chains and are not.
  'usdtAddressTrc20', 'usdtAddressBep20', 'usdtWalletAddress',
  // Never at the top level of an order: the member's account travels only in
  // `payTo.bankAccount`, and only on the bank-transfer buy it is paid on.
  'bankName', 'accountNo', 'ifsc', 'accountHolder',
  // Nobody learns another person's number (owner, 2026-10-03).
  'mobile', 'merchantMobile', 'phone',
  'merchantPanelUrl', 'merchantResponseMinutes',
  // The merchant's credit standing with the platform, and the batch the
  // platform pays them in. Neither is about this player's order.
  'merchantCreditStatus', 'merchantCreditHoldUntil',
  'merchantCreditReversedAt', 'merchantCreditReversedReason',
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
  'warningIssued', 'utrWarningData',

  // ── Who acted on it, inside the company ───────────────────────────────────
  'assignedBy', 'approvedBy', 'rejectedBy', 'disputeResolvedBy',
  'disputeEscalationNotes', 'mediatorId', 'orderHmac',
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
 * The member's bank account a player pays on an INR bank-transfer buy, and
 * nothing that arrived alongside it (owner, 2026-10-03). The four fields a
 * transfer needs. NOT the member's UPI handle and never a mobile number: a UPI
 * handle is usually the phone number, and nobody on this platform learns
 * another person's number.
 */
export const PLAYER_PAY_TO_BANK_FIELDS = Object.freeze([
  'accountHolder', 'accountNo', 'ifsc', 'bankName',
]);

/**
 * Where a player pays, by rail, and an opaque reference and deadline:
 *
 *   CASH buy       `paymentLink`, the ATM QR the member scanned (Step 2d).
 *                  It names the machine's bank, not the member. Until the scan
 *                  there is none, and the screen waits.
 *   UPI/bank buy   `bankAccount`, the assigned member's account, paid by bank
 *                  transfer (IMPS/NEFT/RTGS) with the UTR given back (owner,
 *                  2026-10-03). Absent when the member has no full account on
 *                  file, which routing does not allow (`routingCandidates`).
 *   USDT buy       `usdtAddress` with its chain, always together.
 *   any sell       nothing to pay: the member pays the player.
 *
 * The reference is `Merchant #<publicRef>`, a label that names nobody, so a
 * player and support can talk about the same order.
 *
 * Where to pay is sent only once the member has ACCEPTED (`PAY_DETAIL_STATES`).
 * While an order is ASSIGNED the member may still decline it and an admin may
 * still move it, so a destination shown then could take the player's money to
 * a member the order then leaves. And not after the order has ended: a
 * finished order's history does not keep handing out a member's account.
 */
/** The states in which the player is shown where to pay, and may have paid. */
export const PAY_DETAIL_STATES = Object.freeze(['PROCESSING', 'PAID', 'REJECTED', 'DISPUTED']);

function counterpartyFor(order) {
  const snapshot = order?.merchantSnapshot;
  if (!snapshot || typeof snapshot !== 'object') return undefined;
  const isBuy = order.type === 'DEPOSIT';

  const view = {};
  if (snapshot.merchantRef) view.merchantRef = snapshot.merchantRef;
  if (snapshot.expiresAt) view.expiresAt = snapshot.expiresAt;
  const accepted = PAY_DETAIL_STATES.includes(order.status);

  if (!accepted) {
    // Nothing to pay yet: the reference and the deadline only.
  } else if (isBuy && order.paymentMode === PAYMENT_MODES.CASH_ATM) {
    if (order.cashLink) view.paymentLink = order.cashLink;
  } else if (isBuy && order.currency !== 'USDT' && snapshot.accountNo) {
    const bank = {};
    for (const key of PLAYER_PAY_TO_BANK_FIELDS) {
      if (snapshot[key]) bank[key] = snapshot[key];
    }
    view.bankAccount = bank;
  }

  // ── The USDT rail's payment destination ────────────────────────────────
  // ONLY the chain this order asked for; the merchant's address on the other
  // chain is not part of this order. The chain travels WITH the address,
  // always: an address on its own is how somebody sends on the wrong network
  // and loses the tokens.
  if (accepted && isBuy && snapshot.usdtPayTo && snapshot.usdtChain) {
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

  const until = disputeDeadline(plain);
  if (until) view.disputeUntil = until;

  return view;
}

/**
 * Until when the player can still dispute this order while its tokens are in
 * escrow (2c+), or null when no window is running.
 *
 *   a BUY the member rejected as unpaid   the rejected-buy window
 *   a SELL the member marked paid         the hold, at least an hour
 *
 * DERIVED, and only the instant: the hold is the merchant's credit standing
 * (`merchantCreditHoldUntil`, forbidden above), and the player is told when
 * their own chance ends, not what the platform owes the team.
 */
function disputeDeadline(order) {
  if (order.status === 'REJECTED' && order.type === 'DEPOSIT') return order.disputeWindowUntil ?? null;
  if (order.type === 'WITHDRAWAL' && order.merchantCreditStatus === 'HELD') return order.merchantCreditHoldUntil ?? null;
  return null;
}

export function toPlayerOrderViews(orders) {
  return (orders || []).map((order) => toPlayerOrderView(order));
}
