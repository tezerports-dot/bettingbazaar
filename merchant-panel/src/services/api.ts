// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import {
  MerchantProfile,
  PaymentOrder,
  AuthResponse,
  Earnings,
  Stats,
  MyTeam,
  Team,
  TeamPool,
  TeamPoolEntry,
  TeamPoolRequest,
  CashOut,
  MemberLog,
  SupervisorOrder,
  DisputeThreadMessage,
  TelegramLink,
  MiniAppSetup,
  MerchantAccountOverview,
  PaymentAccount,
  PaymentAccountKind,
  SubMember,
  StaffRole,
  StaffDuty,
  MerchantReport,
  OrderReport,
  BusinessLedger,
  PoolStatement,
} from '../types';
import { ENDPOINTS, ERROR_MESSAGES } from '../constants';

// URL resolution. On a SPLIT-ORIGIN deploy the merchant panel is served from a
// different host than the backend, so window.location.origin is the panel's host,
// not the API — every call would 404. Set VITE_API_URL (at build time) to the
// backend URL for that case. On the default single-origin launch (NGINX serves
// the panel and proxies /api to the backend) the origin fallback is correct and
// no env var is needed.
const getAPIBaseURL = (): string => {
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return (import.meta.env.VITE_API_URL as string) || 'http://localhost:8080';
  }
  // Split-origin: set VITE_API_URL to the backend URL. Same-origin: fall back to
  // the current origin (NGINX proxies /api).
  return (import.meta.env.VITE_API_URL as string) || window.location.origin;
};

const BASE_URL = getAPIBaseURL();

export const getAuthToken = (): string | null => {
  return localStorage.getItem('merchantToken');
};

export const getMerchantData = (): MerchantProfile | null => {
  const data = localStorage.getItem('merchantData');
  return data ? JSON.parse(data) : null;
};

const setMerchantData = (merchant: MerchantProfile): void => {
  localStorage.setItem('merchantData', JSON.stringify(merchant));
};

const clearAuthData = (): void => {
  localStorage.removeItem('merchantToken');
  localStorage.removeItem('merchantData');
};

/**
 * ── Why the panel signed the merchant out, said on the sign-in screen ──────
 * A session the server refuses (401, or 403 "Account suspended. Contact
 * support.") is cleared and the panel reloads at the sign-in form. That form
 * said nothing: a merchant an admin had just suspended was shown "Secure
 * operator sign-in", typed their password, and only then read the reason
 * (§32 S48, S17). Every sign-out reloads the page, so the server's own words
 * are kept in sessionStorage across that one reload and read once.
 */
const SIGNED_OUT_REASON_KEY = 'merchantSignedOutReason';

const keepSignedOutReason = (reason?: string | null): void => {
  // Whatever this page load already showed is over: a manual Log out after a
  // re-sign-in must not flash the previous reason before the reload lands.
  signedOutReasonRead = true;
  signedOutReasonValue = null;
  const said = String(reason ?? '').trim().slice(0, 300);
  if (!said) return;
  try { sessionStorage.setItem(SIGNED_OUT_REASON_KEY, said); } catch { /* blocked storage: the form still renders */ }
};

// Read once per page load, then remembered for it: React's StrictMode runs a
// state initialiser twice, and the second read must not find it already gone.
let signedOutReasonRead = false;
let signedOutReasonValue: string | null = null;
export const signedOutReason = (): string | null => {
  if (signedOutReasonRead) return signedOutReasonValue;
  signedOutReasonRead = true;
  try {
    signedOutReasonValue = sessionStorage.getItem(SIGNED_OUT_REASON_KEY);
    sessionStorage.removeItem(SIGNED_OUT_REASON_KEY);
  } catch { signedOutReasonValue = null; }
  return signedOutReasonValue;
};

/**
 * A failure on this panel, for the admin's error log (owner, 2026-10-20;
 * `POST /api/internal/error-report`, no session: a crashing panel may have
 * none). Best-effort: never throws, never signs anybody out.
 */
export const reportPanelError = (report: Record<string, unknown>): void => {
  try {
    void fetch(`${BASE_URL}/api/internal/error-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...report, panel: 'merchant' }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* reporting never breaks the panel */ }
};

export const isAuthenticated = (): boolean => {
  return !!getAuthToken();
};

export const getCurrentMerchant = (): MerchantProfile | null => {
  return getMerchantData();
};

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = getAuthToken();
  
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` }),
    ...options.headers,
  };

  if (options.body instanceof FormData) {
    delete (headers as any)['Content-Type'];
  }

  try {
    const url = `${BASE_URL}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers,
      mode: 'cors',
      credentials: 'omit',
    });
    
    if (response.status === 401) {
      const hadSession = !!getAuthToken();
      clearAuthData();
      // Read the actual error message from the backend response
      let errMsg = ERROR_MESSAGES.SESSION_EXPIRED;
      let errData: unknown = null;
      try {
        errData = await response.clone().json();
        const said = (errData as { message?: unknown } | null)?.message;
        if (typeof said === 'string' && said) errMsg = said;
      } catch { /* ignore parse errors */ }
      if (hadSession) {
        keepSignedOutReason(errMsg);
        window.location.href = '/merchant/';
      }
      // The status and body travel with it, as below: a sign-in poll tells
      // TWO_FACTOR_DENIED from TWO_FACTOR_EXPIRED by its code.
      const err = new Error(errMsg) as Error & { status?: number; data?: unknown };
      err.status = 401;
      err.data = errData;
      throw err;
    }
    
    const contentType = response.headers.get('content-type');
    let data: any;
    
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      const text = await response.text();
      data = { message: text };
    }
    
    if (!response.ok) {
      // The status and the body travel WITH the error. This threw a bare
      // `Error(message)`, so everything the server said beyond one sentence was
      // discarded at the boundary — a caller could not tell a 429 from a 400,
      // and structured fields like `retryAfter` / `retryAt` were unreachable no
      // matter how carefully the server sent them.
      const err = new Error(data?.message || `Request failed with status ${response.status}`) as
        Error & { status?: number; data?: unknown };
      err.status = response.status;
      err.data = data;
      throw err;
    }
    
    return data as T;
  } catch (error: any) {
    console.error(`API Error [${endpoint}]:`, error);
    throw error;
  }
}

// =======================================================================
// AUTHENTICATION
// =======================================================================

/** Keep a session the door issued: the token and the merchant it names. */
const keepSession = (data: AuthResponse): void => {
  if (data.token) localStorage.setItem('merchantToken', data.token);
  const merchant = data.user || data.merchant;
  // Who signed in travels beside `merchant` on the login answer; kept with it
  // so a sub-member's screens are gated from the first render.
  if (merchant) setMerchantData(data.actor ? { ...merchant, actor: data.actor } : merchant);
};

/** How an approved "Continue with Telegram" comes back (backend `DELIVERY`, repositories/telegram.js). */
export type TelegramDelivery = 'MATCH' | 'HANDOFF';

/** An opened "Continue with Telegram": the link, and for a MATCH the number to show. */
export interface TelegramSignIn {
  challengeToken: string;
  telegram: TelegramLink | null;
  delivery: TelegramDelivery;
  matchNumber: number | null;
  message?: string;
}

/**
 * "Continue with Telegram", the only way in (owner, 2026-10-14): opens a
 * sign-in whose link the merchant opens. No bot set up is thrown as the
 * server's sentence (503 TELEGRAM_UNAVAILABLE).
 */
export const startTelegramSignIn = async (delivery: TelegramDelivery): Promise<TelegramSignIn> =>
  request<TelegramSignIn>(ENDPOINTS.AUTH.LOGIN_TELEGRAM, {
    method: 'POST',
    // Where Verify's link would open this panel: the server grants a HANDOFF
    // only at the site's own address, else MATCH (`deliveryFor`, backend).
    body: JSON.stringify({ delivery, returnOrigin: window.location.origin }),
  });

/**
 * One poll of a "Continue with Telegram". `null` while Telegram has not
 * answered (202); the session, kept, once a MATCH is approved; `'handedOff'`
 * when Verify sent the session to the device Telegram opened. A denial, an
 * expiry or an account refusal (403 MERCHANT_NOT_ACTIVE: an application an
 * admin has not approved) is thrown with its status and body.
 */
export const pollTelegramSignIn = async (challengeToken: string): Promise<AuthResponse | 'handedOff' | null> => {
  const data = await request<AuthResponse & { pending?: boolean; handedOff?: boolean }>(ENDPOINTS.AUTH.LOGIN_TELEGRAM_COMPLETE, {
    method: 'POST',
    body: JSON.stringify({ challengeToken }),
  });
  if (data.handedOff) return 'handedOff';
  if (data.pending || !data.token) return null;
  keepSession(data);
  return data;
};

/** The one-time ticket the Mini App opened this panel with (`#/tg/<ticket>`), exchanged once for the session. */
export const redeemTelegramTicket = async (ticket: string): Promise<AuthResponse> => {
  const data = await request<AuthResponse>(ENDPOINTS.AUTH.LOGIN_TELEGRAM_TICKET, {
    method: 'POST',
    body: JSON.stringify({ ticket }),
  });
  keepSession(data);
  return data;
};

/** Whether the platform's bot is set up. Public. */
export const getMiniAppSetup = async (): Promise<MiniAppSetup> =>
  request<MiniAppSetup>('/api/telegram/mini-app?panel=MERCHANT');

/** Sign out and reload at the sign-in form; `reason` is the server's refusal, shown there once. */
export const logout = (reason?: string | null): void => {
  clearAuthData();
  keepSignedOutReason(reason);
  window.location.href = "/merchant/";
};

/**
 * The signed-in merchant's profile. `actor` (who is acting: the owner, or a
 * merchant account's sub-member) and `isMerchantAccount` arrive BESIDE
 * `merchant` (merchant.routes.js GET /profile) and are merged into it here, so
 * every screen reads one object — and so they are not dropped, which is what
 * returning `data.merchant` alone would do.
 */
export const getMerchantProfile = async (): Promise<MerchantProfile> => {
  const data = await request<any>(ENDPOINTS.AUTH.PROFILE);
  const merchant = data.merchant || data;
  return {
    ...merchant,
    ...(data.actor ? { actor: data.actor } : {}),
    ...(typeof data.isMerchantAccount === 'boolean' ? { isMerchantAccount: data.isMerchantAccount } : {}),
  };
};

// =======================================================================
// ORDERS
// =======================================================================

export const getOrders = async (params?: {
  status?: string;
  type?: string;
  limit?: number;
  skip?: number;
}): Promise<{ orders: PaymentOrder[]; pagination?: any }> => {
  try {
    const queryParams = new URLSearchParams();
    if (params?.status) queryParams.append('status', params.status);
    if (params?.type) queryParams.append('type', params.type);
    if (params?.limit) queryParams.append('limit', params.limit.toString());
    if (params?.skip) queryParams.append('skip', params.skip.toString());
    
    const endpoint = `${ENDPOINTS.ORDERS.LIST}${queryParams.toString() ? '?' + queryParams.toString() : ''}`;
    const data = await request<any>(endpoint);
    
    return { 
      orders: data.orders || data || [], 
      pagination: data.pagination 
    };
  } catch (error) {
    console.error('Error loading orders:', error);
    return { orders: [] };
  }
};

/**
 * Confirm an order. Works for BOTH:
 *   DEPOSIT:    PAID → COMPLETED, releasing tokens to the player.
 *   WITHDRAWAL: PROCESSING → PAID (held) or COMPLETED (hold disabled).
 *
 * `utrNumber` is sent on a WITHDRAWAL and never on a deposit, because the two
 * order types put the payment on opposite sides:
 *
 *   BUY   the PLAYER pays the merchant. Their UTR arrives at mark-paid and is
 *         claimed against the order there. The merchant restating it would be a
 *         second writer for a value that already has an owner (§27) — this used
 *         to post it back and the route used to overwrite the stored value with
 *         whatever arrived.
 *   SELL  the MERCHANT pays the player. The reference for that transfer is
 *         theirs to give and nobody else has it, so it is collected on the
 *         payout dialog and claimed by the confirm.
 *
 * `proof` is gone from both: it could only ever be `undefined` once
 * payment-proof collection was removed platform-wide.
 */
export const confirmPayment = async (
  orderId: string, utrNumber?: string, paidFromAccountId?: string,
): Promise<PaymentOrder> => {
  // `paidFromAccountId`: on a sell a merchant account serves, which of its
  // accounts paid it (owner, 2026-10-11). Required there, and refused 400
  // PAID_FROM_ACCOUNT_REQUIRED without one; never sent on any other order.
  const body = {
    ...(utrNumber ? { utrNumber } : {}),
    ...(paidFromAccountId ? { paidFromAccountId } : {}),
  };
  const data = await request<any>(ENDPOINTS.ORDERS.CONFIRM(orderId), {
    method: 'POST',
    ...(Object.keys(body).length ? { body: JSON.stringify(body) } : {}),
  });
  return data.order || data;
};

/**
 * Reject an order the player says they paid, because the money never arrived.
 *
 * Different from `rejectOrder` below, which declines an order before anybody
 * can have paid and returns it to the queue. This one rejects a PAID buy (only
 * a PAID one: owner, 2026-10-07) and adds a warning and a flag to the player's
 * account, so the backend requires a reason of at least ten characters. No
 * proof image (owner, 2026-10-17: "reason only").
 */
export const rejectPaidOrder = async (orderId: string, reason: string): Promise<PaymentOrder> => {
  const data = await request<any>(ENDPOINTS.ORDERS.REJECT_PAID(orderId), {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
  return data.order || data;
};

export const rejectOrder = async (orderId: string, reason: string): Promise<PaymentOrder> => {
  const data = await request<any>(ENDPOINTS.ORDERS.REJECT(orderId), {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
  return data.order || data;
};

// =======================================================================
// ESCALATION
// =======================================================================

/**
 * Send an order to an admin because something about it is wrong.
 *
 * This used to POST the merchant DISPUTE endpoint, which was deleted on
 * 2026-09-10: a dispute is the PLAYER's instrument — the party who is owed —
 * and a merchant who is short simply does not confirm. What a merchant is
 * entitled to assert is that a transaction FAILED, and they have three ways of
 * saying it: decline before payment, reject with proof after the player claims
 * they paid, and this — a red flag on an order that looks fraudulent or cannot
 * be processed.
 *
 * The endpoint it now calls was already in ENDPOINTS and had no caller at all,
 * so the panel had the right route defined and the wrong one wired.
 */
export const redFlagOrder = async (orderId: string, reason?: string): Promise<PaymentOrder> => {
  const data = await request<any>(ENDPOINTS.ORDERS_EXTRA.RED_FLAG(orderId), {
    method: 'POST',
    body: JSON.stringify({ reason: reason || 'Flagged by merchant for admin review' }),
  });
  return data.order || data;
};

/**
 * Attach the cash machine's QR to a cash buy (Step 2d). The link is what the
 * scanner decoded, sent as read; the server checks it against the order amount
 * and refuses anything that is not a UPI payment link for exactly that sum.
 */
export const attachCashLink = async (orderId: string, link: string): Promise<PaymentOrder> => {
  const data = await request<any>(ENDPOINTS.ORDERS_EXTRA.CASH_LINK(orderId), {
    method: 'POST',
    body: JSON.stringify({ link }),
  });
  return data.order || data;
};

// `approveOrder` was here, posting to `/api/merchant/orders/:id/approve`. That
// route was a second path completing a PAID deposit and has been deleted:
// `confirmOrder` (POST /confirm/:id) is the one writer, and it is what every
// screen already called. Nothing rendered this helper — but an exported caller
// still looks like a caller to the ui-coverage scanner, which is why the dead
// route read as reachable for as long as this line existed.


// Merchants review proofScreenshot (inline image) + utrNumber on order card.
// =======================================================================

// =======================================================================
// EARNINGS & STATS
// =======================================================================

export const getEarnings = async (params?: {
  startDate?: string;
  endDate?: string;
}): Promise<{ earnings: Earnings }> => {
  try {
    const queryParams = new URLSearchParams();
    if (params?.startDate) queryParams.append('startDate', params.startDate);
    if (params?.endDate) queryParams.append('endDate', params.endDate);
    
    const endpoint = `${ENDPOINTS.EARNINGS.GET}${queryParams.toString() ? '?' + queryParams.toString() : ''}`;
    const data = await request<any>(endpoint);
    
    // ── What a merchant EARNED, from the one place that records it ──────────
    //
    // This read `today.deposits.totalFees`, which came from
    // `order_states.merchant_profit_paise` — written as the literal 0 at order
    // creation and never set again, because merchant pay is team commission
    // (2e): each member's share in `team_commission_shares`. So the "Today's
    // earnings" tile was a structural zero for every merchant on every rail,
    // on a platform that does pay commission. It was also only the DEPOSIT
    // half, so even against a live column it would have under-reported.
    //
    // `todayEarned` is the commission shares' own figure and needs no
    // reshaping here. Where a mapper has nothing to do, it should do nothing:
    // arithmetic in this file is a second owner of a money number.
    return {
      earnings: {
        today: data.earnings?.todayEarned || 0,
        // `week` and `month` were the literals 0 with "Calculate from lifetime
        // if needed" beside them — a permanent TODO (§14) on a field nothing
        // renders (§3). Gone; the weekly chart has its own endpoint, which
        // returns real days.
        total: data.earnings?.lifetime?.totalEarnings || 0,
        lifetime: data.earnings?.lifetime,
      }
    };
  } catch (error) {
    console.error('Error loading earnings:', error);
    return { earnings: { today: 0, total: 0 } };
  }
};

export const getStats = async (): Promise<Stats> => {
  try {
    const data = await request<any>(ENDPOINTS.EARNINGS.STATS);
    
    // Backend returns: { stats: { pending, processing, completedToday } }
    return {
      money: data.money,
      commission: data.commission ?? null,
      pending: data.stats?.pending || 0,
      processing: data.stats?.processing || 0,
      completedToday: data.stats?.completedToday || 0,
      todayOrders: data.stats?.completedToday || 0,
      weekOrders: 0,
      monthOrders: 0,
      todayEarnings: 0,
      weekEarnings: 0,
      monthEarnings: 0,
      successRate: 0,
      averageOrderValue: 0,
    };
  } catch (error) {
    console.error('Error loading stats:', error);
    return {
      pending: 0,
      processing: 0,
      completedToday: 0,
    };
  }
};

// =======================================================================
// MERCHANT STATUS & PREFERENCES
// =======================================================================

export const toggleOnlineStatus = async (isOnline: boolean): Promise<MerchantProfile> => {
  const data = await request<any>(ENDPOINTS.AUTH.STATUS, {
    method: 'PUT',
    body: JSON.stringify({ isOnline }),
  });
  return data.merchant || data;
};

export const updatePreferences = async (preferences: {
  acceptsDeposits?: boolean;
  acceptsWithdrawals?: boolean;
}): Promise<MerchantProfile> => {
  const data = await request<any>(ENDPOINTS.AUTH.PREFERENCES, {
    method: 'PUT',
    body: JSON.stringify(preferences),
  });
  return data.merchant || data;
};

/**
 * A CASH team member says they are at the machine (or no longer are).
 *
 * A cash buy is routed only to a member who is Ready, and the assignment that
 * hands them one switches Ready off in the same transaction — so the value the
 * panel shows is the PROFILE's `cashReady`, refreshed after this call and when
 * a new order arrives, never a flag kept here. A merchant who is not an
 * approved member of a CASH team is refused 409 with a sentence naming what to
 * do; the error carries it (`request` puts the server's message on the Error).
 * backend/domains/merchant/merchant.routes.js PUT /cash-ready.
 */
export const setCashReady = async (ready: boolean): Promise<boolean> => {
  const data = await request<{ success: boolean; ready: boolean }>(ENDPOINTS.AUTH.CASH_READY, {
    method: 'PUT',
    body: JSON.stringify({ ready }),
  });
  return data.ready === true;
};

// =======================================================================
// PROFILE UPDATE (FIX M6)
// =======================================================================

// Bank details only: a merchant holds no USDT address, since USDT buys are paid
// to the platform (owner, 2026-10-18).
export const updateProfile = async (data: {
  bankDetails: { accountHolderName?: string; bankName?: string; accountNo?: string; ifsc?: string };
  // The UPI ID a UPI buy's link is built from (owner, 2026-10-21); '' clears it.
  upiId?: string;
}): Promise<any> => {
  const result = await request<any>(ENDPOINTS.PROFILE.UPDATE, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  return result.merchant || result;
};

// =======================================================================
// WEEKLY EARNINGS (FIX M4)
// =======================================================================

export const getWeeklyEarnings = async (): Promise<{ weekly: Array<{
  date: string; earnings: number; orders: number; depositVolume: number; withdrawalVolume: number;
}> }> => {
  const data = await request<any>(ENDPOINTS.EARNINGS.WEEKLY);
  return { weekly: data.weekly || [] };
};




export const formatTime = (dateString: string | number): string => {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
};


// =======================================================================
// EXPORT ALL API FUNCTIONS
// =======================================================================

// =======================================================================
// SUPERVISORS AND TEAMS (redesign Step 2a)
// =======================================================================

export const getMyTeam = async (): Promise<MyTeam> => request<MyTeam>(ENDPOINTS.TEAM.MINE);

export const createTeam = async (name: string): Promise<Team> =>
  (await request<{ team: Team }>(ENDPOINTS.TEAM.CREATE, { method: 'POST', body: JSON.stringify({ name }) })).team;

export const renameTeam = async (teamId: string, name: string): Promise<Team> =>
  (await request<{ team: Team }>(ENDPOINTS.TEAM.RENAME(teamId), { method: 'PUT', body: JSON.stringify({ name }) })).team;

export const deleteTeam = async (teamId: string): Promise<void> => {
  await request(ENDPOINTS.TEAM.DELETE(teamId), { method: 'DELETE' });
};

/** By merchant ID or the public ref shown on their Profile. PENDING until an admin approves. */
export const addTeamMember = async (teamId: string, merchantRef: string): Promise<string> =>
  (await request<{ message: string }>(ENDPOINTS.TEAM.ADD_MEMBER(teamId), {
    method: 'POST', body: JSON.stringify({ merchantRef }),
  })).message;

export const removeTeamMember = async (teamId: string, merchantId: string): Promise<void> => {
  await request(ENDPOINTS.TEAM.REMOVE_MEMBER(teamId, merchantId), { method: 'DELETE' });
};

/** A team's pool and its ledger, newest first (Step 2b). */
export const getTeamPool = async (teamId: string): Promise<{ pool: TeamPool; entries: TeamPoolEntry[] }> =>
  request<{ pool: TeamPool; entries: TeamPoolEntry[] }>(ENDPOINTS.TEAM.POOL(teamId));

/** Start (`true`) or stop a team pool's cash out (owner, 2026-10-21). */
export const setTeamCashOut = async (teamId: string, start: boolean): Promise<CashOut> =>
  (await request<{ cashOut: CashOut }>(ENDPOINTS.TEAM.CASH_OUT(teamId), { method: start ? 'POST' : 'DELETE' })).cashOut;

/** Buy pool tokens from the platform in USDT: the request, with where to pay (owner, 2026-10-21). */
export const buyTeamPoolUsdt = async (teamId: string, tokenAmount: number): Promise<TeamPoolRequest> =>
  (await request<{ request: TeamPoolRequest }>(ENDPOINTS.TEAM.POOL_USDT_BUY(teamId), {
    method: 'POST', body: JSON.stringify({ tokenAmount }),
  })).request;

export const cancelTeamPoolRequest = async (requestId: string): Promise<void> => {
  await request(ENDPOINTS.TEAM.POOL_CANCEL(requestId), { method: 'DELETE' });
};

// ── Oversight (Step 2f) ──────────────────────────────────────────────────────

/** One member's orders on the supervisor's teams and their online stretches, last 7 days. */
export const getMemberLog = async (merchantId: string): Promise<MemberLog> =>
  request<MemberLog>(ENDPOINTS.TEAM.MEMBER_LOG(merchantId));

/** Disputes on the supervisor's teams: open first, then the last 30 days. */
export const getTeamDisputes = async (): Promise<SupervisorOrder[]> =>
  (await request<{ disputes: SupervisorOrder[] }>(ENDPOINTS.TEAM.DISPUTES)).disputes;

export const getDisputeThread = async (orderId: string): Promise<{ order: SupervisorOrder; messages: DisputeThreadMessage[] }> =>
  request<{ order: SupervisorOrder; messages: DisputeThreadMessage[] }>(ENDPOINTS.TEAM.DISPUTE_CHAT(orderId));

/** The supervisor speaks for their member to the dispute manager. No mobile numbers. */
export const postDisputeMessage = async (orderId: string, message: string): Promise<DisputeThreadMessage> =>
  (await request<{ message: DisputeThreadMessage }>(ENDPOINTS.TEAM.DISPUTE_CHAT(orderId), {
    method: 'POST', body: JSON.stringify({ message }),
  })).message;

// =======================================================================
// MERCHANT ACCOUNTS (owner, 2026-10-11 — Phase B)
// =======================================================================
// backend/domains/merchant/merchantAccount.routes.js. Every write is the
// owner's (403 OWNER_ONLY otherwise); reports are the owner's and AUDIT's. A
// refusal is thrown with the server's own words, status and body (`request`).

type AccountEndpoint<A extends unknown[]> = { method: string; path: (...args: A) => string };

/** One call to a merchant-account route, by the verb its ENDPOINTS entry declares. */
function accountRequest<T, A extends unknown[]>(endpoint: AccountEndpoint<A>, args: A, body?: unknown): Promise<T> {
  return request<T>(endpoint.path(...args), {
    method: endpoint.method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export const getMerchantAccount = async (): Promise<MerchantAccountOverview> =>
  accountRequest<MerchantAccountOverview, []>(ENDPOINTS.ACCOUNT.OVERVIEW, []);

/** What the owner sends for an account. `upiLink` is what the scanner read off their static UPI QR. */
export interface PaymentAccountInput {
  kind?: PaymentAccountKind;
  label?: string;
  upiLink?: string;
  holderName?: string;
  accountNo?: string;
  ifsc?: string;
  bankName?: string;
  acceptsDeposits?: boolean;
  paysWithdrawals?: boolean;
  buySizes?: number[];
  sellSizes?: number[];
  status?: 'ACTIVE' | 'PAUSED';
}

/** Which sizes go to which account, every account in one save (refused 409 SIZES_UNCOVERED if one is left out). */
export const setPaymentAccountSizes = async (
  accounts: Array<{ accountId: string; buySizes: number[]; sellSizes: number[] }>,
): Promise<PaymentAccount[]> =>
  (await accountRequest<{ accounts: PaymentAccount[] }, []>(ENDPOINTS.ACCOUNT.SET_SIZES, [], { accounts })).accounts;

export const addPaymentAccount = async (input: PaymentAccountInput): Promise<PaymentAccount> =>
  (await accountRequest<{ account: PaymentAccount }, []>(ENDPOINTS.ACCOUNT.ADD_ACCOUNT, [], input)).account;

export const updatePaymentAccount = async (accountId: string, patch: PaymentAccountInput): Promise<PaymentAccount> =>
  (await accountRequest<{ account: PaymentAccount }, [string]>(ENDPOINTS.ACCOUNT.UPDATE_ACCOUNT, [accountId], patch)).account;

export const removePaymentAccount = async (accountId: string): Promise<void> => {
  await accountRequest(ENDPOINTS.ACCOUNT.REMOVE_ACCOUNT, [accountId]);
};

export const addSubMember = async (input: {
  mobile: string; name: string; roles: StaffRole[];
}): Promise<SubMember> =>
  (await accountRequest<{ staff: SubMember }, []>(ENDPOINTS.ACCOUNT.ADD_STAFF, [], input)).staff;

export const setSubMemberRoles = async (staffId: string, roles: StaffRole[]): Promise<SubMember> =>
  (await accountRequest<{ staff: SubMember }, [string]>(ENDPOINTS.ACCOUNT.SET_STAFF_ROLES, [staffId], { roles })).staff;

export const removeSubMember = async (staffId: string): Promise<void> => {
  await accountRequest(ENDPOINTS.ACCOUNT.REMOVE_STAFF, [staffId]);
};

export const assignSubMemberAccount = async (staffId: string, accountId: string, duty: StaffDuty): Promise<SubMember> =>
  (await accountRequest<{ staff: SubMember }, [string]>(ENDPOINTS.ACCOUNT.ASSIGN_ACCOUNT, [staffId], { accountId, duty })).staff;

export const unassignSubMemberAccount = async (staffId: string, accountId: string, duty: StaffDuty): Promise<SubMember> =>
  (await accountRequest<{ staff: SubMember }, [string, string, string]>(
    ENDPOINTS.ACCOUNT.UNASSIGN_ACCOUNT, [staffId, accountId, duty])).staff;

/** Start (`true`) or stop the merchant account's cash out (owner, 2026-10-21). */
export const setMerchantCashOut = async (start: boolean): Promise<CashOut> =>
  (await accountRequest<{ cashOut: CashOut }, []>(
    start ? ENDPOINTS.ACCOUNT.START_CASH_OUT : ENDPOINTS.ACCOUNT.STOP_CASH_OUT, [])).cashOut;

/** A merchant account buys pool tokens in USDT: the request, with where to pay (owner, 2026-10-21). */
export const buyMerchantPoolUsdt = async (tokens: number): Promise<TeamPoolRequest> =>
  (await accountRequest<{ request: TeamPoolRequest }, []>(ENDPOINTS.ACCOUNT.BUY_POOL_USDT, [], { tokens })).request;

export const cancelMerchantPoolRequest = async (requestId: string): Promise<void> => {
  await accountRequest(ENDPOINTS.ACCOUNT.CANCEL_POOL, [requestId]);
};

/** A range of IST days as YYYY-MM-DD; empty means the server's default (the last seven). */
const rangeQuery = (from: string, to: string): string => {
  const q = new URLSearchParams();
  if (from) q.append('from', from);
  if (to) q.append('to', to);
  return q.toString() ? `?${q.toString()}` : '';
};

export const getMerchantReport = async (from: string, to: string): Promise<MerchantReport> =>
  request<MerchantReport>(`${ENDPOINTS.ACCOUNT.REPORTS.path()}${rangeQuery(from, to)}`, {
    method: ENDPOINTS.ACCOUNT.REPORTS.method,
  });

/** Which orders a report covers: IST days (empty: the last seven) and a direction. */
export interface OrderReportQuery { from: string; to: string; type?: '' | 'DEPOSIT' | 'WITHDRAWAL'; }

const orderReportQuery = ({ from, to, type }: OrderReportQuery, page?: { limit: number; skip: number }): string => {
  const q = new URLSearchParams();
  if (from) q.append('from', from);
  if (to) q.append('to', to);
  if (type) q.append('type', type);
  if (page) { q.append('limit', String(page.limit)); q.append('skip', String(page.skip)); }
  return q.toString() ? `?${q.toString()}` : '';
};

/** One page of the order report, with totals over every row of the range. */
export const getOrderReport = async (query: OrderReportQuery, page: { limit: number; skip: number }): Promise<OrderReport> =>
  request<OrderReport>(`${ENDPOINTS.ORDER_REPORT.PAGE}${orderReportQuery(query, page)}`);

/**
 * A workbook the server builds, saved by the browser. Fetched with the
 * session's token (a plain link would carry none), then handed to the browser
 * as a download under the server's name. A refusal is thrown with the
 * server's words.
 */
const downloadWorkbook = async (path: string, fallbackName: string): Promise<void> => {
  const token = getAuthToken();
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    mode: 'cors',
    credentials: 'omit',
  });
  if (!response.ok) {
    let said = `The download failed (status ${response.status}).`;
    try {
      const body = await response.json();
      if (typeof body?.message === 'string' && body.message) said = body.message;
    } catch { /* not JSON: keep the status sentence */ }
    throw Object.assign(new Error(said), { status: response.status });
  }
  const named = /filename="?([^";]+)"?/.exec(response.headers.get('content-disposition') || '')?.[1];
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = named || fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** The order report as an Excel workbook: buys and sells in their own tables. */
export const downloadOrderReport = (query: OrderReportQuery): Promise<void> =>
  downloadWorkbook(`${ENDPOINTS.ORDER_REPORT.XLSX}${orderReportQuery(query)}`,
    `merchant-orders-${query.from || 'last7'}-${query.to || 'today'}.xlsx`);

/** The business ledger over IST days (empty: the last seven), with its totals. */
export const getBusinessLedger = async (from: string, to: string): Promise<BusinessLedger> =>
  request<BusinessLedger>(`${ENDPOINTS.LEDGER.PAGE}${rangeQuery(from, to)}`);

/** The same ledger as an Excel workbook, one labelled table per kind. */
export const downloadBusinessLedger = (from: string, to: string): Promise<void> =>
  downloadWorkbook(`${ENDPOINTS.LEDGER.XLSX}${rangeQuery(from, to)}`, `business-ledger-${from || 'last7'}-${to || 'today'}.xlsx`);

/** The pool statement (owner, 2026-10-22): opening and closing balance and every order between. */
export const getPoolStatement = async (from: string, to: string): Promise<PoolStatement> =>
  request<PoolStatement>(`${ENDPOINTS.STATEMENT.PAGE}${rangeQuery(from, to)}`);

/** The same statement as an Excel workbook. */
export const downloadPoolStatement = (from: string, to: string): Promise<void> =>
  downloadWorkbook(`${ENDPOINTS.STATEMENT.XLSX}${rangeQuery(from, to)}`, `pool-statement-${from || 'last7'}-${to || 'today'}.xlsx`);

export const api = {
  // Auth
  isAuthenticated,
  getCurrentMerchant,
  startTelegramSignIn,
  pollTelegramSignIn,
  redeemTelegramTicket,
  getMiniAppSetup,
  logout,
  signedOutReason,
  getMerchantProfile,
  
  // Orders
  getOrders,
  confirmPayment,
  rejectOrder,
  rejectPaidOrder,
  
  
  attachCashLink,

  // Dispute
  redFlagOrder,
  
  // Stats
  getEarnings,
  getWeeklyEarnings,
  getStats,

  // Status
  toggleOnlineStatus,
  updatePreferences,
  updateProfile,

  // Merchant accounts (owner, 2026-10-11)
  getMerchantAccount,
  addPaymentAccount,
  updatePaymentAccount,
  removePaymentAccount,
  setPaymentAccountSizes,
  addSubMember,
  setSubMemberRoles,
  removeSubMember,
  assignSubMemberAccount,
  unassignSubMemberAccount,
  buyMerchantPoolUsdt,
  setMerchantCashOut,
  setTeamCashOut,
  cancelMerchantPoolRequest,
  getMerchantReport,
  getOrderReport,
  downloadOrderReport,
  getBusinessLedger,
  getPoolStatement,
  downloadPoolStatement,
  downloadBusinessLedger,

  // Red Flag
  // Utilities
  formatTime,
  // Direct request function for custom calls
  request,
};

export default api;

// =======================================================================
// SUPPORT DESK (CLAUDE.md §2, "Support desks"; owner, 2026-10-21)
// =======================================================================

export interface SupportTopic { key: string; label: string }
export interface SupportDeskInfo {
  topics: SupportTopic[]; historyDays: number; descriptionMin: number; descriptionMax: number;
  referenceMax: number; openedToday: boolean; nextTicketAt: string;
  /** The support account to message straight away (`directContact`), or null when none is set up. */
  directContact?: { telegramUsername: string; telegramLink: string } | null;
}
export interface SupportTicket {
  ticketId: string; code: string; topic: string; subject: string; reference: string;
  status: string; createdAt: string; rating: number | null;
  telegramUsername: string | null; telegramLink: string;
}
export interface SupportNote { id: number; senderType: 'USER' | 'AGENT' | 'SYSTEM'; content: string; createdAt: string }

export const getSupportDesk = (): Promise<SupportDeskInfo> => request('/api/merchant/support/desk');
export const getSupportTickets = async (): Promise<SupportTicket[]> =>
  (await request<{ tickets: SupportTicket[] }>('/api/merchant/support/tickets')).tickets;
export const getSupportTicket = (ticketId: string): Promise<{ ticket: SupportTicket; messages: SupportNote[] }> =>
  request(`/api/merchant/support/tickets/${encodeURIComponent(ticketId)}`);
export const openSupportTicket = async (body: { topic: string; reference: string; description: string }): Promise<SupportTicket> =>
  (await request<{ ticket: SupportTicket }>('/api/merchant/support/tickets', { method: 'POST', body: JSON.stringify(body) })).ticket;
export const rateSupportTicket = (ticketId: string, rating: number): Promise<unknown> =>
  request(`/api/merchant/support/tickets/${encodeURIComponent(ticketId)}/rate`, { method: 'POST', body: JSON.stringify({ rating }) });
/** The Dispute Manager's Telegram, on an order of this merchant's that is DISPUTED. */
export const getDisputeContact = async (orderId: string): Promise<{ telegramLink: string } | null> =>
  (await request<{ contact: { telegramLink: string } | null }>(`/api/merchant/support/dispute-contact/${encodeURIComponent(orderId)}`)).contact;
