// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Payment (BBEPS Phase 003 §3.3). Moved from backend/models/paymentOrder.model.js
// on 2026-07-01 (BBEPS Phase 004 migration).

import mongoose from 'mongoose';
import { setOrderHmacHook } from '../../middleware/order-crypto-access.js';
import { getActivePolicy } from '../configuration/depositPolicy.service.js';
// Risk Platform (Phase 010) owns the reserve-ratio rounding rule (Spec 4.4).
import { computeReserveSplit } from '../risk/riskValidation.service.js';
// Merchant Platform owns the settlement-rail vocabulary (GOVERNANCE §4).
import { MERCHANT_CURRENCY, MERCHANT_CURRENCIES } from '../merchant/merchantCurrency.js';

export const PAYMENT_PROOF_RETENTION_MS = 48 * 60 * 60 * 1000;

const paymentOrderSchema = new mongoose.Schema({
  orderId:        { type: String, required: true, unique: true },
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true, index: true },
  merchantId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', index: true },

  type:           { type: String, enum: ['DEPOSIT', 'WITHDRAWAL'], required: true },

  // ── Settlement rail ──────────────────────────────────────────────────────
  // Which rail this order settles on. Matched against Merchant.acceptedCurrencies
  // during assignment (merchantScoring.selectBestMerchant) and re-checked when a
  // merchant accepts, so an INR-only merchant never handles a USDT order and
  // vice-versa (2026-07-27). Vocabulary owned by
  // domains/merchant/merchantCurrency.js — GOVERNANCE §4.
  currency:       { type: String, enum: MERCHANT_CURRENCIES, default: MERCHANT_CURRENCY.INR, index: true },

  // ── Token & Pricing ─────────────────────────────────────────────────────
  // Token allocation split is governed by the active DepositPolicy for this
  // order's currency (domains/configuration/depositPolicy.model.js,
  // BBEPS §6.7 Business Policy).
  // 97/3 betting deduction:  3% platform fee deducted on settlement
  tokenAmount:    { type: Number, required: true },   // BB tokens to transfer
  fiatAmount:     { type: Number, required: true },   // INR user pays/receives (= tokenAmount, fixed 1:1 since 2026-07-08)
  amount:         { type: Number },                   // alias = fiatAmount (set on save)
  rateUsed:       { type: Number, required: true },   // always 1 for new orders (fixed 1:1); historical orders retain their real rate
  merchantProfit: { type: Number, default: 0 },       // spread retired 2026-07-08 — always 0 for new orders; historical audit only
  // Payout fee (rupees) deducted from a WITHDRAWAL's fiat payout (Phase 010).
  // % owned by SystemConfig.payoutFeePercent; computed by the Risk Platform
  // at order creation; recorded in the PAYOUT_FEES ledger account by R&S.
  payoutFee:      { type: Number, default: 0 },
  merchantFee:    { type: Number, default: 0 },       // fee paid to merchant

  // ── Token Allocation ──────────────────────────────────────────────────────
  // Computed once, at order creation, from the DepositPolicy active at that
  // moment (see pre-save hook below) — never recomputed later, so a later
  // admin change to the policy doesn't retroactively alter orders already in
  // flight. depositAllocation → user.depositBalance, reserveAllocation →
  // platform reserve, on DEPOSIT completion.
  depositAllocation: { type: Number, default: 0 },
  reserveAllocation: { type: Number, default: 0 },

  // Immutable audit snapshot of exactly which DepositPolicy version produced
  // the split above, independent of whatever the policy is later changed to.
  // Mirrors the `rateUsed` snapshot pattern (rateUsed is now always 1).
  depositPolicySnapshot: {
    policyVersionId:           { type: mongoose.Schema.Types.ObjectId, ref: 'DepositPolicy' },
    currency:                  { type: String, default: 'INR' },
    depositAllocationPercent:  { type: Number },
    reserveAllocationPercent:  { type: Number },
  },

  // ── Betting Deduction (97/3) ─────────────────────────────────────────────
  // Applied by gameEngine on bet settlement:
  //   platformFee = betAmount * 0.03
  //   netPayout   = grossPayout - platformFee
  platformFeeRate: { type: Number, default: 0.03 },  // 3% — stored for audit

  // ── Order Status ─────────────────────────────────────────────────────────
  status: {
    type: String,
    enum: ['PENDING_QUEUE', 'ASSIGNED', 'PROCESSING', 'PAID', 'COMPLETED',
           'DISPUTED', 'CANCELLED', 'FAILED', 'REJECTED'],
    default: 'PENDING_QUEUE',
    index: true,
  },

  // ── Reserve Wallet ───────────────────────────────────────────────────────
  escrowStatus: { type: String, enum: ['NONE', 'LOCKED', 'RELEASED', 'REFUNDED'], default: 'NONE' },

  // ── Withdrawal settlement hold (anti-fraud, 2026-07-30) ──────────────────
  // On a WITHDRAWAL the merchant sends the player fiat and receives tokens.
  // Confirming used to do both sides instantly: the player's locked stake was
  // consumed and the merchant's tokens became spendable in the same request.
  // A merchant who pressed "confirm" WITHOUT sending the money therefore held
  // liquid tokens immediately and could convert them through a buy order before
  // the player noticed nothing had arrived — the platform, not the merchant,
  // absorbed the loss.
  //
  // Confirm now only ASSERTS payment. Both sides stay frozen for a hold window
  // (SystemConfig.withdrawalHoldMinutes) so the player has time to say the money
  // never arrived. Nothing is settled until the window passes, so a dispute is a
  // reversal of something still held rather than a clawback of value already
  // spent.
  //
  // Deliberately symmetric: holding only the merchant's side would leave the
  // player's stake consumed with nothing to return on a successful dispute.
  merchantCreditStatus: {
    type: String,
    enum: ['NONE', 'HELD', 'RELEASED', 'REVERSED'],
    default: 'NONE',
    index: true,
  },
  // When the hold expires and the settlement worker may complete the order.
  merchantCreditHoldUntil: { type: Date },
  // Set when an admin resolves a dispute against the merchant, so the reversal
  // is auditable and the settlement worker can never pick the order back up.
  merchantCreditReversedAt:     { type: Date },
  merchantCreditReversedReason: { type: String },

  // ── User Identity ────────────────────────────────────────────────────────
  userPhone:       String,
  userBankDetails: {
    accountNumber:     String,
    ifscCode:          String,
    bankName:          String,
    accountHolderName: String,
  },
  // Payout destination on the USDT rail (currency === 'USDT', WITHDRAWAL only)
  // — the TRC-20 address the merchant sends to, the crypto counterpart of
  // userBankDetails. Read by the merchant panel's order detail; format-checked
  // by isTrc20Address at the write site.
  userUsdtAddress: { type: String, trim: true },

  // ── Payment Proof ────────────────────────────────────────────────────────
  requiresVideoKYC: { type: Boolean, default: false },
  utrNumber:        String,
  proofScreenshot:  String,
  proofExpiresAt:    { type: Date },

  // ── UTR Warning System ───────────────────────────────────────────────────
  utrWarning:        { type: String },              // 'DUPLICATE_UTR' | 'FRAUD_ALERT'
  utrWarningMessage: { type: String },
  utrWarningData:    { type: mongoose.Schema.Types.Mixed },
  requiresReview:    { type: Boolean, default: false },
  reviewedBy:        { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  reviewedAt:        { type: Date },
  reviewAction:      { type: String },              // 'approve' | 'reject'
  reviewNotes:       { type: String },
  rejectedReason:    { type: String },

  // ── Dispute Flow ─────────────────────────────────────────────────────────
  disputeEscalation: [{
    escalatedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    escalatedTo:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    escalationNotes: { type: String },
    escalatedAt:    { type: Date },
  }],
  disputeStatus:      { type: String },
  disputeResolvedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  disputeResolvedAt:  { type: Date },
  disputeDecision:    { type: String },
  disputeResolution:  { type: String },
  refundedAmount:     { type: Number, default: 0 },
  disputeReason:      String,
  mediatorId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  resolutionNotes:    String,

  // ── Merchant Assignment ──────────────────────────────────────────────────
  assignedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  assignedAt:      { type: Date },
  processingAt:    { type: Date },
  merchantPanelUrl: { type: String, default: null },

  // ── Merchant Scoring Audit ───────────────────────────────────────────────
  // How many minutes from ASSIGNED→PROCESSING (for rolling avg update)
  merchantResponseMinutes: { type: Number },

  // ── Escrow (SELL orders: user tokens locked on creation) ─────────────────
  // GOVERNANCE §1: lockedBalance on User is the wallet authority. These fields
  // are audit metadata only — the actual lock is via walletAuthority.service.js.
  escrowLocked:  { type: Boolean, default: false }, // true when tokens locked
  escrowAmount:  { type: Number,  default: 0 },     // tokens locked count

  // ── Dispute Metadata ─────────────────────────────────────────────────────
  disputeRaisedAt:    { type: Date },
  disputeRaisedBy:    { type: String, enum: ['user', 'merchant'] },
  disputeResolvedAt:  { type: Date },
  disputeResolvedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // ── Red-Flag / Fraud Guard ────────────────────────────────────────────────
  redFlagged:    { type: Boolean, default: false },
  redFlagReason: { type: String },
  redFlaggedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  redFlaggedAt:  { type: Date },

  // ── Withdrawal Batching ──────────────────────────────────────────────────
  bulkPayoutDate:  { type: Date },
  bulkPaidAt:      { type: Date },
  bulkPayoutBatch: { type: String },

  // ── Expiry (20-min window set at assignment) ─────────────────────────────
  expiresAt: { type: Date },

  // ── Merchant Snapshot ────────────────────────────────────────────────────
  // Immutable copy captured at assignment time. Dispute evidence.
  merchantSnapshot: {
    merchantId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant' },
    merchantName:  { type: String },
    // Which rail the merchant settled on at assignment time — tells the reader
    // which of the two credential sets below is the meaningful one.
    merchantType:  { type: String, enum: MERCHANT_CURRENCIES },
    upiId:         { type: String },
    qrCodeUrl:     { type: String },
    bankName:      { type: String },
    accountNo:     { type: String },
    ifsc:          { type: String },
    accountHolder: { type: String },
    usdtAddress:   { type: String },
    snapshotAt:    { type: Date },
    expiresAt:     { type: Date },
  },

  // ── Approval / Rejection Tracking ───────────────────────────────────────
  approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant' },
  approvedAt: { type: Date },
  rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant' },
  rejectedAt: { type: Date },

  // ── Cancellation Tracking ────────────────────────────────────────────────
  cancelReason: { type: String },
  cancelledAt:  { type: Date },

  // ── Warning Guard ────────────────────────────────────────────────────────
  warningIssued: { type: Boolean, default: false },

  // ── Timestamps ───────────────────────────────────────────────────────────
  createdAt:   { type: Date, default: Date.now, index: true },
  updatedAt:   { type: Date, default: Date.now },
  paidAt:      { type: Date },
  completedAt: { type: Date },
});

// ── HMAC binding (cryptographic order integrity) ──────────────────────────────
paymentOrderSchema.add({ orderHmac: { type: String, select: false } });
// Mongoose 9 (kareem 3) dropped the next() callback — synchronous hooks mutate
// the doc and return.
paymentOrderSchema.pre('save', function() {
  if (this.isModified('proofScreenshot')) {
    this.proofExpiresAt = this.proofScreenshot ? new Date(Date.now() + PAYMENT_PROOF_RETENTION_MS) : undefined;
  }
});
paymentOrderSchema.pre('save', setOrderHmacHook);

// ── Pre-save: keep amount alias in sync with fiatAmount ──────────────────────
// Compute token allocation split for new DEPOSIT orders from the active
// DepositPolicy (domains/configuration/depositPolicy.model.js, BBEPS §6.7) —
// read once, at order creation time, and locked into depositAllocation/
// reserveAllocation + depositPolicySnapshot on the order. Intentionally NOT
// re-read on later saves or at approval time: an order's split reflects the
// policy in effect when the user paid, so a later admin change never
// retroactively alters orders already in flight. This is the single
// computation site for the split — see merchant.routes.js POST
// /orders/:id/approve, which was fixed to consume these stored fields
// instead of recomputing its own hardcoded ratio (docs/governance/04-GOVERNANCE.md §2,
// "No second write path to a value with a designated single-writer service").
//
// Falls back to a hardcoded 90/10 ONLY if no DepositPolicy has been
// configured yet for this currency (fresh install, before an admin has
// created the first version) — logged loudly since this should be a
// transient bootstrap state, not steady-state behavior.
// Mongoose 9 (kareem 3) dropped the next() callback — an async hook returns a
// promise, and a THROW rejects it (mongoose surfaces the error), so the old
// try/catch → next(err) plumbing is no longer needed.
paymentOrderSchema.pre('save', async function () {
  if (this.fiatAmount !== undefined) {
    this.amount = this.fiatAmount;
  }
  if (this.isNew && this.type === 'DEPOSIT') {
    // The order's own rail — DepositPolicy is versioned per currency.
    const currency = this.currency || MERCHANT_CURRENCY.INR; // schema default: 'INR'
    const policy = await getActivePolicy(currency);

    let depositPercent, reservePercent, policyVersionId;
    if (policy) {
      depositPercent    = policy.depositAllocationPercent;
      reservePercent    = policy.reserveAllocationPercent;
      policyVersionId   = policy._id;
    } else {
      console.warn(`⚠️  No active DepositPolicy for ${currency} — falling back to 90/10. Configure one via PUT /api/admin/deposit-policy/${currency}.`);
      depositPercent = 90; reservePercent = 10;
    }

    // Spec 4.4 rounding rule — owned by the Risk Platform since Phase 010:
    // reserve share floored, remainder to deposit, full amount conserved.
    const split = computeReserveSplit(this.tokenAmount, reservePercent);
    this.depositAllocation = split.depositAllocation;
    this.reserveAllocation = split.reserveAllocation;
    this.depositPolicySnapshot = {
      policyVersionId,
      currency,
      depositAllocationPercent: depositPercent,
      reserveAllocationPercent: reservePercent,
    };
  }
});

// ── Indexes ───────────────────────────────────────────────────────────────────
paymentOrderSchema.index({ status: 1, type: 1, createdAt: 1 });
paymentOrderSchema.index({ status: 1, createdAt: -1, _id: -1 });
paymentOrderSchema.index({ merchantId: 1, status: 1, createdAt: -1, _id: -1 });
paymentOrderSchema.index({ userId: 1, createdAt: -1, _id: -1 });
paymentOrderSchema.index({ expiresAt: 1, status: 1 });
paymentOrderSchema.index({ bulkPayoutDate: 1, type: 1, status: 1 });
paymentOrderSchema.index({ proofExpiresAt: 1 }, { partialFilterExpression: { proofScreenshot: { $type: 'string' } } });
// Settlement worker sweep: only ever scans orders actually sitting in the hold,
// so the index stays tiny regardless of total order volume.
paymentOrderSchema.index(
  { merchantCreditHoldUntil: 1 },
  { partialFilterExpression: { merchantCreditStatus: 'HELD' } },
);

paymentOrderSchema.statics.scrubExpiredProofs = async function(now = new Date()) {
  const fallbackCutoff = new Date(now.getTime() - PAYMENT_PROOF_RETENTION_MS);
  const [expired, legacyExpired] = await Promise.all([
    this.updateMany(
      { proofScreenshot: { $exists: true, $ne: null, $type: 'string' }, proofExpiresAt: { $lte: now } },
      { $unset: { proofScreenshot: '', proofExpiresAt: '' }, $set: { updatedAt: now } }
    ),
    this.updateMany(
      {
        proofScreenshot: { $exists: true, $ne: null, $type: 'string' },
        proofExpiresAt: { $exists: false },
        createdAt: { $lte: fallbackCutoff },
      },
      { $unset: { proofScreenshot: '' }, $set: { updatedAt: now } }
    ),
  ]);
  return { modifiedCount: (expired.modifiedCount || 0) + (legacyExpired.modifiedCount || 0) };
};

// ── Exports ───────────────────────────────────────────────────────────────────

export const PaymentOrder = mongoose.model('PaymentOrder', paymentOrderSchema);


// resolve because models/index.js registers BOTH names against the same schema.
// When all call-sites are migrated, remove this alias.
