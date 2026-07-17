// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// FIX (Audit #38) — Added depositBalance, winningsBalance fields to User interface
// FIX (Audit #15) — GameState.CLOSED confirmed present (was already here, but calculateStatus didn't use it)

export enum CycleType {
  FULL_DAY   = 'FULL_DAY',
  THIRTY_MIN = '30_MIN'
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
  email?: string;              // optional contact email (notifications)
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
  kycData?: {
    nameOnAadhaar: string;
    aadhaarNumber: string;
    idProofUrl: string;
    photoUrl: string;
    submittedAt: number;
    rejectionReason?: string;
  };

  bankDetails?: {
    accountHolderName: string;
    accountNumber: string;
    ifscCode: string;
    bankName: string;
  };

  phantomAccess?: 'NONE' | '30_MIN' | 'FULL_DAY' | 'BOTH';
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
  aadharNumber: string;
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

export interface MerchantSnapshot {
  merchantId:    string;
  merchantName:  string;
  upiId:         string;
  bankName:      string;
  accountNo:     string;
  ifsc:          string;
  accountHolder: string;
  snapshotAt:    string;
  expiresAt:     string;
}

export interface PaymentOrder {
  id:                 string;
  _id:                string;
  orderId:            string;
  userId:             string;
  merchantId:         string | null;
  type:               'DEPOSIT' | 'WITHDRAWAL';
  tokenAmount:        number;
  fiatAmount:         number;
  rateUsed:           number;
  merchantProfit:     number;
  depositAllocation:  number;   // share of tokenAmount → depositBalance (DepositPolicy, admin-configurable)
  reserveAllocation:  number;   // share of tokenAmount → reserveBalance (DepositPolicy, admin-configurable)
  platformFeeRate:    number;   // 3% deducted on bet settlement
  status:             PaymentOrderStatus;
  escrowStatus:       'NONE' | 'LOCKED' | 'RELEASED' | 'REFUNDED';
  utrNumber?:         string;
  proofScreenshot?:   string;
  requiresVideoKYC:   boolean;
  merchantSnapshot?:  MerchantSnapshot;
  utrWarning?:        string;
  requiresReview:     boolean;
  warningIssued:      boolean;
  redFlagged:         boolean;
  bulkPayoutDate?:    string;
  bulkPayoutBatch?:   string;
  expiresAt?:         string;
  createdAt:          number | string;
  paidAt?:            string;
  completedAt?:       string;
}


export type PaymentOrder = PaymentOrder;

