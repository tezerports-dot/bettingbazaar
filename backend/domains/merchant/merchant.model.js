// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';
import crypto from 'crypto';

export function generateMerchantPublicRef() {
  return `M${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
}

const merchantSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true },
  name: { type: String, required: true },
  publicRef: { type: String, required: true, default: generateMerchantPublicRef, immutable: true },
  // ✅ FIX #12/#13: Add missing auth + profile fields
  username: { type: String, index: true },
  mobile: { type: String, index: true },
  email: { type: String },
  password: { type: String, select: false },  // hashed, used for standalone merchant login
  status: { type: String, enum: ['ACTIVE', 'SUSPENDED', 'INACTIVE', 'PENDING', 'REJECTED'], default: 'PENDING', index: true },
  suspensionReason: { type: String },
  isOnline: { type: Boolean, default: false, index: true },
  acceptsDeposits: { type: Boolean, default: true },
  acceptsWithdrawals: { type: Boolean, default: true },
  // Which fiat/crypto rails this merchant can fulfil (Phase-audit 2026-07-09).
  // Admin-editable via PUT /merchants/:id/capabilities; ENFORCED in
  // merchantScoring.selectBestMerchant so an order is only offered to a
  // merchant that accepts its currency (no dead admin field — GOVERNANCE §2).
  acceptedCurrencies: { type: [String], enum: ['INR', 'USDT'], default: ['INR'], index: true },
  bankDetails: {
    accountHolderName: String,   
    upiId: String,
    bankName: String,
    accountNo: String,
    ifsc: String
  },
  usdtWalletAddress: { type: String, trim: true, uppercase: true },
  adminUsdtRate: { type: Number, default: 1, min: 0 },
  qrCodeUrl: String,
  limits: {
    minDeposit: { type: Number, default: 500 },
    maxDeposit: { type: Number, default: 50000 },
    minWithdraw: { type: Number, default: 500 },
    maxWithdraw: { type: Number, default: 50000 }
  },
  // ── MERCHANT WALLET (v5.0) ──────────────────────────────────────────────
  // Admin-funded token balance. Decrements on deposit confirm (merchant gives
  // tokens to user), increments on withdrawal confirm (merchant receives tokens
  // from user). No daily-limit concept — the wallet itself is the constraint.
  tokenBalance: { type: Number, default: 0, min: 0 },
  totalProcessedVolume: { type: Number, default: 0 },
  // ✅ FIX #13: Earnings and stats fields used throughout merchant routes
  earnings: { type: Number, default: 0 },
  totalDepositsProcessed: { type: Number, default: 0 },
  totalDepositAmount: { type: Number, default: 0 },
  totalWithdrawalsProcessed: { type: Number, default: 0 },
  totalWithdrawalAmount: { type: Number, default: 0 },
  rating: { type: Number, default: 5.0, min: 0, max: 5 },
  lastOnlineToggle: { type: Date },
  // ✅ FIXED: panelUrl lives on Merchant (not User). Admin sets via PUT /merchants/:id/panel-url.
  
  panelUrl: { type: String, default: '' },
  merchantApprovalStatus: {
    type: String,
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'],
    default: 'PENDING',
    index: true,
  },
  merchantApprovedBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  merchantApprovedAt:      { type: Date },
  merchantRejectionReason: { type: String },
  merchantStats: {
    monthlyProcessed:     { type: Number, default: 0 },
    dailyProcessed:       { type: Number, default: 0 },
    totalOrdersProcessed: { type: Number, default: 0 },
    lastResetDate:        { type: Date, default: Date.now },
  },
  minOrder:       { type: Number, default: 500 },
  maxOrder:       { type: Number, default: 50000 },
  // commissionRate removed — superseded by buy/sell rate spread model.
  // MerchantsList.tsx: 'commission handler removed — commission model dropped;
  //  merchants earn via spread.'

  // ── SCORING FIELDS (Section 1 authority: merchantScoring.service.js) ────────
  // All defaults match schema defaults — GOVERNANCE §5
  successRate:          { type: Number, default: 1.0 },     // ratio 0–1, updated per order
  avgResponseMinutes:   { type: Number, default: 2 },       // rolling avg ASSIGNED→PROCESSING
  disputeRate:          { type: Number, default: 0 },       // disputed/total ratio
  activeOrderCount:     { type: Number, default: 0 },       // increment on assign, decrement on finish
  maxConcurrentOrders:  { type: Number, default: 3 },       // total safety cap
  maxConcurrentDepositOrders:    { type: Number, default: null, min: 1, max: 10 }, // null => SystemConfig.merchantOrderLimits default
  maxConcurrentWithdrawalOrders: { type: Number, default: null, min: 1, max: 10 }, // null => SystemConfig.merchantOrderLimits default
  totalOrdersCompleted: { type: Number, default: 0 },       // lifetime completed counter
  totalOrdersAll:       { type: Number, default: 0 },       // lifetime counter for rate calculation

  createdAt: { type: Date, default: Date.now }
});

// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════

merchantSchema.pre('validate', function ensurePublicRef(next) {
  if (!this.publicRef) this.publicRef = generateMerchantPublicRef();
  next();
});

merchantSchema.index({ publicRef: 1 }, { unique: true, name: 'publicRef_1' });
merchantSchema.index({ 'bankDetails.upiId': 1 }, { unique: true, sparse: true });
merchantSchema.index({ 'bankDetails.accountNo': 1, 'bankDetails.ifsc': 1 }, { unique: true, sparse: true });
merchantSchema.index({ usdtWalletAddress: 1 }, { unique: true, sparse: true });

export const Merchant = mongoose.model('Merchant', merchantSchema);
