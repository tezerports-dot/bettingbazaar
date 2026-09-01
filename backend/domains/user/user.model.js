// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import mongoose from 'mongoose';
import { setOrderHmacHook } from '../../middleware/order-crypto-access.js';

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, trim: true },
  mobile: { type: String, required: true, unique: true, index: true },

  // Players authenticate through Telegram and never set one; this stays for
  // admins, sub-admins and merchants, whose credentials must not depend on a
  // third party that can suspend an account. Absent = "cannot log in with a
  // password", which is the correct state for a player.
  passwordHash: { type: String, select: false },

  // ── Referral programme identity ─────────────────────────────────────────
  // Assigned once, when onboarding COMPLETES (contact shared + channel joined),
  // never at first contact — a half-finished signup must not consume a number.
  //
  // The payout queue is ordered by this, so it must be unique and strictly
  // increasing; it comes from an atomic counter, not from a count of documents.
  // `sparse` because accounts that predate the programme (and admin/merchant
  // rows) legitimately have none, and a plain unique index would collide on
  // every one of those nulls.
  joiningNumber: { type: Number, unique: true, sparse: true, index: true },
  // What a player shares. Distinct from joiningNumber so the public link does
  // not leak the platform's exact member count or a person's position in it.
  referralCode:  { type: String, unique: true, sparse: true, index: true },
  // How many distinct people opened this user's referral link (deduplicated per
  // viewer per day by ReferralClick). Held here rather than derived, because the
  // rows it counts are deleted continuously by TTL — the aggregate is the thing
  // that must survive, not the evidence.
  //
  // DECLARED, and that word is load-bearing: Mongoose strict mode strips
  // undeclared paths out of update operators without complaint, so a `$inc` on a
  // field that is not in this schema increments nothing and reports success.
  // Four separate bugs in this codebase have been exactly that.
  referralClicks: { type: Number, default: 0 },
  // Who referred them — the level-1 edge of the referral tree. The level-2 edge
  // is this user's referrer's own referredBy, walked at earning time.
  // (An index for this existed below long before the field itself did.)
  referredBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

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

  /*
   * REMOVED 2026-08-26 — `email`.
   *
   * A player's identity is their Aadhaar and the mobile behind their Telegram
   * account, and nothing else. The bot never asks for an email, so this field
   * was empty for every player who could ever exist; the only way to set one
   * was a profile form nobody had a reason to fill in.
   *
   * The Communication Platform's EMAIL channel went with it — a delivery
   * adapter whose only possible answer was "user has no email on file" is not
   * a channel, and keeping it meant carrying SMTP configuration and the
   * `nodemailer` dependency for a path that could not fire.
   *
   * Do not reintroduce a player email. Reaching a player means Telegram or an
   * in-app notification. `SupportLinks.email` is a different thing entirely —
   * that is the platform's own public contact address and it stays.
   */

  status: { type: String, enum: ['ACTIVE', 'BLOCKED', 'SUSPENDED', 'PENDING_KYC', 'DELETED'], default: 'ACTIVE', index: true },
  
  kycStatus: { type: String, enum: ['PENDING_SUBMISSION', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'], default: 'PENDING_SUBMISSION' },
  // ── KYC decision metadata, and nothing else ──────────────────────────────
  // The identity data itself lives in KycVerification (domains/identity/): the
  // Aadhaar as an HMAC for uniqueness plus an AES-256-GCM ciphertext for the
  // bulk export, both on a separate collection with its own access path. What
  // remains here is only what the platform reads to decide whether this user
  // may play and what to tell them if not.
  //
  // Removed 2026-08-25 along with the document-upload path: nameOnAadhaar,
  // aadhaarNumber, nameOnPAN, panNumber, idProofKey, photoKey, idProofUrl,
  // photoUrl. Nothing collects a name, a PAN, or a document any more — the bot
  // asks for the Aadhaar number and that is the whole submission.
  kycData: {
    submittedAt: Date,
    rejectionReason: String,
    // reviewedBy was MISSING from this schema while kycDecision.service.js and
    // reverseMirror.js both wrote `kycData.reviewedBy`. Mongoose drops an
    // unknown path in strict mode without erroring, so every approval stayed
    // anonymous — the precise defect kycDecision.service.js was written to fix,
    // fixed at the write and never at the schema.
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    /*
     * How many Aadhaar numbers this account has submitted, ever.
     *
     * A rejected player may reapply through the bot — a mistyped digit must not
     * be a dead account — but the retry has to be bounded, because
     * "submit a number, be told whether it is already registered" is an
     * enumeration oracle if it can be repeated freely. The cap turns it into a
     * correction path and not a probe.
     *
     * DECLARED, and that word is load-bearing here of all places: `kycData`
     * already lost `reviewedBy` to exactly this trap, and every approval stayed
     * anonymous because Mongoose drops an undeclared path from an update
     * without erroring.
     */
    submissionCount: { type: Number, default: 0 },
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
  // 'BOTH' predates the 1-minute block and means EVERY cycle type, not two of
  // them — the gate in bet.routes.js reads it as "skip the per-type check", so
  // it kept working when the third type arrived. Left named as it is because
  // renaming a stored enum value is a migration, and the behaviour is right.
  phantomAccess: {
    type: String,
    enum: ['NONE', '1_MIN', '30_MIN', 'FULL_DAY', 'BOTH'],
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

  // ── 2FA (TOTP — RFC 6238) ───────────────────────────────────────────────
  // Consolidated 2026-07-28. There used to be TWO parallel field pairs here,
  // `mfaEnabled`/`mfaSecret` and `twoFactorEnabled`/`twoFactorSecret`, and
  // NEITHER was ever written or read — the README advertised 2FA that did not
  // exist (LAUNCH_READINESS §F). The mfa* pair is gone; these are the live ones.
  //
  // `twoFactorSecret` holds the AES-256-GCM ciphertext from
  // domains/identity/totp.service.js, never the raw secret: it is a bearer
  // credential that cannot be hashed, because the server must recompute codes
  // from it.
  twoFactorEnabled: { type: Boolean, default: false },
  twoFactorSecret:  { type: String, select: false },

  // Set during enrolment and promoted to twoFactorSecret only once the user
  // proves they scanned the QR by entering a working code. Without this split,
  // a failed enrolment would leave an account requiring codes from an
  // authenticator entry the user never successfully added — a self-inflicted
  // lockout, and for the main admin an unrecoverable one.
  twoFactorPendingSecret: { type: String, select: false },

  // Highest TOTP step already spent. A code stays valid for its whole 30s step
  // plus the drift window, so without this the same six digits work more than
  // once — the exact window a shoulder-surfed or phished code needs.
  twoFactorLastCounter: { type: Number, select: false },

  twoFactorEnrolledAt: { type: Date },

  // SHA-256 hashes of single-use recovery codes. Not optional in practice:
  // 2FA is mandatory for admins, so a lost phone locks someone out of an
  // account that moves money, and the main admin has nobody above them to
  // reset it.
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

export const User = mongoose.model('User', userSchema);
