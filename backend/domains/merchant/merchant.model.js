// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';
import crypto from 'crypto';
import {
  MERCHANT_CURRENCY,
  MERCHANT_CURRENCIES,
  isTrc20Address,
  merchantTypeOf,
} from './merchantCurrency.js';

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

  // ── TOTP 2FA (mandatory for merchants, owner directive 2026-07-29) ────────
  // Deliberately the SAME field names as the User schema. Merchants are a
  // separate collection with their own login and their own PASETO, but the
  // second-factor logic (drift window, replay guard, recovery codes) is
  // identical — identity/verifySecondFactor.js operates on either document.
  // Naming these differently would have forced a second copy of that logic,
  // and two copies of an anti-replay guard is how one of them goes stale.
  //
  // A merchant account settles real INR and USDT, so it is not a
  // player-grade credential: enrolment is required before the account can be
  // used, enforced at login rather than merely offered.
  twoFactorEnabled: { type: Boolean, default: false },
  twoFactorSecret:  { type: String, select: false },   // AES-256-GCM ciphertext
  twoFactorPendingSecret: { type: String, select: false },
  twoFactorLastCounter:   { type: Number, select: false },
  twoFactorEnrolledAt:    { type: Date },
  backupCodes: [{ type: String, select: false }],      // sha256 hashes, single use

  status: { type: String, enum: ['ACTIVE', 'SUSPENDED', 'INACTIVE', 'PENDING', 'REJECTED'], default: 'PENDING', index: true },
  suspensionReason: { type: String },
  isOnline: { type: Boolean, default: false, index: true },
  acceptsDeposits: { type: Boolean, default: true },
  acceptsWithdrawals: { type: Boolean, default: true },
  // Which rail this merchant settles on (Phase-audit 2026-07-09; made EXCLUSIVE
  // 2026-07-27). A merchant is either an INR merchant (UPI + bank) or a USDT
  // merchant (TRC-20) — never both, so every merchant has exactly one set of
  // payment credentials and one currency of order to reason about. Kept as an
  // array (not renamed to a scalar) because it is already the field enforced by
  // merchantScoring.selectBestMerchant and the admin capabilities route — the
  // `merchantType` virtual below is the read-only scalar view for panels
  // (GOVERNANCE §4: extend the existing field, do not add a second authority).
  // Admin-editable via PUT /merchants/:id/capabilities.
  acceptedCurrencies: {
    type: [String],
    enum: MERCHANT_CURRENCIES,
    default: [MERCHANT_CURRENCY.INR],
    index: true,
    validate: {
      validator: (v) => Array.isArray(v) && v.length === 1 && MERCHANT_CURRENCIES.includes(v[0]),
      message: `A merchant settles on exactly one rail — acceptedCurrencies must be ["INR"] or ["USDT"].`,
    },
  },
  bankDetails: {
    accountHolderName: String,
    upiId: String,
    bankName: String,
    accountNo: String,
    ifsc: String
  },
  // TRC-20 (Tron) address. NOT uppercased: Tron addresses are base58, which is
  // case-sensitive — uppercasing silently corrupts an address and USDT sent to
  // a corrupted address is unrecoverable (fixed 2026-07-27).
  usdtWalletAddress: {
    type: String,
    trim: true,
    validate: {
      validator: (v) => !v || isTrc20Address(v),
      message: 'usdtWalletAddress must be a TRC-20 (Tron) address: 34 base58 characters starting with "T".',
    },
  },
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

// merchantType — DERIVED read-only view of the single rail in
// acceptedCurrencies, for panels that want a scalar ('INR' | 'USDT') rather
// than an array. Deliberately a virtual, not a stored field: a second stored
// copy would be a second authority for the same value (GOVERNANCE §1/§4).
merchantSchema.virtual('merchantType').get(function () {
  return merchantTypeOf(this);
});
merchantSchema.set('toObject', { virtuals: true });
merchantSchema.set('toJSON',   { virtuals: true });

merchantSchema.pre('validate', function ensurePublicRef(next) {
  if (!this.publicRef) this.publicRef = generateMerchantPublicRef();
  next();
});

merchantSchema.index({ publicRef: 1 }, { unique: true, name: 'publicRef_1' });
merchantSchema.index({ 'bankDetails.upiId': 1 }, { unique: true, sparse: true });
merchantSchema.index({ 'bankDetails.accountNo': 1, 'bankDetails.ifsc': 1 }, { unique: true, sparse: true });
merchantSchema.index({ usdtWalletAddress: 1 }, { unique: true, sparse: true });

export const Merchant = mongoose.model('Merchant', merchantSchema);
