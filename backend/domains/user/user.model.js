// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';
import { setOrderHmacHook } from '../../middleware/order-crypto-access.js';

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, trim: true },
  mobile: { type: String, required: true, unique: true, index: true }, 
  
  passwordHash: { type: String, select: false },
  
  // ✅ DUAL BALANCE SYSTEM (CRITICAL FIX #4)
  // depositBalance: NON-WITHDRAWABLE (can only be used for betting)
  // winningsBalance: WITHDRAWABLE (from bet payouts)
  depositBalance: { 
    type: Number, 
    default: 0, 
    min: [0, 'Deposit balance cannot be negative'] 
  },
  winningsBalance: { 
    type: Number, 
    default: 0, 
    min: [0, 'Winnings balance cannot be negative'] 
  },
  lockedBalance: { 
    type: Number, 
    default: 0, 
    min: 0 
  },
  
  // Track composition of locked balance (for proper refunds)
  lockedDepositAmount: { type: Number, default: 0 },
  lockedWinningsAmount: { type: Number, default: 0 },

  // ✅ RESERVE BALANCE (Migration Spec Section 3 & 4)
  // Funded at 10% of token purchase. Consumed at 3% per bet. Not withdrawable.
  reserveBalance: {
    type: Number,
    default: 0,
    min: [0, 'Reserve balance cannot be negative'],
  },

  // ✅ WARNING ENGINE (Migration Spec Section 13)
  // Incremented on merchant reject or dispute loss. Auto-blocks at threshold (3).
  warningCount: {
    type: Number,
    default: 0,
    min: 0,
  },

  // ✅ PAYMENT-COMPLAINT FLAG (owner directive 2026-07-14)
  // Set true the moment a merchant complains a claimed payment failed / wasn't
  // received (merchant reject of a PAID/PROCESSING order). Distinct from the
  // hidden warningCount: this is an EXPLICIT, queryable flag support/admin can
  // see and filter on. Cleared by an admin on unblock/clear-flags.
  paymentFlagged:    { type: Boolean, default: false },
  paymentFlagReason: { type: String,  default: '' },
  paymentFlaggedAt:  { type: Date,    default: null },
  paymentFlagCount:  { type: Number,  default: 0, min: 0 },

  
  
  walletAddress: { type: String, unique: true, sparse: true }, 
  profilePic: { type: String, default: '' },

  // Optional contact email (Phase E, 2026-07-10) — delivery target for the
  // Communication Platform's EMAIL channel. Not collected at registration
  // (mobile is the identity); users without one are skipped by the adapter.
  email: { type: String, trim: true, lowercase: true, default: '' },
  
  status: { type: String, enum: ['ACTIVE', 'BLOCKED', 'SUSPENDED', 'PENDING_KYC', 'DELETED'], default: 'ACTIVE', index: true },
  
  kycStatus: { type: String, enum: ['PENDING_SUBMISSION', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'], default: 'PENDING_SUBMISSION' },
  kycData: {
    nameOnAadhaar: String,   
    aadhaarNumber: String,   
    nameOnPAN: String,
    panNumber: String,
    idProofUrl: String,
    photoUrl: String,
    submittedAt: Date,
    rejectionReason: String
  },

  bankDetails: {
    accountHolderName: String,
    accountNumber: String,
    ifscCode: String,
    bankName: String
  },

  isAdmin: { type: Boolean, default: false },
  // NOTE: NO isMerchant field here. Merchants are a completely separate entity.
  // Merchant auth uses the Merchant model (domains/merchant/merchant.routes.js /auth/login → Merchant JWT).
  // The merchantAuth middleware checks decoded.isMerchant in the Merchant JWT claim — 
  // that is a JWT field, NOT a User schema field. Never mix them.
  isQueueManager: { type: Boolean, default: false }, 
  isMediator: { type: Boolean, default: false }, 
  
  // ✅ PHANTOM MANAGER ACCESS (FIX #2, #6)
  // Assigned by admin - can place phantom bets on cycles
  phantomAccess: { 
    type: String, 
    enum: ['NONE', '30_MIN', 'FULL_DAY', 'BOTH'], 
    default: 'NONE' 
  },

  // SUB-ADMIN SUPPORT
  isSubAdmin: { type: Boolean, default: false },
  subAdminPermissions: {
    canVerifyKYC: { type: Boolean, default: false },
    canManageSupport: { type: Boolean, default: false },
    canResolveDisputes: { type: Boolean, default: false },
    canViewTransactions: { type: Boolean, default: false },
    canManageUsers: { type: Boolean, default: false },
    canManageMerchants: { type: Boolean, default: false },
    canManageContent: { type: Boolean, default: false },
    canViewAnalytics: { type: Boolean, default: false }
  },

  // 2FA/MFA SUPPORT
  mfaEnabled: { type: Boolean, default: false },
  mfaSecret: { type: String, select: false },
  twoFactorSecret: { type: String, select: false },
  twoFactorEnabled: { type: Boolean, default: false },
  backupCodes: [{ type: String, select: false }],

  // ROLES ARRAY (for flexible role management)
  roles: [{ type: String, enum: ['user', 'admin', 'subadmin', 'merchant', 'queue_manager', 'mediator'], default: ['user'] }],

  // BLOCK/BAN SUPPORT
  isBlocked: { type: Boolean, default: false },
  blockReason: { type: String },
  blockedAt: { type: Date },
  blockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  
  // Merchant approval/stats/limits moved to Merchant schema

  // ENHANCED SUB-ADMIN PERMISSIONS
  subAdminRole: {
    type: String,
    enum: ['PHANTOM_MANAGER', 'PHANTOM_EQUALIZER', 'USER_OPS', 'MERCHANT_OPS', 'CONTENT_MANAGER', 'ANALYST', 'CUSTOM'],
    default: 'CUSTOM'
  },

  lastLogin: { type: Date, default: Date.now },
  joinedAt: { type: Date, default: Date.now }
});

// Virtual properties for balance calculations
userSchema.virtual('totalAvailableBalance').get(function() {
  return (this.depositBalance || 0) + (this.winningsBalance || 0) + (this.reserveBalance || 0);
});

userSchema.virtual('totalBalance').get(function() {
  return (this.depositBalance || 0) + (this.winningsBalance || 0) + (this.reserveBalance || 0) + (this.lockedBalance || 0);
});

// ── Indexes for hot query paths (added 2026-07-09, audit) ────────────────────
// mobile/status/walletAddress are already indexed inline above. These cover
// the remaining scanned paths: referral-tree lookups (referredBy — 7 call
// sites), the KYC admin queue (kycStatus), username lookups, and admin
// listing/pagination by signup date. Without these, each query full-scans
// the users collection — unacceptable past a few thousand users.
userSchema.index({ referredBy: 1 });
userSchema.index({ kycStatus: 1 });
userSchema.index({ username: 1 });
userSchema.index({ createdAt: -1 });

// Hybrid money DB (plan step 2 + step 7): KYC fields mirror to Postgres
// user_kyc from day one; KYC becomes AUTHORITATIVE there LAST, after wallet/
// ledger/payment/UTR are proven (plan's cutover order). Only KYC-touching
// saves mirror — profile/balance saves don't.
userSchema.pre('save', function () {
  this.$locals.kycTouched = this.isNew || this.isModified('kycStatus') || this.isModified('kycData');
});
import { mirrorUserKyc } from '../../postgres/dualWrite.js';
userSchema.post('save', (doc) => { if (doc.$locals?.kycTouched) mirrorUserKyc(doc); });

export const User = mongoose.model('User', userSchema);
