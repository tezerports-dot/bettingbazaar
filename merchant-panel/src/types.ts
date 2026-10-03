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
  bankDetails?: BankDetails;
  status?: string;
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

// ── The process an ORDER settles under ───────────────────────────────────────
// Stamped on the order at creation from the order itself — a CASH buy (INR up
// to the platform's cash ceiling) is CASH_ATM, a larger INR order P2P_UPI — and
// never rewritten: the database refuses to change order_states.payment_mode.
// There is no platform-wide switch any more; the rail belongs to the order and
// to the team that serves it. Backend authority: PAYMENT_MODES in
// database/repositories/orderRails.js (§5: change them together).
export type PaymentMode = 'P2P_UPI' | 'CASH_ATM';

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
  // money is denominated in, this is how it moves. Branch on THIS — it is the
  // order's own answer. Sent by backend/domains/merchant/merchantOrderView.js.
  paymentMode?: PaymentMode;
  // On a CASH buy, the cash machine's QR this member scanned and when (Step
  // 2d); null until they scan. Sent by merchantOrderView.js.
  cashLink?: string | null;
  cashLinkAt?: string | null;
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
  /** A buy this member rejected as unpaid: until when the player may dispute it (`merchantOrderView.js`, 2c+). */
  disputeWindowUntil?: string | null;
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
  
  // No balance of any kind: a merchant holds no tokens — their team's pool
  // does, and its supervisor sees it on the Team page (§3.10). formatMerchant
  // sends none.
  //
  // Set when the platform stopped offering them new buy orders (three unpaid in
  // a row); null otherwise. GET /api/merchant/profile, formatMerchant.
  assignmentPausedAt?: string | null;
  // A CASH team member's Ready: at the machine and free for a cash buy. Only a
  // Ready member is offered one, and being assigned one switches it off — so
  // this is re-read from the profile, never toggled locally. formatMerchant.
  cashReady?: boolean;
  
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

  // Settlement details
  settlementDetails?: {
    upiId?: string;
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

  // Figures maintained by the order lifecycle (recordCompletedOrder in
  // database/repositories/merchants.js) — read-only here.
  successRate?: number;        // ratio 0-1
  avgResponseMinutes?: number;
  disputeRate?: number;        // ratio 0-1
  totalOrdersCompleted?: number;
  
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

/**
 * What a merchant earned, as `getEarnings` returns it.
 *
 * ── Every field here is one the server actually sends ─────────────────────
 * It declared `week`, `month` and `pending` as well, and a `lifetime` shape of
 * `{deposits, withdrawals, totalEarnings}`. The server sends
 * `{totalEarnings, totalVolume, totalOrders}` and has never sent the other
 * three: `week` and `month` were literal zeroes assigned in the mapper, and
 * `pending` came from `merchants.earnings_paise`, a column nothing writes.
 *
 * §23 — a type that lies is worse than no type. Every one of those typechecked
 * and was `undefined` at runtime, so nothing could tell a reader that a figure
 * they were about to render did not exist.
 */
export interface Earnings {
  /** Commission credited today, from the ledger. Rupees, 1:1 with tokens. */
  today: number;
  /** Commission credited over the requested range — lifetime when unbounded. */
  total: number;
  lifetime?: {
    /** Commission actually issued: `MERCHANT_BONUS_ISSUED` events. */
    totalEarnings: number;
    /**
     * Matched volume, in TOKENS on both rails — never the order's own currency,
     * which on a USDT order is USDT and cannot be added to a rupee order
     * (trap 15).
     */
    totalVolume: number;
    /** COMPLETED orders only. A PAID order is money that has not moved yet. */
    totalOrders: number;
  };
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

// ── Supervisors and teams (redesign Step 2a) ─────────────────────────────────
// Mirrors database/repositories/teams.js (`toTeam`, `toMember`) and the
// GET /api/merchant/team response — §5: change them together.
export type SupervisorRail = 'CASH' | 'UPI_BANK' | 'USDT';
export interface Team {
  teamId: string; supervisorId: string; supervisorName: string; supervisorRef: string;
  name: string; rail: SupervisorRail; approvedCount: number; pendingCount: number; size: number;
  strength: 'WORKING' | 'GRACE' | 'STOPPED'; shortSince: string | null; wasFull: boolean; createdAt: string;
  /** The team's token pool, in paise (Step 2b). */
  poolAvailablePaise: number; poolHeldPaise: number;
}
// Team token pools (Step 2b). Mirrors `toPool`, `toEntry`, `toRequest` and
// POOL_DIRECTIONS in database/repositories/teamPools.js — §5.
export type PoolDirection = 'BUY' | 'SELL';
export interface TeamPool { teamId: string; availablePaise: number; heldPaise: number; totalPaise: number }
export interface TeamPoolEntry {
  id: number; kind: 'ADMIN_SALE' | 'ADMIN_BUYBACK'; availableDeltaPaise: number; heldDeltaPaise: number;
  availableAfterPaise: number; heldAfterPaise: number; createdAt: string;
}
export interface TeamPoolRequest {
  requestId: string; teamId: string; direction: PoolDirection; tokenAmountPaise: number;
  status: 'PENDING' | 'FULFILLED' | 'REJECTED' | 'CANCELLED';
  note: string | null; decisionNote: string | null; decidedAt: string | null; createdAt: string;
}
export interface TeamMember {
  merchantId: string; teamId: string; name: string; publicRef: string;
  status: 'PENDING' | 'APPROVED'; isOnline: boolean;
}
export type MyTeam =
  | { role: 'SUPERVISOR'; rail: SupervisorRail; publicRef: string; teams: Team[]; members: TeamMember[]; poolRequests: TeamPoolRequest[] }
  | { role: 'MEMBER'; publicRef: string; status: 'PENDING' | 'APPROVED'; team: Team }
  | { role: 'NONE'; publicRef: string };
