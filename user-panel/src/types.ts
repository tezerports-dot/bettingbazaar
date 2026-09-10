// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// FIX (Audit #38) — Added depositBalance, winningsBalance fields to User interface
// FIX (Audit #15) — GameState.CLOSED confirmed present (was already here, but calculateStatus didn't use it)

export enum CycleType {
  FULL_DAY   = 'FULL_DAY',
  THIRTY_MIN = '30_MIN',
  /** 60-second block. Same game and same chips as the 30-minute one, and the
   *  only difference is the clock — see GAME_CORE.PHASE.ONE_MIN. */
  ONE_MIN    = '1_MIN'
}

export enum BettingSide {
  DELHI  = 'DELHI',
  BOMBAY = 'BOMBAY'
}

export enum GameState {
  OPEN             = 'OPEN',
  MERGED           = 'MERGED',
  CLOSED           = 'CLOSED',
  RESULT_DECLARED  = 'RESULT_DECLARED',
  PAUSED           = 'PAUSED',
  CANCELLED        = 'CANCELLED'
}

export interface User {
  id: string;
  mobile: string;
  username: string;
  walletBalance: number;       
  lockedBalance: number;

  // FIX (Audit #38): dual balance system fields — backend uses these, not walletBalance
  depositBalance: number;      // NON-WITHDRAWABLE: can only be used for betting
  winningsBalance: number;     // WITHDRAWABLE: from bet payouts, can be withdrawn

  walletAddress: string;
  profilePic?: string;
  isAdmin?: boolean;
  isMerchant?: boolean;
  isQueueManager?: boolean;
  isMediator?: boolean;
  status: 'ACTIVE' | 'BLOCKED' | 'SUSPENDED' | 'PENDING_KYC';

  mfaEnabled?: boolean;
  mfaSecret?: string;

  kycStatus: 'PENDING_SUBMISSION' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
  // The API sends only the rejection reason, and only when the status is
  // REJECTED — see backend domains/user/kycPublicData.js. There is no name,
  // Aadhaar number or document reference to send: identity is captured by the
  // Telegram bot and held in a separate collection this panel never reads.
  kycData?: {
    rejectionReason?: string;
  };

  bankDetails?: {
    accountHolderName: string;
    accountNumber: string;
    ifscCode: string;
    bankName: string;
  };

  // 'BOTH' predates the 1-minute block and means EVERY type — the server gate
  // reads it as "skip the per-type check" (backend/domains/user/user.model.js).
  phantomAccess?: 'NONE' | '1_MIN' | '30_MIN' | 'FULL_DAY' | 'BOTH';
  joinedAt: number;
  lastLogin: number;
}

export interface Bet {
  id: string;
  userId: string;
  amount: number;
  side: BettingSide;
  cycleId: string;
  timestamp: number;
  status: 'PENDING' | 'WON' | 'LOST' | 'REFUNDED';
  payout?: number;
  isPhantom?: boolean;
}

export interface GameCycle {
  id: string;          // This is the backend's cycleId (e.g. 30MIN_1234567890)
  type: CycleType;
  startTime: number;
  endTime: number;
  status: GameState;
  // Server-authoritative countdown, pushed via cycle_update every 100ms.
  // timeRemainingMs = millisecond precision (use for smooth display).
  // timeRemaining   = integer seconds (backwards compat).
  // Components MUST display these — never derive countdown from endTime locally.
  timeRemainingMs: number;
  timeRemaining: number;
  totalDelhi: number;
  totalBombay: number;
  realDelhi: number;
  realBombay: number;
  phantomDelhi: number;
  phantomBombay: number;
  phantomBalanced: boolean;
  winner?: BettingSide;
  pendingResult?: BettingSide;
  declaredAt?: number;
  isPaused?: boolean;
}

export interface Transaction {
  id: string;
  userId: string;
  // FE 4.5 FIX: BET_PLACE → BET_PLACED (typo), added BET_REFUND; REJECTED removed (not a valid Transaction status)
  type: 'DEPOSIT' | 'WITHDRAWAL' | 'BET_WIN' | 'BET_LOSS' | 'BET_PLACED' | 'BET_REFUND' | 'ADMIN_ADJUSTMENT' | 'ESCROW_LOCK' | 'ESCROW_RELEASE';
  amount: number;
  timestamp: number;
  description: string;
  // FE 4.5 FIX: REJECTED removed — not a valid Transaction status
  status: 'SUCCESS' | 'PENDING' | 'FAILED';
  merchantId?: string;
  merchantName?: string;
  method?: string;
  adminId?: string;
}

export interface Winner {
  id: string;
  username: string;
  amount: number;
  profilePic: string;
  cycleId: string;
}

export enum AdminRole {
  OWNER     = 'OWNER',
  ADMIN     = 'ADMIN',
  MODERATOR = 'MODERATOR',
  AUDITOR   = 'AUDITOR'
}

export interface AdminUser {
  id: string;
  username: string;
  role: AdminRole;
  permissions: string[];
  mfaEnabled: boolean;
  mfaSecret?: string;
  backupCodes?: string[];
}

export interface AuditLog {
  id: string;
  adminId: string;
  action: string;
  targetId?: string;
  details: string;
  timestamp: number;
  ip: string;
}

export interface DashboardMetrics {
  activeUsers: number;
  totalVolume: number;
  todaysRevenue: number;
  activeBetsCount: number;
  systemHealth: 'HEALTHY' | 'DEGRADED' | 'DOWN';
}

export type PromoLocation = 'HOME_POPUP' | 'TRICKS_PAGE' | 'RULES_PAGE';
export type MediaType     = 'IMAGE' | 'VIDEO';

export interface PromoContent {
  id: string;
  title: string;
  description?: string;
  location: PromoLocation;
  mediaType: MediaType;
  fileUrl: string;
  status: 'ACTIVE' | 'INACTIVE';
  priority: number;
  createdAt: number;
  scheduledStart?: number;
  scheduledEnd?: number;
}


export interface MerchantProfile {
  id: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED';
  isOnline: boolean;
  acceptsDeposits: boolean;
  acceptsWithdrawals: boolean;
  bankDetails: {
    upiId: string;
    bankName: string;
    accountNo: string;
    ifsc: string;
  };
  qrCodeUrl?: string;
  limits: {
    minDeposit: number;
    maxDeposit: number;
    minWithdraw: number;
    maxWithdraw: number;
  };
  dailyCap: number;
  currentDailyVolume: number;
  totalProcessedVolume: number;
}

export interface ChatMessage {
  id: string;
  orderId: string;
  senderId: string;
  senderName: string;
  text: string;
  attachmentUrl?: string;
  timestamp: number;
  isSystem?: boolean;
}


export interface KYCRecord {
  userId: string;
  fullName: string;
  aadhaarNumber: string;
  aadharNumber?: string; // deprecated typo alias, kept for migration compatibility
  status: 'PENDING' | 'VERIFIED' | 'REJECTED';
  submittedAt: number;
}

export interface SystemConfigData {
  latestVersion: string;
  minVersion: string;
  maintenanceMode: boolean;
  maintenanceMessage?: string;
  androidUrl?: string;
  iosUrl?: string;
  webUrl?: string;
}

// ── Payment Order (Merchant Payment Processing domain) ───────────────────────


export type PaymentOrderStatus =
  | 'PENDING_QUEUE'
  | 'ASSIGNED'
  | 'PROCESSING'
  | 'PAID'
  | 'COMPLETED'
  | 'DISPUTED'
  | 'CANCELLED'
  | 'FAILED'
  | 'REJECTED';

/**
 * Where to pay, and nothing about who is being paid.
 *
 * This was `MerchantSnapshot`, and it declared the merchant's `upiId`,
 * `bankName`, `accountNo`, `ifsc` and `accountHolder`. A field the panel's type
 * names is a field somebody will render — and these were rendered, with a Copy
 * button on the handle.
 *
 * The server sends this instead: a per-order payment link, an opaque reference
 * that names nobody, and the deadline. See
 * backend/domains/payment/playerOrderView.js, which is the only shape of an
 * order a player receives.
 */
export interface PayTo {
  paymentLink?: string;
  /** `Merchant #<publicRef>` — a label for support, identifying no one. */
  merchantRef?: string;
  expiresAt?: string;
}

export interface PaymentOrder {
  id:                 string;
  _id:                string;
  orderId:            string;
  userId:             string;
  type:               'DEPOSIT' | 'WITHDRAWAL';
  tokenAmount:        number;
  fiatAmount:         number;
  rateUsed:           number;
  status:             PaymentOrderStatus;
  escrowStatus:       'NONE' | 'LOCKED' | 'RELEASED' | 'REFUNDED';
  utrNumber?:         string;
  proofScreenshot?:   string;
  // ── What this interface stopped declaring, and why ────────────────────────
  // `merchantId`, `merchantSnapshot`, `merchantProfit`, `depositAllocation`,
  // `reserveAllocation`, `platformFeeRate`, `requiresVideoKYC`,
  // `requiresReview`, `warningIssued` and `redFlagged`. (`bulkPayoutDate` and
  // `bulkPayoutBatch` were named here too, until the bulk-payout feature and
  // its columns were removed on 2026-09-10.)
  //
  // None of them is sent to a player, and several must never be: the merchant's
  // identity and credentials, the platform's own treasury split and fee, and the
  // risk verdicts on the player themselves — a player told they are red-flagged
  // is a player told to change behaviour before an investigation finishes.
  //
  // They were declared here anyway, which is the `User._id` failure exactly: the
  // interface was the thing that was wrong, so every read typechecked and was
  // `undefined` at runtime. `playerOrderView.js` is the authority for this shape
  // and refuses all of them.
  payTo?:             PayTo | null;
  expiresAt?:         string;
  createdAt:          number | string;
  paidAt?:            string;
  completedAt?:       string;
}
