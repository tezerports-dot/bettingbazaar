// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// ═══════════════════════════════════════════════════════════════════════════
// 🎯 COMPLETE TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// Authentication & Users
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All 8 sub-admin permissions and what they control:
 *
 * canManageUsers      → /users page: view users, block/unblock, adjust balance
 * canManageMerchants  → /merchants page: view, suspend/activate, update limits
 * canResolveDisputes  → dispute resolution on payment orders
 * canViewTransactions → /transactions page (read-only)
 * canViewAnalytics    → dashboard, profit & loss, cycle history, live cycles
 * canManageContent    → FAQ manager, support links, CDN images, branding
 * canManagePhantom    → phantom access assignment (set on sub-admin account itself)
 */
/**
 * A sub-admin's grant: every key in `utils/permissions.ts` (the server's list),
 * true or false. Derived from that list rather than restated, so a new area is
 * a new field here with nothing to edit — the interface it replaced named eight
 * keys and had already fallen behind the routes.
 */
export type SubAdminPermissions = Partial<Record<import('./utils/permissions').PermissionKey, boolean>>;

export interface Admin {
  _id: string;
  id?: string;
  username: string;
  mobile?: string; // full admins only (staffContactShield.js)
  role: 'admin' | 'subadmin';
  isAdmin: boolean;
  isSubAdmin: boolean;
  // permissions is populated for sub-admins from subAdminPermissions on the User document
  permissions?: SubAdminPermissions;
  profilePic?: string;
  lastLogin?: string;
  createdAt?: string;
}

export interface User {
  /**
   * The account id, exactly as the server sends it.
   *
   * This said `_id` — the document-store key — and the server has never sent
   * one: `GET /api/admin/users` returns rows mapped by the users repository,
   * and that mapper emits `userId` and nothing else. So every user-scoped call
   * from this panel built `/api/admin/users/undefined/…`, which is a 404 the
   * component catches and renders as its empty state. Block, unblock, delete,
   * balance adjust, roles and phantom access were all reached that way.
   *
   * TypeScript could not catch it, because the interface was the thing that was
   * wrong. Renaming the field here is what found every call site — the compiler
   * lists them, so none can be missed the way a search would miss one.
   */
  userId: string;
  username: string;
  mobile?: string; // full admins only (staffContactShield.js)

  depositBalance: number;
  winningsBalance: number;
  lockedBalance: number;
  lockedDepositAmount: number;
  lockedWinningsAmount: number;

  walletAddress?: string;
  profilePic?: string;

  // DELETED is a status the server sends: the list includes closed accounts.
  status: 'ACTIVE' | 'BLOCKED' | 'SUSPENDED' | 'DELETED';
  // `users.account_type`, from the repository mapper. The list holds staff as
  // well as players, and only a PLAYER can be deleted from this screen.
  accountType?: 'PLAYER' | 'STAFF' | 'MERCHANT';

  bankDetails?: {
    accountHolderName: string;
    accountNumber?: string;
    ifscCode?: string;
    bankName: string;
  };

  // 'BOTH' predates the 1-minute block and means EVERY type — the server gate
  // reads it as "skip the per-type check".
  // 'NONE', a board's key, or 'BOTH' (= every board).
  phantomAccess: string;

  roles: string[];
  subAdminPermissions?: Record<string, boolean>;
  /** Only on `GET /api/admin/sub-admins` (subadmins.admin.routes.js): a yes/no, never the secret. */
  authenticatorEnrolled?: boolean;

  isMediator: boolean;
  isMerchant: boolean;
  merchantApprovalStatus?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';

  /** Lost payment disputes, and when high-risk review opened (users repository mapper). */
  lostDisputes?: number;
  highRiskAt?: string | null;

  joinedAt: string;
  lastLogin: string;
}

/** A staff role key, as the server names it (adminDirectory.js STAFF_ROLES). */
export type StaffRole = 'ADMIN' | 'SUB_ADMIN' | 'MEDIATOR';

/**
 * One row of the staff table, as `GET /api/admin/staff` sends it
 * (database/repositories/adminDirectory.js `toStaffRow`). `areas` are the
 * permission keys the grant holds true; their labels are the catalogue's.
 */
export interface StaffRow {
  userId: string; username: string | null; mobile?: string; status: string; isBlocked: boolean;
  joinedAt: string; lastLogin: string | null;
  roles: StaffRole[]; areas: string[]; authenticatorEnrolled: boolean;
}

/**
 * A row of the players table, as `GET /api/admin/users` sends it
 * (database/repositories/adminDirectory.js `toPlayerRow`). Money in PAISE.
 * `netPaise` is the player's net win (positive) or loss (negative) on boards
 * and casino.
 */
export interface PlayerRow {
  userId: string;
  username: string;
  mobile?: string; // full admins only (staffContactShield.js)
  status: 'ACTIVE' | 'BLOCKED' | 'SUSPENDED' | 'DELETED';
  joinedAt: string;
  lastLogin: string | null;
  playProfile: 'VIP' | 'GENERAL';
  phantomAccess: string;
  lostDisputes: number;
  highRiskAt: string | null;
  paymentFlagged: boolean;
  blockReason: string | null;
  wallet: { vipPaise: number; depositPaise: number; winningsPaise: number; generalPaise: number; lockedPaise: number };
  totals: { depositsPaise: number; withdrawalsPaise: number; depositCount: number; netPaise: number };
}

/** `MERCHANT_ROLES` (adminDirectory.js): derived from the team rows. */
export type MerchantRole = 'MERCHANT' | 'SUPERVISOR' | 'AGENT' | 'UNASSIGNED';

/**
 * A row of the merchants table, as `GET /api/admin/merchants` sends it
 * (adminDirectory.js `toMerchantRow`). Money in PAISE (tokens × 100).
 */
export interface MerchantRow {
  merchantId: string;
  userId: string | null;
  name: string;
  mobile?: string; // full admins only (staffContactShield.js)
  status: 'ACTIVE' | 'SUSPENDED' | 'INACTIVE' | string;
  merchantApprovalStatus: 'PENDING' | 'APPROVED' | 'REJECTED' | string;
  isOnline: boolean;
  role: MerchantRole;
  rail: string | null;
  acceptsDeposits: boolean;
  acceptsWithdrawals: boolean;
  routingPriority: number;
  lostDisputes: number;
  highRiskAt: string | null;
  assignmentPausedAt: string | null;
  createdAt: string;
  team: { teamId: string; name: string; memberStatus: 'PENDING' | 'APPROVED' | null } | null;
  processedPaise: number;
  completedOrders: number;
  pool: { availablePaise: number; heldPaise: number; teams: number };
  commission: { todayPaise: number; monthPaise: number; totalPaise: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cycles
// ─────────────────────────────────────────────────────────────────────────────

// A board's key, which is its cycles' `type`. Boards are rows an admin creates
// (`boards`, backend/domains/markets/cycleTypes.js), so any key the server lists.
export type CycleType = string;

/** A board as `GET /api/admin/boards` sends it (database/repositories/boards.js `toBoard`). */
export interface Board {
  key: string;
  name: string;
  kind: 'INTERVAL' | 'DAILY';
  durationMin: number;
  anchorHourIst: number | null;
  phases: {
    mergeBeforeEndSec: number;
    equalizerBeforeEndSec: number;
    closeBeforeEndSec: number;
    celebrateBeforeEndSec: number;
  };
  minBet: number;
  maxBet: number;
  idPrefix: string;
  enabled: boolean;
  homeOrder: number;
}
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
  /**
   * Whose board: VIP (deposited money) or GENERAL (referral bonus money); the
   * two never share a cycle. Mirrors `cycles_audience_known` (schema.sql).
   */
  audience?: 'VIP' | 'GENERAL';
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
  /**
   * True while betting is open and this account is not a full admin: the
   * real and phantom figures are then withheld (`/api/admin/cycles/phases`,
   * `maySeeLiveSplit` in backend staffEventAreas.js).
   */
  splitHidden?: boolean;

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

// TokenRates interface removed 2026-07-08 — token conversion is fixed 1:1
// (Phase 006 flattening); rates are no longer fetched or edited anywhere.

// ─────────────────────────────────────────────────────────────────────────────
// Merchants
// A merchant holds no tokens of their own: they work in a team whose POOL holds
// them, and routing hands each order to a member of a working team on the
// order's rail. Checked against the profile route (`toMerchant`); the TABLE's row is `MerchantRow` above
// (backend/domains/merchant/merchant.admin.routes.js,
// database/repositories/merchants.js).
// ─────────────────────────────────────────────────────────────────────────────

export interface Merchant {
  _id: string;
  userId: string;
  name: string;
  mobile?: string; // full admins only (staffContactShield.js)
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
  /** Lost payment disputes, and when high-risk review opened (GET /api/admin/merchants/:id/profile). */
  lostDisputes?: number;
  highRiskAt?: string | null;
  suspensionReason?: string | null;
  createdAt: string;
}

export interface MerchantProfile extends Merchant {
  /** Set when three buys in a row expired unpaid; routing skips them until an admin resumes. */
  assignmentPausedAt?: string | null;
  assignmentPauseReason?: string | null;
  statistics: {
    totalOrders: number;
    completedOrders: number;
    failedOrders: number;
    /** Percent of decided orders that succeeded; null before any is decided (`bb_merchant_track_record`). */
    successRate: number | null;
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
  userMobile?: string; // full admins only (staffContactShield.js)
  merchantId?: string;
  merchantName?: string;
  tokenAmount: number;
  fiatAmount: number;
  rateUsed: number;
  merchantProfit: number; // spread retired 2026-07-08 (fixed 1:1) — 0 for new orders, historical audit only
  /** 'INR' or 'USDT'. On a USDT order `fiatAmount` is in USDT (trap 15). */
  currency?: 'INR' | 'USDT';
  /** Stamped at creation and frozen: 'CASH_ATM' or 'P2P_UPI' (orderRails.js). */
  paymentMode?: 'CASH_ATM' | 'P2P_UPI';
  /** The team serving it, once routed. */
  teamId?: string | null;
  status: OrderStatus;
  /** May an admin move it to another member (`mayChangeHands`, orders.record.js). */
  canReassign?: boolean;
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

/**
 * One WALLET LEDGER row, exactly as `platformLedger()` projects it in
 * `database/repositories/wallets.js` — which is what `GET /api/admin/transactions`
 * returns. Check this against that projection before adding a field (§23).
 *
 * It used to describe a document-store collection that no longer exists, and
 * every field below was wrong in a way TypeScript could not catch, because the
 * INTERFACE was the thing that was wrong:
 *
 *     _id          the server has never sent one — the id is `txId`
 *     status       a ledger row has no status; it is a record that money MOVED
 *     balanceType  the row says `field` ('depositBalance' | 'winningsBalance' | …)
 *     referenceId  the row says `refId`
 *     description  the row says `reason`
 *     timestamp    the row says `createdAt`
 *     userId       never a populated object; the joined user is on `user`
 *
 * `tx._id.slice(-10)` therefore threw `Cannot read properties of undefined` and
 * the Transactions screen went WHITE — and the admin panel does not recover
 * from a render crash by navigating, so every screen opened afterwards stayed
 * blank until a full reload.
 *
 * The fix that finds every call site is renaming the field here and letting
 * `tsc` list them; a search misses one, and a missed one is another blank page.
 */
export interface Transaction {
  /** The idempotency key, and the row's identity. Never `_id`. */
  txId: string;
  userId: string;
  /** LEFT JOINed, so it is null when the account is gone but the money moved. */
  user: { userId: string; username: string; mobile?: string } | null;
  /** The DIRECTION of the movement. */
  type: 'CREDIT' | 'DEBIT';
  /** Which pocket moved. */
  field: 'depositBalance' | 'winningsBalance' | 'tokenBalance' | 'reserveBalance' | 'lockedBalance';
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  reason: string;
  refId?: string | null;
  createdAt: string;
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
  /** `BRAND_PALETTES` (backend/domains/branding/palettes.js). */
  palette?: 'GOLD' | 'STAKE';
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
  category: 'promo' | 'banner' | 'avatar' | 'payment_proof' | 'logo' | 'icon' | 'other';
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
  category: 'general' | 'account' | 'betting' | 'payments' | 'security' | 'technical';
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
  users: { total: number; active: number; blocked: number };
  merchants: { total: number; active: number; pending: number; online: number };
  finance: {
    totalDeposits: number;
    totalWithdrawals: number;
    totalBets: number;
    totalPayouts: number;
    netProfit: number;
    tokenBuy?: number;   // token purchase volume — present when backend returns it
    tokenSell?: number;  // token redemption volume — present when backend returns it
    // Today in IST — the last bucket of the seven-day series the chart draws,
    // so the tiles and the chart agree (analytics.admin.routes.js). Player
    // bets only; phantom bets are phantom liquidity.
    today?: { bets: number; betCount: number; payouts: number; deposits: number; netProfit: number };
  };
  // `totalBets` is ALL-TIME player bets, not today's.
  cycles: { activeCount: number; todayCount: number; totalBets: number };
  queue: { pendingOrders: number; avgWaitTime: number };
}

/** `GET /api/admin/analytics/financials` `data` (`stats.profitAndLoss` + `providerRevenue`). Rupees. */
export interface FinancialStats {
  revenue: {
    boardGames: { amount: number; settledStakes: number; payouts: number; bets: number; wins: number };
    winningsFees: number;
    casino: number;
    cricket: { amount: number; fees: number; polls: number };
    total: number;
  };
  costs: {
    referralBonuses: { amount: number; count: number };
    firstDepositBonuses: { amount: number; count: number };
    teamCommission: { amount: number; count: number };
    total: number;
  };
  netProfit: number;
  openStakes: number;
  moneyFlow: { deposits: { amount: number; count: number }; withdrawals: { amount: number; count: number } };
  byProvider: { key: string; bets: number; betCount: number; wins: number; winCount: number; refunds: number; ggr: number }[];
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

// ── Supervisors and teams (redesign Step 2a) ─────────────────────────────────
// Mirrors database/repositories/teams.js (`toTeam`, `toMember`,
// SUPERVISOR_RAILS) — §5: change them together.
export type SupervisorRail = 'CASH' | 'UPI_BANK';
export interface TeamSupervisor {
  merchantId: string; name: string; publicRef: string; rail: SupervisorRail; isOnline: boolean;
}
export interface TeamView {
  teamId: string; supervisorId: string; supervisorName: string; supervisorRef: string;
  name: string; rail: SupervisorRail; approvedCount: number; pendingCount: number; size: number;
  /** WORKING with at least one approved member, else STOPPED (a team works with 1–10; Phase A). */
  strength: 'WORKING' | 'STOPPED'; createdAt: string;
  /** The team's token pool, in paise (Step 2b). */
  poolAvailablePaise: number; poolHeldPaise: number;
  /** What the held tokens are held for, and the sells on their way in. */
  poolExposure: PoolExposure;
  /** Cash out and the pause after it (`toCashOut`, teamCashOut.js). */
  cashOut?: CashOut;
  /** Team commission (Step 2e): mirrors `toSummary` in database/repositories/teamCommission.js — §5. */
  commission: {
    teamId: string; buysPaise: number; sellsPaise: number;
    paidPaise: number; owedPaise: number;
    depositPercent: number; withdrawalPercent: number; supervisorSharePercent: number;
  };
}
// Mirrors `toRequest` and POOL_DIRECTIONS in database/repositories/teamPools.js
// — §5: change them together.
export interface TeamPoolRequest {
  requestId: string; teamId: string; teamName: string | null;
  // AGENT: an agents' team, asked by its supervisor. DIRECT: a merchant
  // (merchant account), asked by its owner (`toRequest`, teamPools.js).
  teamKind: 'AGENT' | 'DIRECT';
  supervisorId: string; supervisorName: string | null;
  direction: 'BUY' | 'SELL'; tokenAmountPaise: number;
  status: 'PENDING' | 'FULFILLED' | 'REJECTED' | 'CANCELLED';
  note: string | null; decidedBy: string | null; decidedAt: string | null;
  decisionNote: string | null; createdAt: string;
}
// Red flags (Step 2f). Mirrors `toFlag` and the details `evaluateRedFlags`
// writes in database/repositories/teamOversight.js — §5: change them together.
export interface TeamRedFlag {
  flagId: string; kind: 'LOW_ACTIVITY'; flagDay: string;
  teamId: string; teamName: string; supervisorId: string;
  merchantId: string; merchantName: string; merchantRef: string;
  details: {
    completedOrders: number; onlineSeconds: number; teamAverageOrders: number; teamAverageOnlineSeconds: number;
    members: number; percent: number;
  };
  createdAt: string;
}
export interface TeamMemberView {
  merchantId: string; teamId: string; name: string; publicRef: string;
  status: 'PENDING' | 'APPROVED'; isOnline: boolean;
  /** 1–5, the admin's; routing offers orders to the highest first (`setRoutingPriority`). */
  routingPriority: number;
  addedBy: string; addedAt: string; approvedBy: string | null; approvedAt: string | null;
}

/**
 * Where a pool's tokens are, per order: `toPoolExposure` in
 * database/repositories/teamPools.js — §5, change them together. Paise.
 */
export interface PoolExposure {
  heldOpenPaise: number; heldDisputedPaise: number; openBuys: number;
  sellsSettlingPaise: number; sellsDisputedPaise: number; openSells: number;
}

/** One line saying where a pool's held tokens are and what sells are bringing in. */
/**
 * A pool's cash out (owner, 2026-10-21): `toCashOut` in
 * database/repositories/teamCashOut.js — §5. Buys only while active; nothing
 * new until `pausedUntil`.
 */
export interface CashOut { active: boolean; startedAt: string | null; pausedUntil: string | null; pauseHours: number }

/** The one line the admin's pool tables show for a cash out; '' when there is none. */
export function cashOutLine(c: CashOut | undefined): string {
  if (!c) return '';
  if (c.active) return 'Cashing out: buy orders only';
  if (c.pausedUntil) return `Paused after a cash out until ${new Date(c.pausedUntil).toLocaleString('en-IN')}`;
  return '';
}

export function poolExposureLine(x: PoolExposure | undefined, tokens: (paise: number) => string): string {
  if (!x) return '';
  const parts = [`${tokens(x.heldOpenPaise)} in ${x.openBuys} open buy${x.openBuys === 1 ? '' : 's'}`];
  if (x.heldDisputedPaise) parts.push(`${tokens(x.heldDisputedPaise)} in disputes`);
  if (x.sellsSettlingPaise) parts.push(`${tokens(x.sellsSettlingPaise)} incoming from sells`);
  if (x.sellsDisputedPaise) parts.push(`${tokens(x.sellsDisputedPaise)} in disputed sells`);
  return parts.join(' · ');
}
