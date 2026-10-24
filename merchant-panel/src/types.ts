// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)

export enum OrderStatus {
  PENDING_QUEUE = 'PENDING_QUEUE',
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

  // The currency the order is paid in (`order_states.currency`,
  // backend/domains/payment/orderCurrency.js). Always INR here: USDT buys are
  // paid to the platform and never reach a merchant (CLAUDE.md §25).
  currency?: 'INR';

  // The settlement PROCESS this order was born under, stamped at creation and
  // never rewritten. Not the same question as `currency`: that is what the
  // money is denominated in, this is how it moves. Branch on THIS — it is the
  // order's own answer. Sent by backend/domains/merchant/merchantOrderView.js.
  paymentMode?: PaymentMode;
  // On a CASH buy, the cash machine's QR this member scanned and when (Step
  // 2d); null until they scan. Sent by merchantOrderView.js.
  cashLink?: string | null;
  cashLinkAt?: string | null;
  
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
  // On a sell: the UPI link that pays the player this order's exact amount,
  // built by the server from their UPI ID (owner, 2026-10-21); drawn as a QR.
  payoutUpiLink?: string;
  
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

  // A merchant account's order (owner, 2026-10-11; merchantOrderView.js):
  // who serves it, the payment account a buy is paid into, and the one a sell
  // was paid from — the merchant's own accounts, by id.
  inrRouting?: 'AGENTS' | 'MERCHANTS' | null;
  payAccountId?: string | null;
  paidFromAccountId?: string | null;
  /**
   * Whether this member may still decline it: a started order nobody can have
   * paid on yet (merchantOrderView.js `canDecline`, from `mayChangeHands`).
   */
  canDecline?: boolean;
}

export interface MerchantProfile {
  id: string;
  _id?: string;
  username: string;
  email: string;
  mobile: string;
  isOnline: boolean;
  /**
   * A supervisor runs teams and takes no orders (CLAUDE.md §2: never a
   * member), so they have no online switch and no order preferences; the
   * server refuses both (`SUPERVISOR_TAKES_NO_ORDERS`). Sent by
   * `formatMerchant` (backend/domains/merchant/merchant.routes.js) on
   * /profile and in the login answer.
   */
  isSupervisor?: boolean;
  isApproved?: boolean;
  status?: string;
  role?: string;

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
  // The bank account a BANK buy is paid into.
  bankDetails?: {
    accountHolderName?: string;
    bankName?: string;
    accountNo?: string;
    ifsc?: string;
  };
  // The UPI ID a UPI buy's link is built from (owner, 2026-10-21), never a mobile.
  upiId?: string | null;

  // Settlement details
  settlementDetails?: {
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
  /** Ratio 0-1 of decided orders that succeeded (`bb_merchant_track_record`); null before any is decided. */
  successRate?: number | null;
  ordersSucceeded?: number;
  ordersFailed?: number;
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

  // ── Who is signed in (owner, 2026-10-11) ─────────────────────────────────
  // Sent BESIDE `merchant` on GET /profile (merchant.routes.js), not inside it,
  // and merged in by `getMerchantProfile` (services/api.ts) so every screen
  // reads one object. `actor` also arrives on the login answer (roles only).
  actor?: MerchantActor;
  /** Whether this merchant runs a merchant account (a DIRECT team). GET /profile only. */
  isMerchantAccount?: boolean;
}

export interface AuthResponse {
  success: boolean;
  token?: string;
  user?: MerchantProfile;
  merchant?: MerchantProfile;
  code?: string;
  message?: string;
  /** Who signed in: the owner, or a merchant account's sub-member (routes.js `issueMerchantSession`). */
  actor?: MerchantActor;
}

/**
 * A Mini App link the server opened for a challenge
 * (backend/domains/identity/telegramChallenge.service.js `openChallenge`).
 */
export interface TelegramLink {
  url: string;
  /** The same link addressed to the Telegram app (`tg://resolve`, telegramClient.miniAppAppLink). */
  appUrl?: string;
  botUsername: string;
  expiresAt: string;
}

/** `GET /api/telegram/mini-app?panel=MERCHANT` (backend miniApp.routes.js). */
export interface MiniAppSetup {
  success: boolean;
  available: boolean;
  botUsername: string;
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
  /** This merchant's team commission share today. Tokens (1 token = ₹1). */
  today: number;
  /** Their shares over the requested range — lifetime when unbounded. */
  total: number;
  lifetime?: {
    /** Their shares actually recorded: `team_commission_shares` rows. */
    totalEarnings: number;
    /**
     * Matched volume, in TOKENS (trap 15).
     */
    totalVolume: number;
    /** COMPLETED orders only. A PAID order is money that has not moved yet. */
    totalOrders: number;
    /** The same completed orders by direction (`merchantEarnings`, stats.js). Tokens. */
    deposits: { count: number; totalVolume: number };
    withdrawals: { count: number; totalVolume: number };
  };
}

export interface Stats {
  /** Where the tokens are (merchant.routes.js GET /stats). Absent when the read failed. */
  money?: MerchantMoney;
  /**
   * The team's commission (`toSummary`, sent by GET /stats as `commission`):
   * null for a merchant not working in a team (a supervisor, an agent not yet
   * approved). Absent when the read failed.
   */
  commission?: TeamCommissionSummary | null;
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
// No USDT team: USDT buys are paid to the platform (owner, 2026-10-18).
export type SupervisorRail = 'CASH' | 'UPI_BANK';
export interface Team {
  teamId: string; supervisorId: string; supervisorName: string; supervisorRef: string;
  name: string; rail: SupervisorRail; approvedCount: number; pendingCount: number; size: number;
  /** WORKING with at least one approved member, else STOPPED (a team works with 1–10; Phase A). */
  strength: 'WORKING' | 'STOPPED'; createdAt: string;
  /** The team's token pool, in paise (Step 2b). */
  poolAvailablePaise: number; poolHeldPaise: number;
  /** What the held tokens are held for, and the sells on their way in. */
  poolExposure: PoolExposure;
  /** Size, left, consumed and sell room (`toPoolStanding`, teamPools.js). */
  poolStanding: PoolStanding;
  /** Cash out and the pause after it (`toCashOut`, teamCashOut.js). */
  cashOut: CashOut;
  /** Team commission (Step 2e): `toSummary` in database/repositories/teamCommission.js. */
  commission: TeamCommissionSummary;
  /** Sent on a supervisor's own teams (`GET /api/merchant/team`). */
  poolTrades?: PoolTradeTotals;
}
// Order commission (owner, 2026-10-21). Mirrors `toSummary` and
// `listCommissions` in database/repositories/teamCommission.js — §5. Paise throughout.
export interface TeamCommissionSummary {
  teamId: string; buysPaise: number; sellsPaise: number;
  paidPaise: number; owedPaise: number;
  /** The rule, from the server: of each completed buy and sell, and the supervisor's part of each payment. */
  depositPercent: number; withdrawalPercent: number; supervisorSharePercent: number;
}
export interface TeamCommission {
  commissionId: string; teamId: string; orderId: string | null; orderType: 'DEPOSIT' | 'WITHDRAWAL' | null;
  basePaise: number; commissionPercent: number | null;
  commissionPaise: number; mySharePaise: number; createdAt: string;
}
// Team token pools (Step 2b). Mirrors `toPool`, `toEntry`, `toRequest` and
// POOL_DIRECTIONS in database/repositories/teamPools.js — §5.
/** Pools only buy from the platform (owner, 2026-10-21; `POOL_DIRECTIONS`, teamPools.js). */
export type PoolDirection = 'BUY';
export interface TeamPool { teamId: string; availablePaise: number; heldPaise: number; totalPaise: number }
export interface TeamPoolEntry {
  id: number;
  kind: 'ADMIN_SALE' | 'ADMIN_BUYBACK' | 'BUY_HOLD' | 'BUY_RELEASE' | 'BUY_PAID' | 'SELL_SETTLED' | 'SELL_REVERSED' | 'COMMISSION';
  availableDeltaPaise: number; heldDeltaPaise: number;
  availableAfterPaise: number; heldAfterPaise: number; createdAt: string;
}
export interface TeamPoolRequest {
  requestId: string; teamId: string; direction: PoolDirection; tokenAmountPaise: number;
  status: 'PENDING' | 'FULFILLED' | 'REJECTED' | 'CANCELLED';
  note: string | null; decisionNote: string | null; decidedAt: string | null; createdAt: string;
  /** A pool buy paid in USDT (`toRequest` in database/repositories/teamPools.js); null when an admin fulfils it. */
  usdt?: PoolUsdtPayment | null;
}
/** Where and how much to pay for a USDT pool buy, and what has arrived (owner, 2026-10-21). */
export interface PoolUsdtPayment {
  chain: 'BEP20'; address: string; amount: number; received: number; rate: number; expiresAt: string;
}
/** Tokens a pool bought from the platform (`poolTradeTotals`, teamPools.js). */
export interface PoolTradeTotals { boughtPaise: number; buys: number }
export interface TeamMember {
  merchantId: string; teamId: string; name: string; publicRef: string;
  status: 'PENDING' | 'APPROVED'; isOnline: boolean;
}
// Oversight (Step 2f). Mirrors database/repositories/teamOversight.js and
// backend/domains/team/teamOversight.service.js (`memberActivityRows`,
// `teamPerformanceFor`, `toFlag`) and SUPERVISOR_ORDER_FIELDS — §5.
export interface MemberActivity {
  teamId: string; merchantId: string; name: string; publicRef: string; isOnline: boolean;
  completedOrders: number; completedTokens: number; onlineSeconds: number;
}
export interface LowActivityFlag {
  flagId: string; kind: 'LOW_ACTIVITY'; flagDay: string; teamId: string; teamName: string;
  merchantId: string; merchantName: string; merchantRef: string;
  details: { completedOrders: number; onlineSeconds: number; teamAverageOrders: number; teamAverageOnlineSeconds: number; members: number; percent: number };
}
/** teamPerformanceFor (teamOversight.service.js): `team` is null below TEAM_FIGURES_FROM (3) members. */
export interface TeamPerformance {
  days: number; from: string; members: number;
  team: { completedOrders: number; completedTokens: number; averageOrders: number; averageOnlineSeconds: number } | null;
  me: { completedOrders: number; completedTokens: number; onlineSeconds: number } | null;
}
/** An order as a supervisor sees it: SUPERVISOR_ORDER_FIELDS (merchantOrderView.js), nothing about the player. */
export interface SupervisorOrder {
  orderId: string; merchantId: string; type: 'DEPOSIT' | 'WITHDRAWAL'; status: string; currency: string;
  tokenAmount: number; paymentMode: string;
  disputeRaisedAt: string | null; disputeRaisedBy: string | null; disputeReason: string | null;
  disputeResolvedAt: string | null; disputeDecision: string | null; rejectedReason: string | null;
  createdAt: string; updatedAt: string;
}
export interface OnlineStretch { startedAt: string; endedAt: string | null; seconds: number }
export interface MemberLog {
  member: { merchantId: string; teamId: string; teamName: string; approvedAt: string; name: string; publicRef: string; isOnline: boolean };
  orders: SupervisorOrder[]; sessions: OnlineStretch[];
}
export interface DisputeThreadMessage {
  id: string; senderType: 'USER' | 'MERCHANT' | 'ADMIN' | 'SYSTEM' | 'SUPERVISOR'; senderName: string;
  message: string; isSystem: boolean; createdAt: string;
}
export type MyTeam =
  | { role: 'SUPERVISOR'; rail: SupervisorRail; publicRef: string; teams: Team[]; members: TeamMember[]; poolRequests: TeamPoolRequest[];
      commissions: TeamCommission[]; myCommissionPaise: number;
      activity: { today: MemberActivity[]; week: MemberActivity[] }; redFlags: LowActivityFlag[] }
  | { role: 'MEMBER'; publicRef: string; status: 'PENDING' | 'APPROVED'; team: Team;
      commissions: TeamCommission[]; myCommissionPaise: number; performance: TeamPerformance | null }
  | { role: 'NONE'; publicRef: string };

// ── Merchant accounts (owner, 2026-10-11 — Phase B of the merchants-and-agents plan) ──
// A MERCHANT ACCOUNT is a merchant with no supervisor: its own token pool, its
// own payment accounts and its own sub-members. Mirrors
// database/repositories/merchantPaymentAccounts.js (`toAccount`,
// ACCOUNT_KINDS, ACCOUNT_STATUSES), merchantStaff.js (`toStaff`, STAFF_ROLES,
// STAFF_DUTIES), merchantProblems.js (`toFlag`), teams.js (`toDirectTeam`) and
// backend/domains/merchant/merchantAccount.routes.js — §5: change them together.

/** STAFF_ROLES (merchantStaff.js). */
export type StaffRole = 'DEPOSITS' | 'WITHDRAWALS' | 'AUDIT';
/** STAFF_DUTIES (merchantStaff.js): which direction an assigned account is worked for. */
export type StaffDuty = 'DEPOSIT' | 'WITHDRAWAL';

/**
 * Who is signed in (`actor` on the login answer and on GET /profile,
 * merchant.routes.js / routes.js `issueMerchantSession`): the owner, or a
 * merchant account's sub-member with their roles. The account ids arrive on
 * GET /profile only; the login answer carries the roles alone.
 */
export type MerchantActor =
  | { isOwner: true }
  | {
      isOwner: false; staffId: string; name: string; roles: StaffRole[];
      depositAccountIds?: string[]; withdrawalAccountIds?: string[];
    };

export type PaymentAccountKind = 'UPI_QR' | 'BANK';
export type PaymentAccountStatus = 'ACTIVE' | 'PAUSED' | 'REMOVED';

/** `toAccount` (merchantPaymentAccounts.js). The UPI fields are set on a UPI_QR account only. */
export interface PaymentAccount {
  accountId: string; merchantId: string; kind: PaymentAccountKind; label: string;
  upiId: string | null; upiName: string | null; upiLink: string | null;
  holderName: string; accountNo: string; ifsc: string; bankName: string;
  acceptsDeposits: boolean; paysWithdrawals: boolean; status: PaymentAccountStatus;
  /** The order sizes, in tokens, a buy is paid into it / a sell is paid from it (owner, 2026-10-20). */
  buySizes: number[]; sellSizes: number[];
  lastUsedAt: string | null; createdAt: string; updatedAt: string; removedAt: string | null;
}

/**
 * `sizeCoverage` (merchantPaymentAccounts.js): the sizes, in tokens, the
 * platform sends to merchant accounts per direction, and which of them no
 * account of this merchant takes yet.
 */
export interface SizeCoverage {
  required: { DEPOSIT: number[]; WITHDRAWAL: number[] };
  uncovered: { DEPOSIT: number[]; WITHDRAWAL: number[] };
}

/**
 * `toStaff` (merchantStaff.js). `mobile` is sent to the owner and is never
 * rendered: nobody is shown another person's mobile number (CLAUDE.md §24).
 */
export interface SubMember {
  staffId: string; merchantId: string; userId: string; name: string; mobile: string | null;
  roles: StaffRole[]; status: string; createdAt: string; removedAt: string | null;
  assignments: Array<{ accountId: string; duty: StaffDuty }>;
}

/** `toDirectTeam` (teams.js): the merchant account itself, with its pool and commission. */
export interface DirectTeam {
  teamId: string; kind: 'DIRECT'; ownerMerchantId: string; ownerName: string; ownerRef: string;
  ownerStatus: string; ownerApproval: string; ownerOnline: boolean; routingPriority: number;
  name: string; poolAvailablePaise: number; poolHeldPaise: number; poolExposure: PoolExposure;
  poolStanding: PoolStanding; cashOut: CashOut;
  commission: TeamCommissionSummary; createdAt: string;
}

/**
 * How full a pool is (owner, 2026-10-21): `toPoolStanding` in
 * database/repositories/teamPools.js — §5. Paise. Size is the tokens bought
 * from the platform only (owner, 2026-10-22), so `leftPercent` can pass 100
 * once commission comes in; sell room is the cash from buys not yet paid out
 * on sells.
 */
export interface PoolStanding {
  sizePaise: number; leftPaise: number; heldPaise: number; consumedPaise: number;
  sellsOwedPaise: number; sellRoomPaise: number; leftPercent: number;
}

/** `toCashOut` (teamCashOut.js): buys only while active; nothing new until `pausedUntil`. */
export interface CashOut {
  active: boolean; startedAt: string | null; pausedUntil: string | null; pauseHours: number;
}

/**
 * Where a pool's tokens are, per order: `toPoolExposure` in
 * database/repositories/teamPools.js — §5, change them together. Paise.
 */
export interface PoolExposure {
  heldOpenPaise: number; heldDisputedPaise: number; openBuys: number;
  sellsSettlingPaise: number; sellsDisputedPaise: number; openSells: number;
}

/** GET /api/merchant/stats `money`: this merchant's own orders, and the pool they work from. */
export interface MerchantMoney {
  own: PoolExposure;
  pool: { availablePaise: number; heldPaise: number; exposure: PoolExposure; standing: PoolStanding } | null;
}

/** `toFlag` (merchantProblems.js): a day the merchant's problems reached the threshold. It suspends nothing. */
export interface MerchantFlag {
  id: number; merchantId: string; merchantName?: string; publicRef?: string;
  day: string; problemCount: number; threshold: number; createdAt: string;
}

/** GET /api/merchant/account. `staff` and `poolRequests` are the owner's only. */
export interface MerchantAccountOverview {
  success: boolean;
  team: DirectTeam;
  accounts: PaymentAccount[];
  sizes: SizeCoverage;
  poolTrades: PoolTradeTotals;
  staff?: SubMember[];
  poolRequests?: Array<TeamPoolRequest & { teamKind?: 'AGENT' | 'DIRECT' }>;
  flags: MerchantFlag[];
}

/** One direction's figures in a report (`ZERO` in merchantAccount.routes.js). */
export interface ReportFigures { orders: number; completed: number; completedPaise: number; disputed: number; disputesLost: number }

/**
 * GET /api/merchant/reports/orders — mirrors `MERCHANT_REPORT_FIELDS` and
 * `toMerchantReportRows` (backend/domains/merchant/merchantOrderView.js) and
 * the totals of `orderReport` (database/repositories/merchantReports.js).
 */
export type OrderReportResult = 'CONFIRMED' | 'REJECTED' | 'NONE';
export interface OrderReportRow {
  orderId: string;
  type: 'DEPOSIT' | 'WITHDRAWAL';
  userId: string;
  utr: string | null;
  tokenAmount: number;
  state: string;
  result: OrderReportResult;
  actedBy: { kind: 'MERCHANT' | 'STAFF'; name: string } | null;
  /** Every move the merchant's side made on it, oldest first (`REPORT_ACTIONS`, merchantReports.js). */
  actions: Array<{ action: string; by: { kind: 'MERCHANT' | 'STAFF'; name: string } | null; at: string }>;
  at: string;
}
export interface OrderReport {
  success: boolean;
  range: { from: string | null; to: string | null };
  rows: OrderReportRow[];
  totals: { orders: number; confirmed: number; rejected: number; confirmedBuyPaise: number; confirmedSellPaise: number };
  pagination: { total: number; limit: number; skip: number };
}

/** One order in the business ledger (`merchantLedger.businessLedger`). */
export interface LedgerOrderRow { orderId: string; at: string; tokensPaise: number; state: 'COMPLETED' | 'PAID'; rail: string; account: string | null }

/**
 * GET /api/merchant/reports/statement (owner, 2026-10-22): `poolStatement` in
 * database/repositories/merchantLedger.js — §5. Paise of a token. The balances
 * are null for an agent, whose pool is the team's.
 */
export interface PoolStatementRow {
  kind: 'BUY' | 'SELL' | 'TOKEN_BUY' | 'TOKEN_SELL_BACK' | string;
  ref: string; at: string; userId: string | null; utr: string | null; state: string | null;
  tokensPaise: number; poolChangePaise: number; commissionPaise: number;
  balanceAfterPaise: number | null; team: string | null;
}
export interface PoolStatement {
  range: { from: string | null; to: string | null };
  pools: Array<{ teamId: string; name: string }>;
  rows: PoolStatementRow[];
  truncated: boolean;
  totals: {
    openingPaise: number | null; closingPaise: number | null;
    buysProcessed: number; buysProcessedPaise: number;
    sellsProcessed: number; sellsProcessedPaise: number;
    commissionPaise: number; tokensBoughtPaise: number; netProfitPaise: number;
  };
}

/** GET /api/merchant/reports/ledger: every figure the server's, in paise of a token. */
export interface BusinessLedger {
  success: boolean;
  range: { from: string | null; to: string | null };
  buys: LedgerOrderRow[];
  sells: LedgerOrderRow[];
  commission: Array<{ commissionId: string; at: string; role: string; team: string; sharePaise: number }>;
  pool: Array<{ requestId: string; at: string; direction: PoolDirection; team: string; tokensPaise: number; currency: string | null; amountMinor: number | null; inrPaise: number }>;
  disputes: Array<{ orderId: string; at: string; type: 'BUY' | 'SELL'; tokensPaise: number; state: string; decision: string | null; lostBy: string | null; compensationPaise: number }>;
  truncated: boolean;
  totals: {
    boughtPaise: number; paidToAdminPaise: number;
    userBuys: number; userBuysPaise: number; userSells: number; userSellsPaise: number; netUserPaise: number;
    commissionPaise: number; compensationPaise: number; netCommissionPaise: number; netProfitPaise: number;
    pools: number; poolAvailablePaise: number; poolHeldPaise: number;
  };
}

/** GET /api/merchant/account/reports. */
export interface MerchantReport {
  success: boolean;
  range: { from: string | null; to: string | null };
  totals: { deposits: ReportFigures; withdrawals: ReportFigures };
  byAccount: Array<{
    accountId: string; label: string; kind: PaymentAccountKind; status: PaymentAccountStatus;
    deposits: ReportFigures; withdrawals: ReportFigures;
  }>;
  bySubMember: Array<{
    staffId: string; name: string; roles: StaffRole[]; status: string;
    deposits: ReportFigures; withdrawals: ReportFigures;
  }>;
  unattributed: { deposits: ReportFigures; withdrawals: ReportFigures };
}
