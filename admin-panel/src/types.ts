// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// ═══════════════════════════════════════════════════════════════════════════
// 🎯 COMPLETE TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// Authentication & Users
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All 8 sub-admin permissions and what they control:
 *
 * canVerifyKYC        → /kyc page: approve and reject user KYC submissions
 * canManageUsers      → /users page: view users, block/unblock, adjust balance
 * canManageMerchants  → /merchants page: view, suspend/activate, update limits
 * canResolveDisputes  → dispute resolution on payment orders
 * canViewTransactions → /transactions page (read-only)
 * canViewAnalytics    → dashboard, profit & loss, cycle history, live cycles
 * canManageContent    → FAQ manager, support links, CDN images, branding
 * canManagePhantom    → phantom access assignment (set on sub-admin account itself)
 */
export interface SubAdminPermissions {
  canVerifyKYC: boolean;
  canManageUsers: boolean;
  canManageMerchants: boolean;
  canResolveDisputes: boolean;
  canViewTransactions: boolean;
  canViewAnalytics: boolean;
  canManageContent: boolean;
  canManageSupport: boolean; // kept for back-compat — maps to canManageContent
}

export interface Admin {
  _id: string;
  id?: string;
  username: string;
  mobile: string;
  email?: string;
  role: 'admin' | 'subadmin' | 'queue_manager';
  isAdmin: boolean;
  isSubAdmin: boolean;
  isQueueManager: boolean;
  // permissions is populated for sub-admins from subAdminPermissions on the User document
  permissions?: SubAdminPermissions;
  profilePic?: string;
  lastLogin?: string;
  createdAt?: string;
}

export interface User {
  _id: string;
  username: string;
  mobile: string;
  email?: string;

  depositBalance: number;
  winningsBalance: number;
  lockedBalance: number;
  lockedDepositAmount: number;
  lockedWinningsAmount: number;

  walletAddress?: string;
  profilePic?: string;

  status: 'ACTIVE' | 'BLOCKED' | 'SUSPENDED' | 'PENDING_KYC';
  kycStatus: 'PENDING_SUBMISSION' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';

  kycData?: {
    nameOnAadhaar: string;
    aadhaarNumber: string;
    panNumber: string;
    idProofUrl: string;
    photoUrl: string;
    submittedAt: string;
    rejectionReason?: string;
  };

  bankDetails?: {
    accountHolderName: string;
    accountNumber: string;
    ifscCode: string;
    bankName: string;
  };

  phantomAccess: 'NONE' | '30_MIN' | 'FULL_DAY' | 'BOTH';

  roles: string[];
  subAdminPermissions?: Record<string, boolean>;

  isQueueManager: boolean;
  isMediator: boolean;
  isMerchant: boolean;
  merchantApprovalStatus?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

  joinedAt: string;
  lastLogin: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cycles
// ─────────────────────────────────────────────────────────────────────────────

export type CycleType = '30_MIN' | 'FULL_DAY';
export type CycleStatus =
  | 'OPEN'
  | 'MERGED'
  | 'CLOSED'
  | 'RESULT_DECLARED'
  | 'COMPLETED'
  | 'PAUSED'
  | 'CANCELLED';

export interface Cycle {
  _id: string;
  cycleId: string;
  type: CycleType;
  startTime: number; // Unix ms timestamp
  endTime: number;   // Unix ms timestamp
  status: CycleStatus;

  realDelhi: number;
  realBombay: number;
  phantomDelhi: number;
  phantomBombay: number;
  totalDelhi: number;
  totalBombay: number;

  phantomBalanced: boolean;
  phantomBetsClosed: boolean;

  winner?: 'DELHI' | 'BOMBAY';
  winnerDetermined: boolean;
  winnerDeterminedAt?: string;

  isSettled: 'PENDING' | 'PROCESSING' | 'COMPLETED';
  settledAt?: string;
  totalPaidOut?: number;
  netProfit?: number; // = loserSideBets - winnerSideBets (house revenue)
}

export interface Bet {
  _id: string;
  userId: string;
  cycleId: string;
  amount: number;
  side: 'DELHI' | 'BOMBAY';
  fromDepositBalance: number;
  fromWinningsBalance: number;
  isPhantom: boolean;
  phantomManagerId?: string;
  status: 'PENDING' | 'WON' | 'LOST' | 'REFUNDED';
  timestamp: string;
  settledAt?: string;
  payout?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deposit Policy — Business Policy Platform (BBEPS Phase 006)
// Whole-document versioned: every version is a complete, self-consistent
// snapshot (deposit%/reserve% always sum to 100 within one version). See
// backend/domains/configuration/depositPolicy.model.js for the source of truth.
// ─────────────────────────────────────────────────────────────────────────────

export type DepositPolicyCurrency = 'INR' | 'USDT';

export interface DepositPolicyReserveUsageRules {
  withdrawable: boolean;
  settlementBuffer: boolean;
  notes: string;
}

export interface DepositPolicyVersion {
  _id: string;
  currency: DepositPolicyCurrency;
  depositAllocationPercent: number;
  reserveAllocationPercent: number;
  merchantCommissionPercent: number;
  commissionFundingSource: 'PLATFORM';
  reserveUsageRules: DepositPolicyReserveUsageRules;
  version: number;
  status: 'PENDING_APPROVAL' | 'SCHEDULED' | 'ACTIVE' | 'SUPERSEDED' | 'ROLLED_BACK' | 'REJECTED';
  approvalStatus: 'AUTO_APPROVED' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
  effectiveAt: string;
  appliedAt?: string;
  isRollback: boolean;
  rollbackOfVersionId?: string;
  businessJustification: string;
  changedBy: string | { _id: string; username: string };
  changedByName?: string;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token Rates
// ─────────────────────────────────────────────────────────────────────────────

export interface TokenRates {
  _id: string;
  buyRate: number;
  sellRate: number;
  updatedAt: string;
  updatedBy?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Merchants
// Merchants earn from the buy/sell rate SPREAD (merchantProfit on PaymentOrder).
// There is no commission % — do not show or edit a commission rate.
// ─────────────────────────────────────────────────────────────────────────────

export interface Merchant {
  _id: string;
  userId: string;
  name: string;
  mobile: string;
  email?: string;
  status: 'ACTIVE' | 'SUSPENDED';
  merchantApprovalStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
  isOnline: boolean;
  acceptsDeposits: boolean;
  acceptsWithdrawals: boolean;
  merchantStats: {
    dailyProcessed: number;
    monthlyProcessed: number;
    totalOrdersProcessed: number;
  };
  createdAt: string;
}

export interface MerchantProfile extends Merchant {
  statistics: {
    totalOrders: number;
    completedOrders: number;
    failedOrders: number;
    successRate: number;
  };
}

export interface MerchantTransaction {
  _id: string;
  orderId: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  tokenAmount: number;
  fiatAmount: number;
  rateUsed: number;
  status: string;
  userId: string;
  userName: string;
  createdAt: string;
  completedAt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payment Orders & Queue
// ─────────────────────────────────────────────────────────────────────────────

export type OrderStatus =
  | 'PENDING_QUEUE'
  | 'ASSIGNED'
  | 'PROCESSING'
  | 'PAID'
  | 'COMPLETED'
  | 'DISPUTED'
  | 'CANCELLED'
  | 'FAILED';

export interface PaymentOrder {
  _id: string;
  orderId: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  userId: string;
  userName: string;
  userMobile: string;
  merchantId?: string;
  merchantName?: string;
  tokenAmount: number;
  fiatAmount: number;
  rateUsed: number;
  merchantProfit: number; // = (buyRate - sellRate) * tokenAmount
  status: OrderStatus;
  assignedBy?: string;
  assignedAt?: string;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transactions
// ─────────────────────────────────────────────────────────────────────────────

// FE 4.6 FIX: WIN_PAYOUT removed (not a valid backend type), ESCROW types added
export type TransactionType =
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'BET_PLACED'
  | 'BET_WIN'
  | 'BET_LOSS'
  | 'BET_REFUND'
  | 'ADMIN_ADJUSTMENT'
  | 'ESCROW_LOCK'
  | 'ESCROW_RELEASE';

export interface Transaction {
  _id: string;
  // userId may be populated as { _id, username, mobile } when fetched via admin route
  userId: string | { _id: string; username: string; mobile: string };
  type: TransactionType;
  amount: number;
  balanceType: 'DEPOSIT' | 'WINNINGS' | 'BOTH';
  // FE 4.6 FIX: COMPLETED removed — not a valid Transaction status
  status: 'SUCCESS' | 'PENDING' | 'FAILED';
  referenceId?: string;
  description: string;
  timestamp: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Branding & Content
// ─────────────────────────────────────────────────────────────────────────────

export interface Branding {
  _id: string;
  appName: string;
  logo: string;
  icon: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  tagline: string;
  description: string;
  contactEmail?: string;
  contactPhone?: string;
  lastUpdated: string;
  updatedBy?: string;
}

export interface CDNImage {
  _id: string;
  url: string;
  category: 'promo' | 'banner' | 'avatar' | 'kyc' | 'payment_proof' | 'logo' | 'icon' | 'other';
  title: string;
  description?: string;
  tags: string[];
  mimeType: string;
  fileSize: number;
  dimensions: { width: number; height: number };
  uploadedBy: string;
  uploadedAt: string;
}

export interface FAQ {
  _id: string;
  question: string;
  answer: string;
  category: 'general' | 'account' | 'betting' | 'payments' | 'kyc' | 'security' | 'technical';
  order: number;
  isPublished: boolean;
  views: number;
  createdAt: string;
  updatedAt: string;
}

export interface SupportLinks {
  _id: string;
  email?: string;
  phone?: string;
  whatsapp?: string;
  telegram?: string;
  instagram?: string;
  facebook?: string;
  twitter?: string;
  youtube?: string;
  supportHours: string;
  responseTime: string;
  updatedAt: string;
}

export interface PromoContent {
  _id: string;
  title: string;
  description?: string;
  location: 'HOME_POPUP' | 'TRICKS_PAGE' | 'RULES_PAGE';
  mediaType: 'IMAGE' | 'VIDEO';
  fileUrl: string;
  priority: number;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Analytics & Dashboard
// ─────────────────────────────────────────────────────────────────────────────

export interface DashboardStats {
  users: { total: number; active: number; blocked: number; kycPending: number };
  merchants: { total: number; active: number; pending: number; online: number };
  finance: {
    totalDeposits: number;
    totalWithdrawals: number;
    totalBets: number;
    totalPayouts: number;
    netProfit: number;
    tokenBuy?: number;   // token purchase volume — present when backend returns it
    tokenSell?: number;  // token redemption volume — present when backend returns it
  };
  cycles: { activeCount: number; todayCount: number; totalBets: number };
  queue: { pendingOrders: number; avgWaitTime: number };
}

export interface FinancialStats {
  totalRevenue: number;
  totalExpenses: number;
  netProfit: number;
  profitMargin: number;
  deposits: { count: number; amount: number };
  withdrawals: { count: number; amount: number };
  bets: { count: number; amount: number };
  payouts: { count: number; amount: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// API Response Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
}
