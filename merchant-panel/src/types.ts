// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)

/**
 * Settlement rail. A merchant is INR-only (UPI + bank) or USDT-only (TRC-20) —
 * never both. Mirrors the backend enum on Merchant.acceptedCurrencies and
 * PaymentOrder.currency (backend/domains/merchant/merchantCurrency.js,
 * MERCHANT_CURRENCIES). GOVERNANCE §4: this is the panel's only declaration of
 * the rail names; utils/rail.ts holds the behaviour that goes with them.
 */
export type MerchantRail = 'INR' | 'USDT';

export enum OrderStatus {
  PENDING_QUEUE = 'PENDING_QUEUE',
  ASSIGNED = 'ASSIGNED',
  PROCESSING = 'PROCESSING',
  PAID = 'PAID',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  REJECTED = 'REJECTED',
  DISPUTED = 'DISPUTED',
  FAILED = 'FAILED'
}

export enum PaymentMethod {
  UPI = 'UPI',
  IMPS = 'IMPS',
  NEFT = 'NEFT',
  RTGS = 'RTGS',
  BANK_TRANSFER = 'BANK_TRANSFER'
}

export enum EscrowStatus {
  NONE = 'NONE',
  LOCKED = 'LOCKED',
  RELEASED = 'RELEASED',
  REFUNDED = 'REFUNDED'
}

export interface BankDetails {
  accountNumber: string;
  ifscCode: string;
  bankName: string;
  accountHolderName: string;
}

export interface User {
  _id: string;
  id?: string;
  username: string;
  mobile?: string;
  email?: string;
  rating?: number;
  totalOrders?: number;
  realName?: string;
  aadhaarNumber?: string;
  kycDocumentUrl?: string;
  bankDetails?: BankDetails;
  status?: string;
  kycStatus?: string;
}

export interface ChatMessage {
  id: string;
  _id?: string;
  orderId: string;
  senderId: string;
  senderType: 'MERCHANT' | 'USER' | 'SYSTEM';
  senderRole?: 'MERCHANT' | 'USER' | 'SYSTEM';
  senderName?: string;
  message?: string;
  text?: string;
  attachmentUrl?: string;
  imageUrl?: string;
  isSystem?: boolean;
  timestamp: number | string;
  createdAt?: number | string;
}

export interface PaymentOrder {
  id: string;
  _id: string; // always present on orders from the backend (Mongo _id)
  orderId: string;
  shortId: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';

  // Settlement rail this order runs on. Mirrors PaymentOrder.currency
  // (backend/domains/payment/paymentOrder.model.js, enum ['INR','USDT'],
  // schema default 'INR'). A merchant only ever receives orders on their own
  // rail — see utils/rail.ts.
  currency?: MerchantRail;
  
  // Token and pricing (REAL from backend)
  tokenAmount: number;
  fiatAmount: number;
  amount: number; // alias for fiatAmount
  rateUsed: number;
  merchantProfit: number; // REAL profit calculated by backend
  
  // User information (REAL)
  userId: string | User;
  user?: User;
  userPhone?: string;
  userBankDetails?: BankDetails;
  upiId?: string; // user UPI ID stored on WITHDRAWAL orders
  // TRC-20 payout address on USDT WITHDRAWAL orders — the crypto counterpart
  // of userBankDetails (backend: PaymentOrder.userUsdtAddress).
  userUsdtAddress?: string;
  
  // Merchant information
  merchantId?: string;
  merchantSnapshot?: {
    merchantId?: string;
    merchantName?: string;
    merchantType?: MerchantRail;
    usdtAddress?: string;
    upiId?: string;
    qrCodeUrl?: string;
    bankName?: string;
    accountNo?: string;
    ifsc?: string;
    accountHolder?: string;
    snapshotAt?: string;
    expiresAt?: string;
  };
  
  // Status and escrow (REAL atomic transaction tracking)
  status: OrderStatus;
  escrowStatus?: EscrowStatus;
  
  // Payment details (REAL)
  paymentMethod?: PaymentMethod;
  utrNumber?: string;
  proofScreenshot?: string;
  transactionProof?: string;
  requiresVideoKYC?: boolean;
  
  // Queue and assignment (REAL queue manager data)
  assignedBy?: string;
  assignedAt?: Date | string | number;
  
  // Dispute handling (REAL)
  disputeReason?: string;
  mediatorId?: string;
  resolutionNotes?: string;
  
  // Timing (REAL timestamps)
  createdAt: number | string;
  updatedAt?: number | string;
  expiresAt?: number | string;
  paidAt?: Date | string | number;
  completedAt?: Date | string | number;
  
  
  chatHistory?: ChatMessage[];
  
  // Other
  rejectionReason?: string;
  bbTokenAmount?: number; // alias for tokenAmount
}

export interface MerchantProfile {
  id: string;
  _id?: string;
  username: string;
  email: string;
  mobile: string;
  isOnline: boolean;
  isApproved?: boolean;
  status?: string;
  role?: string;

  // ── Settlement rail (exclusive) ──────────────────────────────────────────
  // 'INR' (UPI + bank) or 'USDT' (TRC-20) — never both. Backend authority is
  // Merchant.acceptedCurrencies, which holds exactly one entry;
  // GET /api/merchant/profile surfaces both the array and this scalar.
  merchantType?: MerchantRail;
  acceptedCurrencies?: MerchantRail[];
  usdtWalletAddress?: string;
  
  // Preferences (REAL from backend)
  acceptsDeposits?: boolean;
  acceptsWithdrawals?: boolean;
  orderPreferences?: {
    acceptDeposits?: boolean;
    acceptWithdrawals?: boolean;
  };
  
  // Pricing (set by admin)
  prices?: {
    buyPrice: number;
    sellPrice: number;
  };
  
  // Balances (REAL)
  walletBalance?: number;
  fiatBalance?: number;
  tokenBalance?: number;  // BB token wallet — funded by admin, shown on Dashboard
  
  // Limits (REAL from backend Merchant.limits)
  limits?: {
    minDeposit?: number;
    maxDeposit?: number;
    minWithdraw?: number;
    maxWithdraw?: number;
  };
  
  // Settlement credentials as stored on the Merchant document — this is the
  // shape GET /api/merchant/profile returns (backend formatMerchant).
  // `settlementDetails` below is an older alias kept for compatibility.
  bankDetails?: {
    accountHolderName?: string;
    upiId?: string;
    bankName?: string;
    accountNo?: string;
    ifsc?: string;
  };
  qrCodeUrl?: string;

  // Settlement details
  settlementDetails?: {
    upiId?: string;
    upiQrCodeUrl?: string;
    accountName?: string;
    accountNumber?: string;
    ifsc?: string;
    bankName?: string;
  };
  
  // Stats (REAL from backend)
  earnings?: number; // Total lifetime earnings
  totalDepositsProcessed?: number;    // completed deposit order count
  totalDepositAmount?: number;        // completed deposit volume
  totalWithdrawalsProcessed?: number; // completed withdrawal order count
  totalWithdrawalAmount?: number;     // completed withdrawal volume
  totalProcessedVolume?: number;
  rating?: number; // Merchant rating

  // Scoring figures maintained by merchantScoring.service.js (read-only here)
  successRate?: number;        // ratio 0-1
  avgResponseMinutes?: number;
  disputeRate?: number;        // ratio 0-1
  totalOrdersCompleted?: number;
  minOrder?: number;
  maxOrder?: number;
  
  stats?: {
    todayVolume?: number;
    todayEarnings?: number;
    completedOrders?: number;
    pendingOrders?: number;
    totalEarnings?: number;
    weekVolume?: number;
    monthVolume?: number;
  };
  
  createdAt?: Date | string;
}

export interface AuthResponse {
  success: boolean;
  token: string;
  user?: MerchantProfile;
  merchant?: MerchantProfile;
  /** Password accepted, second factor still owed. `success` is false here. */
  twoFactorRequired?: boolean;
  challengeToken?: string;
  /** The challenge aged out (5 min) — the password leg must be redone. */
  twoFactorExpired?: boolean;
  /** Set when an approved merchant has not yet enrolled a second factor. */
  mustEnroll2FA?: boolean;
  message?: string;
}

export interface LoginCredentials {
  mobile: string;
  password: string;
  loginType?: string;
}

export interface Earnings {
  today: number;
  week: number;
  month: number;
  total: number;
  lifetime?: {
    deposits: {
      count: number;
      totalAmount: number;
      totalFees: number;
    };
    withdrawals: {
      count: number;
      totalAmount: number;
      totalFees: number;
    };
    totalEarnings: number;
  };
  pending?: number;
}

export interface Stats {
  pending: number;
  processing: number;
  completedToday: number;
  todayOrders?: number;
  weekOrders?: number;
  monthOrders?: number;
  todayEarnings?: number;
  weekEarnings?: number;
  monthEarnings?: number;
  successRate?: number;
  avgResponseMinutes?: number;
  disputeRate?: number;
  activeOrderCount?: number;
  maxConcurrentOrders?: number;
  totalOrdersCompleted?: number;
  totalOrdersAll?: number;
  averageOrderValue?: number;
}

export interface Transaction {
  id: string;
  orderId: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  amount: number;
  status: OrderStatus;
  createdAt: string | number;
  user?: User;
  merchantProfit?: number;
}

export interface Notification {
  id: string;
  type: 'ORDER' | 'PAYMENT' | 'SYSTEM';
  title: string;
  message: string;
  read: boolean;
  createdAt: string | number;
  orderId?: string;
}

export interface Dispute {
  id: string;
  orderId: string;
  reason: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
  mediatorId?: string;
  resolutionNotes?: string;
  createdAt: string | number;
}

export interface Settlement {
  id: string;
  merchantId: string;
  amount: number;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED';
  createdAt: string | number;
}
