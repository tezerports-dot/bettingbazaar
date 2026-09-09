// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)

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

// ── The settlement rail ──────────────────────────────────────────────────────
// The platform runs one of two P2P rails and an admin switches between them.
// Backend authority: database/repositories/paymentModePolicy.js, whose CHECK is
// what makes these the only two. Orders already held keep the rail they were
// created on — see order_states.payment_mode, which the database refuses to
// change.
export type PaymentMode = 'P2P_UPI' | 'CASH_ATM';

export interface PaymentModeTimers {
  assignmentWaitSeconds: number;
  processingWindowSeconds: number;
  utrSubmitSeconds: number;
  disputeWindowSeconds: number;
  linkExpirySeconds: number;
  linkMinRemainingSeconds: number;
}

export interface PaymentModeView {
  activeMode: PaymentMode | null;
  version: number | null;
  label: string;
  merchantMessage: string;
  timers: PaymentModeTimers | null;
}

// ── The ATM cash rail ────────────────────────────────────────────────────────
// A merchant stands at a machine, initiates a UPI cash withdrawal, and supplies
// the payment link it produces. A player pays that link, the ATM dispenses, and
// the merchant collects the notes.
export interface CashLink {
  linkId: string;
  paymentLink: string;
  expiresAt: string;
}

export interface CashLinkState {
  approved: boolean;
  /** In RUPEES, and exactly one — a merchant serves a single denomination. */
  denomination: number | null;
  live: CashLink | null;
  /** Orders waiting at THIS merchant's denomination, and no other. */
  waiting: number;
  /**
   * The SERVER's answer to "is a trip worth making". Never derived on the
   * client from `waiting`: a merchant without the tokens to serve the order
   * cannot take it however close the machine is, and an expired link earns
   * them nothing.
   */
  worthGoing: boolean;
}

/**
 * A completed cash payout whose CDM slip has not been submitted.
 *
 * The confirm completes the order and the receipt is chased afterwards, so the
 * moment to submit passes — an upload that failed or an app closed at the
 * machine leaves the order gone from every screen. This is the way back to it.
 *
 * Deliberately not a `PaymentOrder`: three facts, and the player is not among
 * them. It is also NOT a way to read a submitted receipt — a row appearing here
 * means one is still owed, and a row that disappears is all the merchant ever
 * learns about the one they sent.
 */
export interface OutstandingCdmReceipt {
  orderId: string;
  /** The cash the merchant deposited, in RUPEES. */
  fiatAmount: number;
  completedAt: string;
}

export interface PaymentOrder {
  id: string;
  _id: string; // always present on orders from the backend (the public id)
  orderId: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';

  // Settlement rail this order runs on. Mirrors PaymentOrder.currency
  // (backend/domains/payment/paymentOrder.model.js, enum ['INR','USDT'],
  // schema default 'INR'). A merchant only ever receives orders on their own
  // rail — see utils/rail.ts.
  currency?: MerchantRail;

  // The settlement PROCESS this order was born under, stamped at creation and
  // never rewritten. Not the same question as `currency`: that is what the
  // money is denominated in, this is how it moves.
  //
  // Branch on THIS, never on the live policy. An admin can switch rails at any
  // moment and both then run side by side until the last pre-flip order
  // settles, so an order held across a switch keeps asking for what it always
  // asked for. Sent by backend/domains/merchant/merchantOrderView.js.
  paymentMode?: PaymentMode;
  // On a USDT order, the chain the PLAYER chose to send on. The merchant has to
  // watch the right network — a payment on BNB Smart Chain never appears in a
  // Tron explorer — and it decides which of their addresses is shown.
  usdtChain?: 'TRC20' | 'BEP20';
  
  // Token and pricing (REAL from backend)
  tokenAmount: number;
  fiatAmount: number;
  amount: number; // alias for fiatAmount
  rateUsed: number;
  merchantProfit: number; // REAL profit calculated by backend
  
  // User information (REAL)
  userId: string | User;
  // The ONLY thing that identifies a player to a merchant, and only on a
  // WITHDRAWAL: the account the payout goes to and the name on it. The phone
  // number and the player's UPI ID are deliberately absent — see
  // backend/domains/merchant/merchantOrderView.js, which is the authority for
  // this shape and will not send them.
  userBankDetails?: BankDetails;
  
  // Merchant information
  merchantId?: string;
  
  // Status and escrow (REAL atomic transaction tracking)
  status: OrderStatus;
  escrowStatus?: EscrowStatus;
  
  // Payment details (REAL)
  paymentMethod?: PaymentMethod;
  utrNumber?: string;
  proofScreenshot?: string;
  transactionProof?: string;
  
  // Queue and assignment
  assignedAt?: Date | string | number;
  
  // Dispute handling (REAL)
  disputeReason?: string;
  resolutionNotes?: string;
  
  // Timing (REAL timestamps)
  createdAt: number | string;
  updatedAt?: number | string;
  expiresAt?: number | string;
  paidAt?: Date | string | number;
  completedAt?: Date | string | number;
  
  
  chatHistory?: ChatMessage[];
  
  // Other
  rejectedReason?: string;
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
  // 'INR' (UPI + bank) or 'USDT' — never both. Backend authority is
  // Merchant.acceptedCurrencies, which holds exactly one entry;
  // GET /api/merchant/profile surfaces both the array and this scalar.
  merchantType?: MerchantRail;
  acceptedCurrencies?: MerchantRail[];
  // One address PER CHAIN. They are separate networks — USDT sent to a Tron
  // address from a BEP-20 wallet is gone — so a merchant holds an address for
  // each chain they will be paid on, and receives orders only on those.
  usdtAddressTrc20?: string;
  usdtAddressBep20?: string;
  /** Which chains this merchant can actually be paid on. Derived by the server. */
  usdtChains?: ('TRC20' | 'BEP20')[];
  
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

/**
 * A request to buy platform tokens from the platform, paid in USDT.
 *
 * Mirrors `toOrder` in database/repositories/paymentConfig.js — the mapper that
 * emits it — per CLAUDE.md §5. `tokenAmount` is in whole tokens (the row holds
 * paise); `usdtAmount` is the USDT the merchant sent, at `usdtRate` INR/USDT
 * frozen when the request was filed.
 */
export interface AdminTokenOrder {
  orderId: string;
  merchantId: string;
  tokenAmount: number;
  usdtRate: number | null;
  usdtAmount: number | null;
  usdtTxHash: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  requestedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
}

/**
 * What the server says an amount costs, read before the request exists.
 *
 * A refusal arrives as `ok: false` with the reason and (when the amount merely
 * fell outside the band) the bounds, so the screen can show the merchant what
 * would be accepted while they are still typing.
 */
export interface AdminTokenQuote {
  ok: boolean;
  message?: string;
  usdtRate?: number;
  usdtAmount?: number;
  minPurchaseUsdt?: number;
  maxPurchaseUsdt?: number;
}
