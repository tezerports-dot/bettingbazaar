// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import {
  MerchantProfile,
  PaymentOrder,
  AuthResponse,
  Earnings,
  Stats,
  MyTeam,
  Team,
  PoolDirection,
  TeamPool,
  TeamPoolEntry,
  MemberLog,
  SupervisorOrder,
  DisputeThreadMessage,
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
      credentials: 'include',
    });
    
    if (response.status === 401) {
      const hadSession = !!getAuthToken();
      clearAuthData();
      // Read the actual error message from the backend response
      let errMsg = ERROR_MESSAGES.SESSION_EXPIRED;
      try {
        const errData = await response.clone().json();
        if (errData?.message) errMsg = errData.message;
      } catch { /* ignore parse errors */ }
      if (hadSession) {
        keepSignedOutReason(errMsg);
        window.location.href = '/merchant/';
      }
      throw new Error(errMsg);
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

export const merchantLogin = async (mobile: string, password: string): Promise<AuthResponse> => {
  try {
    // FIX 2: No longer sends loginType -- the dedicated merchant endpoint handles auth
    const data = await request<AuthResponse>(ENDPOINTS.AUTH.LOGIN, {
      method: 'POST',
      body: JSON.stringify({ mobile, password }),
    });
    
    // 2FA: a 200 with success:false and a challenge. NOT an error — the
    // password was accepted; the login is half done. Store nothing: the
    // challenge is not a session and must never reach the Authorization
    // header, so it is returned to the caller and held in memory only.
    if (data.twoFactorRequired && data.challengeToken) {
      return data;
    }

    if (data.token) {
      localStorage.setItem('merchantToken', data.token);
    }

    const merchant = data.user || data.merchant;
    if (merchant) {
      setMerchantData(merchant);
    }

    return data;
  } catch (error: any) {
    throw new Error(error.message || 'Login failed');
  }
};

/** Second leg of the merchant login: exchange the challenge for a session. */
export const merchantLoginTwoFactor = async (challengeToken: string, code: string): Promise<AuthResponse> => {
  const data = await request<AuthResponse>(ENDPOINTS.AUTH.LOGIN_2FA, {
    method: 'POST',
    body: JSON.stringify({ challengeToken, code }),
  });
  if (data.token) localStorage.setItem('merchantToken', data.token);
  const merchant = data.user || data.merchant;
  if (merchant) setMerchantData(merchant);
  return data;
};

// --- 2FA enrolment (merchants are a separate model from users) ---------------
export const twoFactorStatus = async () =>
  request<{ success: boolean; enabled: boolean; mandatory: boolean; backupCodesRemaining: number }>(
    ENDPOINTS.AUTH.TWO_FA_STATUS, { method: 'GET' });

export const twoFactorSetup = async () =>
  request<{ success: boolean; secret: string; otpauthUri: string; message?: string }>(
    ENDPOINTS.AUTH.TWO_FA_SETUP, { method: 'POST', body: JSON.stringify({}) });

export const twoFactorActivate = async (code: string) =>
  request<{ success: boolean; backupCodes: string[]; message?: string }>(
    ENDPOINTS.AUTH.TWO_FA_ACTIVATE, { method: 'POST', body: JSON.stringify({ code }) });

// FIX 2: New -- allows merchants to self-register; admin must approve before they can login
export const merchantSignup = async (fields: {
  username: string;
  mobile: string;
  email?: string;
  password: string;
  confirmPassword: string;
}): Promise<{ success: boolean; message: string }> => {
  try {
    const data = await request<{ success: boolean; message: string }>(ENDPOINTS.AUTH.SIGNUP, {
      method: 'POST',
      body: JSON.stringify(fields),
    });
    return data;
  } catch (error: any) {
    throw new Error(error.message || 'Signup failed');
  }
};

/** Sign out and reload at the sign-in form; `reason` is the server's refusal, shown there once. */
export const logout = (reason?: string | null): void => {
  clearAuthData();
  keepSignedOutReason(reason);
  window.location.href = "/merchant/";
};

/**
 * The answer to "may this merchant use the panel yet, and if not, what next?"
 *
 * The SAME shape the player and admin panels receive, because one server
 * function is mounted on all three (§5). A merchant verifies through the
 * MERCHANT bot and the MERCHANT channel — their own, never the player ones —
 * and the server decides that from `users.account_type`, so nothing here has to
 * name a panel.
 */
export interface MerchantVerification {
  success: boolean;
  verified: boolean;
  bootstrap: boolean;
  audience: 'PLAYER' | 'MERCHANT' | 'STAFF';
  reason: string | null;
  contactShared: boolean;
  channelJoined: boolean;
  bot: { username: string } | null;
  botLink: string;
  channel: { inviteLink: string; username: string };
  generation: number;
  throttled?: boolean;
}

/**
 * Cache-only unless `verify` is passed.
 *
 * Joining a channel emits a `chat_member` update and the webhook writes the
 * cache within about a second, so the poll costs one indexed row read and never
 * touches Telegram. `verify` is what the "I've done it" button sends, once; the
 * server floors it per account.
 */
export const getVerification = async (opts: { verify?: boolean } = {}): Promise<MerchantVerification> => {
  // Two whole literals rather than one interpolated path — see the note on the
  // admin panel's copy. `check:ui-coverage` follows the string at the call
  // site, and a path it cannot read is a call it cannot prove reaches a route.
  return opts.verify
    ? request<MerchantVerification>('/api/merchant/verification?verify=1')
    : request<MerchantVerification>('/api/merchant/verification');
};

export const getMerchantProfile = async (): Promise<MerchantProfile> => {
  const data = await request<any>(ENDPOINTS.AUTH.PROFILE);
  return data.merchant || data;
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

export const acceptOrder = async (orderId: string): Promise<PaymentOrder> => {
  const data = await request<any>(ENDPOINTS.ORDERS.ACCEPT(orderId), {
    method: 'POST',
  });
  return data.order || data;
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
export const confirmPayment = async (orderId: string, utrNumber?: string): Promise<PaymentOrder> => {
  const data = await request<any>(ENDPOINTS.ORDERS.CONFIRM(orderId), {
    method: 'POST',
    ...(utrNumber ? { body: JSON.stringify({ utrNumber }) } : {}),
  });
  return data.order || data;
};

/**
 * Reject an order the player says they paid, because the money never arrived.
 *
 * Different from `rejectOrder` below, which declines an order BEFORE payment
 * and returns it to the queue. This one rejects a PAID buy (only a PAID one:
 * owner, 2026-10-07) and adds a warning and a flag to the player's account —
 * so the backend requires a reason of at least ten characters and a proof
 * image, and refuses without either.
 *
 * Three steps, in this order: ask for a presigned URL (which also checks the
 * order is this merchant's PAID buy, or answers 400 NOT_PAID_YET), PUT the
 * file, then send the reference. The proof is verified server-side against
 * THIS merchant and THIS order before it is stored, so a key from somewhere
 * else is refused.
 */
export const rejectPaidOrder = async (
  orderId: string, reason: string, proof: File,
): Promise<PaymentOrder> => {
  const presigned = await request<any>(ENDPOINTS.ORDERS.REJECT_PROOF_UPLOAD_URL(orderId), {
    method: 'POST',
    body: JSON.stringify({ fileName: proof.name, contentType: proof.type, fileSize: proof.size }),
  });
  if (!presigned?.uploadUrl || !presigned?.fileKey) {
    throw new Error('Could not prepare the proof upload');
  }

  const put = await fetch(presigned.uploadUrl, {
    method: 'PUT', body: proof, headers: { 'Content-Type': proof.type },
  });
  if (!put.ok) throw new Error('The proof image failed to upload');

  const data = await request<any>(ENDPOINTS.ORDERS.REJECT_PAID(orderId), {
    method: 'POST',
    body: JSON.stringify({
      reason, proofFileKey: presigned.fileKey, proofCdnUrl: presigned.cdnUrl,
    }),
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

// The backend enforces rail exclusivity on this endpoint: an INR merchant may
// send bankDetails, a USDT merchant may send only the wallet addresses. Sending a field for the wrong rail is a 400, not a silent no-op
// (backend/domains/merchant/merchant.routes.js PUT /profile).
//
// The two addresses are independent: send one to set it, send an empty string
// to clear that chain, omit it to leave it alone. Clearing the LAST one is
// refused — a merchant with no address receives no orders, and that is worth
// saying rather than accepting silently.
export const updateProfile = async (data: {
  bankDetails?: { accountHolderName?: string; bankName?: string; accountNo?: string; ifsc?: string };
  usdtAddressTrc20?: string;
  usdtAddressBep20?: string;
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

export const getWeeklyEarnings = async (): Promise<{ weekly: Array<{ date: string; earnings: number; orders: number }> }> => {
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

/** BUY asks the platform for tokens; SELL asks it to buy pool tokens back. Whole tokens. */
export const requestTeamPool = async (
  teamId: string, direction: PoolDirection, tokenAmount: number, note: string,
): Promise<string> =>
  (await request<{ message: string }>(ENDPOINTS.TEAM.POOL_REQUEST(teamId), {
    method: 'POST', body: JSON.stringify({ direction, tokenAmount, note: note || null }),
  })).message;

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

export const api = {
  // Auth
  isAuthenticated,
  getCurrentMerchant,
  merchantLogin,
  merchantLoginTwoFactor,
  twoFactorStatus,
  twoFactorSetup,
  twoFactorActivate,
  merchantSignup,
  logout,
  signedOutReason,
  getMerchantProfile,
  getVerification,
  
  // Orders
  getOrders,
  acceptOrder,
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

  // Red Flag
  // Utilities
  formatTime,
  // Direct request function for custom calls
  request,
};

export default api;
