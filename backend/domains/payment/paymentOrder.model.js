// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Payment (BBEPS Phase 003 §3.3). Moved from backend/models/paymentOrder.model.js
// on 2026-07-01 (BBEPS Phase 004 migration).

import mongoose from 'mongoose';
import { setOrderHmacHook } from '../../middleware/order-crypto-access.js';

const paymentOrderSchema = new mongoose.Schema({
  orderId:        { type: String, required: true, unique: true },
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true, index: true },
  merchantId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', index: true },

  type:           { type: String, enum: ['DEPOSIT', 'WITHDRAWAL'], required: true },

  // ── Token & Pricing ─────────────────────────────────────────────────────
  // 90/10 token allocation: 90% deposited to depositBalance, 10% to reserveBalance
  // 97/3 betting deduction:  3% platform fee deducted on settlement
  tokenAmount:    { type: Number, required: true },   // BB tokens to transfer
  fiatAmount:     { type: Number, required: true },   // INR user pays/receives
  amount:         { type: Number },                   // alias = fiatAmount (set on save)
  rateUsed:       { type: Number, required: true },   // buy or sell rate used
  merchantProfit: { type: Number, default: 0 },       // (buyRate - sellRate) * tokenAmount
  merchantFee:    { type: Number, default: 0 },       // fee paid to merchant

  // ── Token Allocation (90/10) ─────────────────────────────────────────────
  // On DEPOSIT completion:
  //   depositAllocation  = tokenAmount * 0.90  → user.depositBalance
  //   reserveAllocation  = tokenAmount * 0.10  → platform reserve
  depositAllocation: { type: Number, default: 0 },
  reserveAllocation: { type: Number, default: 0 },

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
paymentOrderSchema.pre('save', function (next) {
  if (this.fiatAmount !== undefined) {
    this.amount = this.fiatAmount;
  }
  // Compute token allocation split (90/10) for new DEPOSIT orders
  if (this.isNew && this.type === 'DEPOSIT') {
    this.depositAllocation = Math.floor(this.tokenAmount * 0.90);
    this.reserveAllocation  = this.tokenAmount - this.depositAllocation;
  }
  next();
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
