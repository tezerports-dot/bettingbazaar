// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Payment (BBEPS Phase 003 §3.3). Moved from backend/models/paymentOrder.model.js
// on 2026-07-01 (BBEPS Phase 004 migration).

import mongoose from 'mongoose';
import { setOrderHmacHook } from '../../middleware/order-crypto-access.js';
import { getActivePolicy } from '../configuration/depositPolicy.service.js';

const paymentOrderSchema = new mongoose.Schema({
  orderId:        { type: String, required: true, unique: true },
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true, index: true },
  merchantId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', index: true },

  type:           { type: String, enum: ['DEPOSIT', 'WITHDRAWAL'], required: true },

  // ── Token & Pricing ─────────────────────────────────────────────────────
  // Token allocation split and merchant commission are governed by the active
  // DepositPolicy for this order's currency (domains/configuration/depositPolicy.model.js,
  // BBEPS §6.7 Business Policy) — currency is implicitly 'INR' today (see
  // depositPolicySnapshot.currency default below; add a real `currency` field
  // to this schema once a non-INR deposit flow actually exists).
  // 97/3 betting deduction:  3% platform fee deducted on settlement
  tokenAmount:    { type: Number, required: true },   // BB tokens to transfer
  fiatAmount:     { type: Number, required: true },   // INR user pays/receives
  amount:         { type: Number },                   // alias = fiatAmount (set on save)
  rateUsed:       { type: Number, required: true },   // buy or sell rate used
  merchantProfit: { type: Number, default: 0 },       // (buyRate - sellRate) * tokenAmount
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
  // the split above (and what commission terms were in effect), independent
  // of whatever the policy is later changed to. Mirrors the existing
  // `rateUsed` snapshot pattern for TokenRates. merchantCommissionPercent /
  // commissionFundingSource are captured for future settlement/payout
  // reconciliation — no code yet reads them to actually pay a merchant
  // commission (see depositPolicy.service.js file header).
  depositPolicySnapshot: {
    policyVersionId:           { type: mongoose.Schema.Types.ObjectId, ref: 'DepositPolicy' },
    currency:                  { type: String, default: 'INR' },
    depositAllocationPercent:  { type: Number },
    reserveAllocationPercent:  { type: Number },
    merchantCommissionPercent: { type: Number },
    commissionFundingSource:   { type: String },
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

  // ── User Identity ────────────────────────────────────────────────────────
  userPhone:       String,
  userKycSnapshot: {
    pan:  String,
    name: String,
  },
  userBankDetails: {
    accountNumber:     String,
    ifscCode:          String,
    bankName:          String,
    accountHolderName: String,
  },

  // ── Payment Proof ────────────────────────────────────────────────────────
  requiresVideoKYC: { type: Boolean, default: false },
  utrNumber:        String,
  proofScreenshot:  String,

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
    upiId:         { type: String },
    qrCodeUrl:     { type: String },
    bankName:      { type: String },
    accountNo:     { type: String },
    ifsc:          { type: String },
    accountHolder: { type: String },
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
// instead of recomputing its own hardcoded ratio (04-GOVERNANCE.md §2,
// "No second write path to a value with a designated single-writer service").
//
// Falls back to a hardcoded 90/10 ONLY if no DepositPolicy has been
// configured yet for this currency (fresh install, before an admin has
// created the first version) — logged loudly since this should be a
// transient bootstrap state, not steady-state behavior.
paymentOrderSchema.pre('save', async function (next) {
  try {
    if (this.fiatAmount !== undefined) {
      this.amount = this.fiatAmount;
    }
    if (this.isNew && this.type === 'DEPOSIT') {
      const currency = 'INR'; // only currency this flow supports today — see schema note above
      const policy = await getActivePolicy(currency);

      let depositPercent, reservePercent, commissionPercent, fundingSource, policyVersionId;
      if (policy) {
        depositPercent    = policy.depositAllocationPercent;
        reservePercent    = policy.reserveAllocationPercent;
        commissionPercent = policy.merchantCommissionPercent;
        fundingSource     = policy.commissionFundingSource;
        policyVersionId   = policy._id;
      } else {
        console.warn(`⚠️  No active DepositPolicy for ${currency} — falling back to 90/10. Configure one via PUT /api/admin/deposit-policy/${currency}.`);
        depositPercent = 90; reservePercent = 10; commissionPercent = 0; fundingSource = 'PLATFORM';
      }

      // Spec 4.4: remainder (0 or 1 token from the floor()) goes to deposit, never reserve.
      this.reserveAllocation = Math.floor(this.tokenAmount * (reservePercent / 100));
      this.depositAllocation = this.tokenAmount - this.reserveAllocation;
      this.depositPolicySnapshot = {
        policyVersionId,
        currency,
        depositAllocationPercent: depositPercent,
        reserveAllocationPercent: reservePercent,
        merchantCommissionPercent: commissionPercent,
        commissionFundingSource: fundingSource,
      };
    }
    next();
  } catch (err) {
    next(err);
  }
});

// ── Indexes ───────────────────────────────────────────────────────────────────
paymentOrderSchema.index({ status: 1, type: 1, createdAt: 1 });
paymentOrderSchema.index({ merchantId: 1, status: 1 });
paymentOrderSchema.index({ expiresAt: 1, status: 1 });
paymentOrderSchema.index({ bulkPayoutDate: 1, type: 1, status: 1 });

// ── Exports ───────────────────────────────────────────────────────────────────
export const PaymentOrder = mongoose.model('PaymentOrder', paymentOrderSchema);


// resolve because models/index.js registers BOTH names against the same schema.
// When all call-sites are migrated, remove this alias.
