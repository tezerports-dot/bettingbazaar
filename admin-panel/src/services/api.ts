// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import axios, { AxiosInstance, AxiosError } from 'axios';
import { endRefusedSession, serverRefusal } from './signedOut';
import type { StaffPermissionCatalog } from '../utils/permissions';
import type {
  Admin,
  Branding,
  FAQ,
  SupportLinks,
  SupervisorRail, TeamSupervisor, TeamView, TeamMemberView, TeamPoolRequest, TeamRedFlag,
} from '../types';

const _adminViteUrl = import.meta.env.VITE_API_URL as string | undefined;
const _adminIsLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
if (!_adminViteUrl && !_adminIsLocal) {
  throw new Error('[FATAL] VITE_API_URL is not set for the admin panel. Set it (at build time) to the backend URL, e.g. https://your-domain.example — see docs/GO_LIVE_RUNBOOK.md.');
}
const API_URL = _adminViteUrl?.replace(/\/$/, '') || 'http://localhost:8080';

const api: AxiosInstance = axios.create({
  baseURL: API_URL,
  timeout: 30000,
  withCredentials: false,  // Using JWT Bearer tokens -- cookies are not used
  headers: { 'Content-Type': 'application/json' },
});

/** The session this browser holds, from the store's persisted envelope (`auth.ts`). */
const storedToken = (): string | null => {
  try {
    const stored = localStorage.getItem('admin-auth');
    return stored ? (JSON.parse(stored)?.state?.token ?? null) : null;
  } catch {
    return null;
  }
};

api.interceptors.request.use(
  (config) => {
    const token = storedToken();
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  },
  (error) => Promise.reject(error)
);

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    // Only a session that was HELD ends here. A 401 with none is the sign-in
    // form's own answer ("Invalid credentials", a wrong second-factor code):
    // reloading over it erased the message before anybody read it.
    if (error.response?.status === 401 && storedToken()) {
      endRefusedSession(serverRefusal(error.response.data));
    }
    // A held session that Telegram never approved is not a session: the 403
    // `TWO_FACTOR_REQUIRED` every staff route answers once a bot is saved over a
    // bootstrap (password-only) session. Any other 403 is "not permitted",
    // which ends nothing.
    const body = error.response?.data as { code?: unknown } | undefined;
    if (error.response?.status === 403 && body?.code === 'TWO_FACTOR_REQUIRED' && storedToken()) {
      endRefusedSession(serverRefusal(error.response.data));
    }
    return Promise.reject(error);
  }
);

// --- AUTH ---------------------------------------------------------------------
/**
 * The staff door (`/api/admin/login…`, backend/domains/identity/loginDoors.js).
 * Every staff sign-in is approved in Telegram (Step 3): the password leg
 * answers with a Telegram step, never a session, unless the platform is in the
 * bootstrap (no bot saved yet), when it answers a password-only session with
 * `bootstrap: true`.
 */

/** A staff session as the door sends it: `{ token, user, bootstrap? }`. */
export interface StaffSession {
  token: string;
  admin: Admin;
  /** No bot saved yet: this session is a password alone (§33 bootstrap). */
  bootstrap: boolean;
}

/** What the password leg answered. */
export type LoginAnswer =
  | { kind: 'session'; session: StaffSession }
  /**
   * Approve in Telegram, then poll `/login/2fa`: either a sign-in to approve
   * (200 `twoFactorRequired`) or a first verification of this account's mobile
   * (403 `TELEGRAM_VERIFICATION_REQUIRED`). The panel treats both the same.
   */
  | { kind: 'telegram'; challengeToken: string; telegram: TelegramBlock | null; message: string };

/** One poll of `/login/2fa`. A refusal (401 DENIED/EXPIRED, an account refusal) throws. */
export type PollAnswer = { kind: 'pending' } | { kind: 'session'; session: StaffSession };

/** One poll of `/login/telegram/complete`. A refusal throws. */
export type TelegramLoginAnswer = { kind: 'pending' } | { kind: 'passwordRequired' };

const sessionOf = (data: any): StaffSession | null =>
  data?.success && data?.token
    ? { token: data.token, admin: data.user, bootstrap: data.bootstrap === true }
    : null;

/** A 2xx the panel has no branch for, thrown in the shape every caller reads. */
const unexpected = (status: number, data: any): Error =>
  Object.assign(new Error(data?.message || 'Sign-in failed. Please try again.'), { response: { status, data } });

export const auth = {
  /**
   * The password leg. `challengeToken` is sent only to finish a "Login with
   * Telegram" whose approval has already arrived (`passwordRequired`).
   *
   * loginType:
   *   'admin'         -- full admin
   *   'subadmin'      -- sub-admin
   *   'queue_manager' -- queue manager (sees only queue dashboard)
   */
  login: async (
    mobile: string,
    password: string,
    loginType: 'admin' | 'subadmin' | 'queue_manager' = 'admin',
    challengeToken?: string,
  ): Promise<LoginAnswer> => {
    try {
      const res = await api.post<any>('/api/admin/login', {
        mobile, password, loginType, ...(challengeToken ? { challengeToken } : {}),
      });
      const session = sessionOf(res.data);
      if (session) return { kind: 'session', session };
      // Not an error: the password was accepted and Telegram is next.
      if (res.data?.twoFactorRequired && res.data?.challengeToken) {
        return {
          kind: 'telegram', challengeToken: res.data.challengeToken,
          telegram: res.data.telegram ?? null, message: res.data.message || '',
        };
      }
      throw unexpected(res.status, res.data);
    } catch (err: any) {
      const data = err?.response?.data;
      if (err?.response?.status === 403 && data?.code === 'TELEGRAM_VERIFICATION_REQUIRED' && data?.challengeToken) {
        return { kind: 'telegram', challengeToken: data.challengeToken, telegram: data.telegram ?? null, message: data.message || '' };
      }
      throw err;
    }
  },

  /** Has Telegram answered? 202 keeps polling; a session signs in. */
  loginTwoFactor: async (challengeToken: string): Promise<PollAnswer> => {
    const res = await api.post<any>('/api/admin/login/2fa', { challengeToken });
    if (res.status === 202) return { kind: 'pending' };
    const session = sessionOf(res.data);
    if (session) return { kind: 'session', session };
    throw unexpected(res.status, res.data);
  },

  /** "Login with Telegram", from the browser: a challenge and its Mini App link. */
  telegramLogin: async () => {
    const res = await api.post<any>('/api/admin/login/telegram', {});
    if (res.data?.pending && res.data?.challengeToken) {
      return {
        challengeToken: res.data.challengeToken as string,
        telegram: (res.data.telegram ?? null) as TelegramBlock | null,
        message: (res.data.message || '') as string,
      };
    }
    throw unexpected(res.status, res.data);
  },

  /** Has the Mini App approved the "Login with Telegram"? Then the password is next. */
  telegramLoginComplete: async (challengeToken: string): Promise<TelegramLoginAnswer> => {
    const res = await api.post<any>('/api/admin/login/telegram/complete', { challengeToken });
    if (res.status === 202) return { kind: 'pending' };
    if (res.data?.passwordRequired) return { kind: 'passwordRequired' };
    throw unexpected(res.status, res.data);
  },

  logout: async () => {
    try {
      await api.post('/api/v1/auth/logout');
    } catch {}
  },

  verifySession: async () => {
    const res = await api.get<any>('/api/v1/auth/me');
    if (res.data?.success && res.data?.user) {
      // `bootstrap` is re-stated on every load: it ends the moment a bot is
      // saved, and a banner read only at sign-in would outlive it.
      return {
        success: true,
        data: { admin: res.data.user as Admin },
        bootstrap: res.data.bootstrap === true,
      };
    }
    return res.data;
  },
};

// --- ANALYTICS ---------------------------------------------------------------

export const analytics = {
  getDashboard: async () => {
    const res = await api.get<any>('/api/admin/analytics/dashboard');
    if (res.data?.success && res.data?.metrics) {
      return { success: true, data: res.data.metrics };
    }
    return res.data;
  },

  getFinancials: async (startDate?: string, endDate?: string) => {
    const res = await api.get<any>('/api/admin/analytics/financials', {
      params: { startDate, endDate },
    });
    return res.data;
  },
};

// --- USERS --------------------------------------------------------------------

export const users = {
  getAll: async (page = 1, limit = 50, search?: string, status?: string) => {
    const res = await api.get<any>('/api/admin/users', { params: { page, limit, search, status } });
    if (res.data?.success && res.data?.users) {
      return { success: true, data: res.data.users, pagination: res.data.pagination };
    }
    return res.data;
  },

  /**
   * Adjust a player's balance. ONE route, `POST /api/admin/balance-adjust`,
   * shared with the dedicated Balance Adjustment screen.
   *
   * This used to post to `/api/admin/users/:userId/adjust-balance`, a second
   * admin route doing the same job with different side effects — it wrote no
   * bonus record and let the reason be omitted. Both were live, so a credit
   * meant different things depending on which screen issued it (§5).
   *
   * The signed amount stays HERE, as the caller's convenience: the Users screen
   * thinks in "add ₹500 / deduct ₹500", and the route thinks in CREDIT/DEBIT
   * with a positive magnitude. Translating at the boundary keeps both honest.
   */
  adjustBalance: async (userId: string, amount: number, reason: string, walletType: 'depositBalance' | 'winningsBalance' = 'depositBalance') => {
    const res = await api.post('/api/admin/balance-adjust', {
      userId,
      type:   amount >= 0 ? 'CREDIT' : 'DEBIT',
      field:  walletType,
      amount: Math.abs(amount),
      reason,
    });
    return res.data;
  },

  blockUser: async (userId: string, reason: string) => {
    const res = await api.put(`/api/admin/users/${userId}/block`, { reason });
    return res.data;
  },

  // The review queue a merchant rejection feeds. `/users/flagged` is declared
  // ABOVE `/users/:userId` on the server — reordered, this path resolves to a
  // player id of "flagged" and 404s into an empty screen.
  getFlagged: async (limit = 100) => {
    const res = await api.get<any>('/api/admin/users/flagged', { params: { limit } });
    return res.data;
  },

  // "Reviewed, no action." Separate from unblock, which needs a blocked player
  // — and under the current rule a flagged player is not blocked.
  clearFlag: async (userId: string, resetWarnings = false, note?: string) => {
    const res = await api.post(`/api/admin/users/${userId}/clear-flag`, { resetWarnings, note });
    return res.data;
  },

  unblockUser: async (userId: string) => {
    const res = await api.put(`/api/admin/users/${userId}/unblock`);
    return res.data;
  },

  deleteUser: async (userId: string) => {
    const res = await api.delete(`/api/admin/users/${userId}`);
    return res.data;
  },

  getTransactions: async (userId: string) => {
    const res = await api.get<any>(`/api/admin/users/${userId}/transactions`);
    if (res.data?.success && res.data?.transactions) {
      return { success: true, data: res.data.transactions };
    }
    return res.data;
  },
};

// --- MERCHANTS ----------------------------------------------------------------

export const merchants = {
  getAll: async (page = 1, limit = 50, status?: string, search?: string) => {
    const res = await api.get<any>('/api/admin/merchants', { params: { page, limit, status, search } });
    if (res.data?.success && res.data?.merchants) {
      return { success: true, data: res.data.merchants, pagination: res.data.pagination };
    }
    return res.data;
  },

  getProfile: async (merchantId: string) => {
    const res = await api.get<any>(`/api/admin/merchants/${merchantId}/profile`);
    if (res.data?.success && res.data?.merchant) {
      return { success: true, data: res.data.merchant };
    }
    return res.data;
  },

  suspend: async (merchantId: string, reason: string) => {
    const res = await api.put(`/api/admin/merchants/${merchantId}/suspend`, { reason });
    return res.data;
  },

  activate: async (merchantId: string) => {
    const res = await api.put(`/api/admin/merchants/${merchantId}/activate`);
    return res.data;
  },

  getEarnings: async (merchantId: string) => {
    const res = await api.get<any>(`/api/admin/merchants/${merchantId}/earnings`);
    return res.data;
  },
  create: async (data: { username: string; mobile: string; password: string; email?: string }) => {
    const res = await api.post('/api/admin/merchants/create', data);
    return res.data;
  },

  approve: async (merchantId: string) => {
    const res = await api.put(`/api/admin/merchants/${merchantId}/approve`);
    return res.data;
  },

  // Lift an assignment pause after speaking to the merchant. Three buy orders
  // in a row expired with nobody paying, which usually means nobody CAN pay
  // them — a wrong or frozen bank account. It is not a suspension and they were
  // not accused of anything; an admin who has had the conversation clears it.
  resumeAssignment: async (merchantId: string, note?: string) => {
    const res = await api.put(`/api/admin/merchants/${merchantId}/resume-assignment`, { note });
    return res.data;
  },

  // FIX A3: Reject route -- backend PUT /merchants/:id/reject added in Batch 1
  reject: async (merchantId: string, reason: string) => {
    const res = await api.put(`/api/admin/merchants/${merchantId}/reject`, { reason });
    return res.data;
  },

  getOrders: async (merchantId: string) => {
    // /transactions, not /orders — the latter has never been served, so the
    // merchant detail drawer's Orders tab caught the 404 and rendered "No
    // orders found" for every merchant, however busy. The handler returns
    // `transactions`, carrying exactly the fields that tab renders.
    const res = await api.get<any>(`/api/admin/merchants/${merchantId}/transactions`);
    if (res.data?.success && res.data?.transactions) {
      return { success: true, data: res.data.transactions };
    }
    return res.data;
  },
};

// --- CYCLES ------------------------------------------------------------------

export const cycles = {
  getActive: async () => {
    const res = await api.get<any>('/api/cycles/active');
    if (res.data?.success && res.data?.cycles) {
      return { success: true, data: res.data.cycles };
    }
    return res.data;
  },

  getHistory: async (page = 1, limit = 50, type?: string) => {
    const res = await api.get<any>('/api/admin/cycles/history', { params: { page, limit, type } });
    // Backend returns { success, cycles, pagination }
    if (res.data?.success && res.data?.cycles) {
      return { success: true, data: res.data.cycles, pagination: res.data.pagination };
    }
    return res.data;
  },

  triggerEqualizer: async (cycleId: string) => {
    const res = await api.post(`/api/admin/cycles/${cycleId}/equalize`);
    return res.data;
  },

  pauseCycle: async (cycleId: string) => {
    const res = await api.post('/api/admin/manage-cycle', { action: 'PAUSE', cycleId });
    return res.data;
  },

  resumeCycle: async (cycleId: string) => {
    const res = await api.post('/api/admin/manage-cycle', { action: 'RESUME', cycleId });
    return res.data;
  },

  cancelCycle: async (cycleId: string, reason: string) => {
    const res = await api.post('/api/admin/manage-cycle', {
      action: 'CANCEL',
      cycleId,
      payload: { reason },
    });
    return res.data;
  },
};

// --- TOKEN RATES ---------------------------------------------------------------
// Removed 2026-07-08: token conversion is fixed 1:1 (Phase 006 flattening) —
// rates are no longer admin-editable and the backend endpoints are gone.

// --- DEPOSIT POLICY — Business Policy Platform (BBEPS Phase 006) --------------
// Whole-document versioned: see backend/domains/configuration/depositPolicy.*.js

export const depositPolicy = {
  getCurrent: async (currency: 'INR' | 'USDT') => {
    const res = await api.get<any>(`/api/admin/deposit-policy/${currency}`);
    return res.data;
  },

  getHistory: async (currency: 'INR' | 'USDT') => {
    const res = await api.get<any>(`/api/admin/deposit-policy/${currency}/history`);
    return res.data;
  },

  update: async (
    currency: 'INR' | 'USDT',
    fields: {
      depositAllocationPercent: number;
      reserveAllocationPercent: number;
      reserveUsageRules: { withdrawable: boolean; settlementBuffer: boolean; notes: string };
      justification: string;
      effectiveAt?: string;
      requireApproval?: boolean;
    }
  ) => {
    const res = await api.put(`/api/admin/deposit-policy/${currency}`, fields);
    return res.data;
  },

  approve: async (versionId: string, approve: boolean) => {
    const res = await api.post(`/api/admin/deposit-policy/version/${versionId}/approve`, { approve });
    return res.data;
  },

  rollback: async (versionId: string) => {
    const res = await api.post(`/api/admin/deposit-policy/version/${versionId}/rollback`);
    return res.data;
  },
};

// --- QUEUE MANAGER ------------------------------------------------------------

export const queueManager = {
  getPendingOrders: async () => {
    const res = await api.get<any>('/api/admin/queue/pending-orders');
    if (res.data?.success && res.data?.orders) {
      return { success: true, data: res.data.orders };
    }
    return res.data;
  },

  // Offer one queued order to the teams NOW instead of waiting for the sweep.
  // There is no merchant argument: routing picks the member (teamRouting), and
  // the server answers 409 NO_MEMBER_FREE, with a sentence naming why, when no
  // working team on the order's rail can take it.
  assignOrder: async (orderId: string) => {
    const res = await api.post(`/api/admin/queue/assign/${orderId}`);
    return res.data;
  },

  getGroupedQueue: async (status?: string) => {
    // FIX: p2p-queue route no longer exists post P2P->Merchant migration; use payment-queue (same response shape)
    const res = await api.get<any>('/api/admin/payment-queue', { params: status ? { status } : {} });
    return res.data;
  },

  
  // Take an ASSIGNED order off its member and offer it to the next one. No
  // body: the server routes it, and its message says whether anybody took it.
  reassignOrder: async (orderId: string) => {
    const res = await api.post(`/api/admin/payment-orders/${orderId}/reassign`);
    return res.data;
  },
};

// --- TELEGRAM -----------------------------------------------------------------
/**
 * One bot carries the Mini App that verifies every account and approves every
 * staff and merchant sign-in (Step 3; docs/PROJECT_STATUS.md, "API contract").
 * Server: backend/routes/admin/telegram.admin.routes.js and
 * backend/domains/telegram/miniApp.routes.js.
 */

/**
 * A Telegram block, as every door and the relink route send it: the Mini App
 * deep link to open, the bot it belongs to, and when the challenge behind it
 * lapses. §5 mirror of `openChallenge`'s `telegram` (backend/routes.js).
 */
export interface TelegramBlock {
  url: string;
  botUsername: string;
  expiresAt: string;
}

/** `GET|PUT /api/admin/telegram/bot` — the bot, never its token. */
export interface TelegramBot {
  success: boolean;
  configured: boolean;
  botId: string | null;
  botUsername: string;
  miniAppShortName: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** `GET /api/telegram/mini-app?panel=STAFF` — public. */
export interface MiniAppInfo {
  success: boolean;
  available: boolean;
  botUsername: string;
  resetUrl: string | null;
}

/** `GET /api/admin/account/telegram` — the signed-in staff account's own link. */
export interface MyTelegram {
  available: boolean;
  linked: boolean;
  telegramUsername: string | null;
  firstName: string | null;
  verifiedAt: string | null;
  linkedAt: string | null;
  twoFactor: { enabled: boolean; required: boolean };
}

export const telegram = {
  getBot: async () => {
    const res = await api.get<TelegramBot>('/api/admin/telegram/bot');
    return res.data;
  },

  /**
   * Either field may be sent alone. The token is asked of Telegram before it
   * is stored; a refusal (400 TOKEN_INVALID, SHORT_NAME_INVALID, 409 NO_BOT)
   * arrives as an axios error carrying the server's `message`.
   */
  saveBot: async (body: { token?: string; miniAppShortName?: string }) => {
    const res = await api.put<TelegramBot>('/api/admin/telegram/bot', body);
    return res.data;
  },

  /** Whether Telegram is available for staff, and the "Forgot password" link. */
  miniApp: async () => {
    const res = await api.get<MiniAppInfo>('/api/telegram/mini-app', { params: { panel: 'STAFF' } });
    return res.data;
  },

  myTelegram: async () => {
    const res = await api.get<MyTelegram>('/api/admin/account/telegram');
    return res.data;
  },

  /** Opens a RELINK challenge; approved from the NEW Telegram account. */
  relink: async () => {
    const res = await api.post<{ success: boolean; telegram: TelegramBlock; message?: string }>(
      '/api/admin/account/telegram/relink', {},
    );
    return res.data;
  },
};

// --- SUPERVISORS & TEAMS (redesign Step 2a) ----------------------------------
// Backend: backend/domains/team/team.admin.routes.js, area canManageTeams.
export const teams = {
  list: async () => {
    const res = await api.get<any>('/api/admin/teams');
    return res.data as {
      success: boolean; supervisors: TeamSupervisor[]; teams: TeamView[]; members: TeamMemberView[];
    };
  },
  /** rail null removes the role. */
  setSupervisor: async (merchantId: string, rail: SupervisorRail | null) =>
    (await api.put(`/api/admin/merchants/${merchantId}/supervisor`, { rail })).data,
  approveMember: async (merchantId: string) =>
    (await api.post(`/api/admin/team-members/${merchantId}/approve`)).data,
  rejectMember: async (merchantId: string) =>
    (await api.post(`/api/admin/team-members/${merchantId}/reject`)).data,
  removeMember: async (merchantId: string) =>
    (await api.delete(`/api/admin/team-members/${merchantId}`)).data,
  /** Red flags of the last `days` days (Step 2f): low activity per member. */
  redFlags: async (days = 30) => {
    const res = await api.get<any>('/api/admin/team-red-flags', { params: { days } });
    return res.data as { success: boolean; flags: TeamRedFlag[] };
  },

  // Team token pools (Step 2b) — area canFundMerchants, because they move money.
  poolRequests: async (status: 'PENDING' | null = 'PENDING') => {
    const res = await api.get<any>('/api/admin/team-pool-requests', { params: status ? { status } : {} });
    return res.data as { success: boolean; requests: TeamPoolRequest[] };
  },
  /** settlementAmount is in the MAJOR unit (rupees or whole USDT); 0 means no money changed hands. */
  fulfilPoolRequest: async (requestId: string, body: { settlementCurrency: 'INR' | 'USDT'; settlementAmount: number }) =>
    (await api.post(`/api/admin/team-pool-requests/${requestId}/fulfil`, body)).data as { success: boolean; message: string },
  rejectPoolRequest: async (requestId: string, reason: string) =>
    (await api.post(`/api/admin/team-pool-requests/${requestId}/reject`, { reason })).data,
};

export const referrals = {
  stats: async () => {
    const res = await api.get<any>('/api/admin/referral/stats');
    return res.data as {
      success: boolean;
      budget?: number; disbursed?: number; remaining?: number;
      pendingCount?: number; pendingValue?: number;
      blockedCount?: number; blockedValue?: number;
      memberCap?: number; verifiedMembers?: number;
      nextQueuePosition?: number; active?: boolean;
      message?: string;
    };
  },

  /**
   * Fund the queue with a pool.
   *
   * The amount is the ONLY input. Who gets paid is never chosen by hand — the
   * queue pays strictly in joining order — which is what makes the programme
   * defensible to everyone still waiting in it, and stops a disbursal from
   * being a discretionary favour.
   */
  disburse: async (amount: number) => {
    const res = await api.post<any>('/api/admin/referral/disburse', { amount });
    return res.data as {
      success: boolean; batchId?: string; paid?: number; blocked?: number;
      spent?: number; unspent?: number; paidUpToJoiner?: number; message?: string;
    };
  },
};

// --- SUB ADMINS ---------------------------------------------------------------

export const subAdmins = {
  getAll: async () => {
    const res = await api.get<any>('/api/admin/sub-admins');
    if (res.data?.success && res.data?.subAdmins) {
      return { success: true, data: res.data.subAdmins };
    }
    return res.data;
  },

  create: async (data: {
    username: string;
    mobile: string;
    password: string;
    permissions?: Record<string, boolean>;
  }) => {
    const res = await api.post('/api/admin/sub-admins', data);
    return res.data;
  },

  /**
   * Sent as `{ permissions }`, which is what the route reads. It sent the object
   * AS the body, so the route found no `permissions` key and stored an empty
   * grant: every "Save Permissions" revoked everything the sub-admin had.
   */
  updatePermissions: async (subAdminId: string, permissions: Record<string, boolean>) => {
    const res = await api.put(`/api/admin/sub-admins/${subAdminId}/permissions`, { permissions });
    return res.data;
  },

  /** Every area a sub-admin can be given, grouped — the picker is rendered from this. */
  permissionCatalog: async (): Promise<StaffPermissionCatalog> => {
    const res = await api.get<any>('/api/admin/staff-permissions');
    return res.data;
  },

  /**
   * Queue-manager authority.
   *
   * A queue manager assigns payment orders to merchants, which decides where a
   * player's money is routed. Both endpoints existed and nothing called them,
   * so the grant could only be made by writing the row by hand.
   */
  listQueueManagers: async () => {
    const res = await api.get<any>('/api/admin/queue-managers');
    return res.data;
  },

  setQueueManager: async (userId: string, enable: boolean) => {
    const res = await api.post(`/api/admin/users/${userId}/queue-manager`, { enable });
    return res.data;
  },

  delete: async (subAdminId: string) => {
    const res = await api.delete(`/api/admin/sub-admins/${subAdminId}`);
    return res.data;
  },

  /**
   * Every account that currently holds phantom access, in one read.
   *
   * The grant beside it had a caller and this had none, so the roster could
   * only be reconstructed by paging the whole user list — which means nobody
   * did, and a grant nobody enumerates is a grant nobody revokes.
   */
  listPhantomAgents: async () => {
    const res = await api.get<any>('/api/admin/phantom-agents');
    return res.data;
  },

  assignPhantomAccess: async (
    userId: string,
    // Mirrors the User.phantomAccess enum. 'BOTH' predates the 1-minute block
    // and means EVERY type — the server gate reads it as "skip the per-type
    // check" (backend/domains/markets/bet.routes.js).
    access: 'NONE' | '1_MIN' | '30_MIN' | 'FULL_DAY' | 'BOTH'
  ) => {
    // Backend expects { accessLevel }
    const res = await api.post(`/api/admin/users/${userId}/phantom-access`, {
      accessLevel: access,
    });
    return res.data;
  },
};

// --- FINANCE ------------------------------------------------------------------

export const finance = {
  /**
   * The wallet ledger. `GET /api/admin/transactions` reads exactly `type`
   * (CREDIT / DEBIT) and `field` (which pocket moved) — see
   * `routes/admin/system.admin.routes.js`.
   *
   * This used to pass a `status`, which that route has never read: the screen's
   * Status dropdown was a control with no consumer (§3), and choosing a value
   * changed nothing while looking like a filter that had been applied.
   */
  getTransactions: async (page = 1, limit = 50, type?: string, field?: string, startDate?: string, endDate?: string) => {
    const res = await api.get<any>('/api/admin/transactions', {
      params: { page, limit, type, field, startDate, endDate },
    });
    if (res.data?.success && res.data?.transactions) {
      return { success: true, data: res.data.transactions, pagination: res.data.pagination };
    }
    return res.data;
  },
};

// --- BRANDING -----------------------------------------------------------------

export const branding = {
  getCurrent: async () => {
    const res = await api.get<any>('/api/admin/branding');
    if (res.data?.success && res.data?.branding !== undefined) {
      return { success: true, data: res.data.branding };
    }
    return res.data;
  },

  update: async (data: Partial<Branding>) => {
    const res = await api.put('/api/admin/branding', data);
    return res.data;
  },

};

// --- CDN ----------------------------------------------------------------------
// uploadImage (and branding.uploadLogo) removed 2026-10-01: no screen called
// either. CDNManager registers an external URL (addUrl); branding assets are
// uploaded through appAssets.

export const cdn = {
  getImages: async (category?: string) => {
    const res = await api.get<any>('/api/admin/branding/images', { params: { category } });
    if (res.data?.success && res.data?.images) {
      return { success: true, data: res.data.images };
    }
    return res.data;
  },

  deleteImage: async (imageId: string) => {
    const res = await api.delete(`/api/admin/branding/images/${imageId}`);
    return res.data;
  },

  addUrl: async (data: { url: string; title: string; category: string; description?: string; tags?: string[] }) => {
    // Register an external URL directly (no file upload needed)
    const res = await api.post('/api/admin/branding/cdn-url', data);
    return res.data;
  },
};

// --- CONTENT ------------------------------------------------------------------

export const content = {
  getAllFAQs: async () => {
    const res = await api.get<any>('/api/admin/content/faq');
    if (res.data?.success && res.data?.faqs) {
      return { success: true, data: res.data.faqs };
    }
    return res.data;
  },

  createFAQ: async (data: Partial<FAQ>) => {
    const res = await api.post('/api/admin/content/faq', data);
    return res.data;
  },

  updateFAQ: async (faqId: string, data: Partial<FAQ>) => {
    const res = await api.put(`/api/admin/content/faq/${faqId}`, data);
    return res.data;
  },

  deleteFAQ: async (faqId: string) => {
    const res = await api.delete(`/api/admin/content/faq/${faqId}`);
    return res.data;
  },

  getSupportLinks: async () => {
    const res = await api.get<any>('/api/admin/content/support-links');
    if (res.data?.success && res.data?.supportLinks) {
      return { success: true, data: res.data.supportLinks };
    }
    return res.data;
  },

  updateSupportLinks: async (data: Partial<SupportLinks>) => {
    const res = await api.put('/api/admin/content/support-links', data);
    return res.data;
  },
};

// --- SYSTEM -------------------------------------------------------------------

export const system = {
  getConfig: async () => {
    const res = await api.get<any>('/api/admin/system/config');
    if (res.data?.success && res.data?.config) {
      return { success: true, data: res.data.config };
    }
    return res.data;
  },

  updateConfig: async (config: any) => {
    const res = await api.put('/api/admin/system/config', config);
    return res.data;
  },

  toggleMaintenance: async (enabled: boolean, message?: string) => {
    const res = await api.put('/api/admin/system/config', {
      maintenanceMode: enabled,
      maintenanceMessage: message || '',
    });
    return res.data;
  },

  getAuditLogs: async (page = 1, limit = 50) => {
    const res = await api.get<any>('/api/admin/audit-logs', { params: { page, limit } });
    if (res.data?.success && res.data?.logs) {
      return { success: true, data: res.data.logs, pagination: res.data.pagination };
    }
    return res.data;
  },
};


// ─── DISPUTES ──────────────────────────────────────────────────────────────
export const disputes = {
  // getAll / getOne / resolve / escalate removed 2026-10-01: DisputeManager
  // calls those four routes itself, so these were a second client surface for
  // the same endpoints that nothing used (§5).

  /**
   * Withdrawals no merchant has taken.
   *
   * One that cannot find a team member WAITS rather than failing. The price is
   * an unbounded token lock, which is why this queue exists: an order with no
   * deadline and no owner is one nobody is answerable for.
   *
   * `olderThanMinutes` accepts 0 — "everything waiting right now".
   */
  stalledWithdrawals: async (olderThanMinutes: number) => {
    const res = await api.get<any>('/api/admin/orders/stalled-withdrawals', { params: { olderThanMinutes } });
    return res.data;
  },
};

// ─── UTR MONITOR ───────────────────────────────────────────────────────────
// The payment-reference registry (`canManageUtr`). A UTR or chain hash
// belongs to exactly one order, for good (CLAUDE.md §27); this is
// the operator's side of that rule: who claimed what, which references somebody
// tried to REUSE, and the flag a human puts on one.
//
// `GET /utr/flagged` and `POST /utr/resolve/:orderId` are NOT here. They work
// orders with `requires_review` set, and nothing on the platform sets it, so a
// screen for them would be a queue that is permanently empty (§32 S4). The old
// `resolve` here also sent `{ resolution }` to a route that requires
// `{ action }`, so it could never have worked (S26).
export const utr = {
  getStats: async () => {
    const res = await api.get<any>('/api/admin/utr/stats');
    return res.data;
  },
  /** References somebody tried to reuse, or that an operator flagged — newest contest first. */
  getContested: async (page = 1, limit = 50) => {
    const res = await api.get<any>('/api/admin/utr/contested', { params: { page, limit } });
    return res.data;
  },
  /** The whole registry, optionally one status (ACTIVE | RELEASED | FRAUD). */
  getRegistry: async (status?: string, page = 1, limit = 50) => {
    const res = await api.get<any>('/api/admin/utr-registry', { params: { status, page, limit } });
    return res.data;
  },
  /** One reference, as typed — the server normalises case and spaces. */
  lookup: async (reference: string) => {
    const res = await api.get<any>(`/api/admin/utr-registry/${encodeURIComponent(reference)}`);
    return res.data;
  },
  /** The reason is REQUIRED: it is what the player is shown if they appeal. */
  flag: async (reference: string, reason: string) => {
    const res = await api.put<any>(`/api/admin/utr-registry/${encodeURIComponent(reference)}/flag`, { reason });
    return res.data;
  },
  clear: async (reference: string) => {
    const res = await api.put<any>(`/api/admin/utr-registry/${encodeURIComponent(reference)}/clear`, {});
    return res.data;
  },
  getUserHistory: async (userId: string) => {
    const res = await api.get<any>(`/api/admin/utr/user-history/${encodeURIComponent(userId)}`);
    return res.data;
  },
};


// --- ERROR REPORTS --------------------------------------------------------

export const errorReports = {
  getAll: async () => {
    const res = await api.get<any>('/api/admin/error-reports');
    if (res.data?.success && res.data?.reports) {
      return { success: true, data: res.data.reports as Array<{
        _id: string; message: string; stack?: string; component?: string;
        url?: string; panel: string; ts: string;
      }>};
    }
    return res.data;
  },
  clearAll: async () => {
    const res = await api.delete<any>('/api/admin/error-reports');
    return res.data;
  },
};

// --- APP ASSETS ---------------------------------------------------------------

export const appAssets = {
  getAll: async () => {
    const res = await api.get<any>('/api/admin/app-assets');
    return res.data;
  },
  upload: async (slot: string, file: File): Promise<{ success: boolean; url?: string; message?: string }> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const res = await api.post<any>('/api/admin/app-assets/upload', { slot, data: reader.result as string });
          resolve(res.data);
        } catch (e: any) {
          resolve({ success: false, message: e?.response?.data?.message || 'Upload failed' });
        }
      };
      reader.onerror = () => resolve({ success: false, message: 'Failed to read file' });
      reader.readAsDataURL(file);
    });
  },
  delete: async (name: string) => {
    const res = await api.delete<any>(`/api/admin/app-assets/${name}`);
    return res.data;
  },
};

// --- ANDROID RELEASES ---------------------------------------------------------
// The installed app downloads and installs what is PUBLISHED here
// (backend/domains/distribution/androidRelease.routes.js).

export interface AndroidRelease {
  releaseId: string; packageName: string; versionCode: number; versionName: string;
  minSdk: number | null; signerSha256: string; fileSha256: string; sizeBytes: number;
  fileUrl: string; storage: 'S3' | 'LOCAL'; releaseNotes: string; mandatory: boolean;
  uploadedAt: string; publishedAt: string | null; published: boolean;
  /** Halted: published, but no longer offered, downloaded or required (R9). */
  halted: boolean; haltedAt: string | null; haltReason: string | null;
  /** The Android this build needs, worded by the server ("Android 9 (API 28)"). */
  requiresAndroid: string | null;
  /** The APK signature schemes the upload VERIFIED (R7), e.g. [2, 3]. */
  signatureSchemes: number[];
  uploadedByName: string | null; publishedByName: string | null; haltedByName: string | null;
}
export interface AndroidReleaseCheck { key: string; ok: boolean; label: string; why: string }
export interface AndroidReleasesResponse {
  success: boolean; releases: AndroidRelease[]; latestPublishedVersionCode: number | null;
  minRequiredVersionCode: number; packageName: string; fingerprints: string[];
  storage: 'S3' | 'LOCAL'; checks: AndroidReleaseCheck[];
}

export const androidReleases = {
  list: async (): Promise<AndroidReleasesResponse> => {
    const res = await api.get<AndroidReleasesResponse>('/api/admin/android/releases');
    return res.data;
  },
  /** The body IS the APK — no base64 — so a 50 MB build is a 50 MB request. */
  upload: async (file: File, onProgress?: (pct: number) => void) => {
    const res = await api.post<{ success: boolean; release: AndroidRelease; message?: string }>(
      '/api/admin/android/releases', file, {
        headers: { 'Content-Type': 'application/vnd.android.package-archive' },
        timeout: 10 * 60 * 1000,
        onUploadProgress: (e) => { if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100)); },
      });
    return res.data;
  },
  update: async (releaseId: string, patch: { releaseNotes?: string; mandatory?: boolean }) => {
    const res = await api.patch<{ success: boolean; release: AndroidRelease }>(`/api/admin/android/releases/${releaseId}`, patch);
    return res.data;
  },
  publish: async (releaseId: string) => {
    const res = await api.post<{ success: boolean; release: AndroidRelease }>(`/api/admin/android/releases/${releaseId}/publish`);
    return res.data;
  },
  remove: async (releaseId: string) => {
    const res = await api.delete<{ success: boolean }>(`/api/admin/android/releases/${releaseId}`);
    return res.data;
  },
  halt: async (releaseId: string, reason: string) => {
    const res = await api.post<{ success: boolean; release: AndroidRelease; message: string }>(
      `/api/admin/android/releases/${releaseId}/halt`, { reason });
    return res.data;
  },
  resume: async (releaseId: string) => {
    const res = await api.post<{ success: boolean; release: AndroidRelease }>(`/api/admin/android/releases/${releaseId}/resume`);
    return res.data;
  },
  /** Where a release's file is, for downloading it to test on a phone. */
  fileHref: (r: Pick<AndroidRelease, 'fileUrl'>) => (/^https?:\/\//i.test(r.fileUrl) ? r.fileUrl : `${API_URL.replace(/\/$/, '')}${r.fileUrl}`),
};

// Payment Order Actions — approve / reject / cancel
// FIX: was orphaned label-statement; esbuild rejected TS type annotations in label blocks
// The path segment is `payment-orders`, NOT `p2p-orders`. It was the latter here
// until 2026-08-24, which meant every approve / reject / cancel from the queue
// dashboard 404'd — the buttons looked live and did nothing. The backend route is
// domains/payment/paymentOrder.routes.js `POST /payment-orders/:orderId/action`,
// mounted at `/` under /api/admin (routes/admin/index.js), and its body contract
// ({ action: 'APPROVE'|'REJECT'|'CANCEL', reason }) already matched.
export const orderActions = {
  approve: async (orderId: string, reason: string) => {
      const res = await api.post(`/api/admin/payment-orders/${orderId}/action`, { action: 'APPROVE', reason });
      return res.data;
    },
    reject: async (orderId: string, reason: string) => {
      const res = await api.post(`/api/admin/payment-orders/${orderId}/action`, { action: 'REJECT', reason });
      return res.data;
    },
    cancel: async (orderId: string, reason: string) => {
      const res = await api.post(`/api/admin/payment-orders/${orderId}/action`, { action: 'CANCEL', reason });
      return res.data;
    },
};

// --- CHAT & SUPPORT (public chat moderation + support-ticket desk) -----------
// Backend: routes/admin/chat.admin.routes.js (gated by canManageSupport).

export const chat = {
  getMessages: async (limit = 60, includeDeleted = false) => {
    const res = await api.get<any>('/api/admin/chat/messages', { params: { limit, includeDeleted } });
    return res.data;
  },
  deleteMessage: async (id: string) => {
    const res = await api.post(`/api/admin/chat/messages/${id}/delete`);
    return res.data;
  },
  getBans: async () => {
    const res = await api.get<any>('/api/admin/chat/bans');
    return res.data;
  },
  banUser: async (userId: string, reason: string, hours?: number) => {
    const res = await api.post('/api/admin/chat/ban', { userId, reason, hours });
    return res.data;
  },
  unbanUser: async (userId: string) => {
    const res = await api.delete(`/api/admin/chat/ban/${userId}`);
    return res.data;
  },
  getTickets: async (status?: string) => {
    const res = await api.get<any>('/api/admin/support/tickets', { params: { status } });
    return res.data;
  },
  getTicket: async (id: string) => {
    const res = await api.get<any>(`/api/admin/support/tickets/${id}`);
    return res.data;
  },
  reply: async (ticketId: string, content: string) => {
    const res = await api.post(`/api/admin/support/tickets/${ticketId}/reply`, { content });
    return res.data;
  },
};

export default {
  auth,
  analytics,
  users,
  merchants,
  cycles,
  depositPolicy,
  queueManager,
  teams,
  telegram,
  referrals,
  subAdmins,
  finance,
  branding,
  cdn,
  content,
  system,
  disputes,
  utr,
  errorReports,
  appAssets,
  orderActions,
  chat,
  get: <T = any>(url: string, config?: any) => api.get<T>(url, config),
  post: <T = any>(url: string, data?: any, config?: any) => api.post<T>(url, data, config),
  put: <T = any>(url: string, data?: any, config?: any) => api.put<T>(url, data, config),
  delete: <T = any>(url: string, config?: any) => api.delete<T>(url, config),
};



// ── Blocked IPs (Admin › Blocked IPs) ──────────────────────────────────────
// Server: backend/routes/admin/ipBlocks.admin.routes.js. The shape mirrors
// `toBlock` in database/repositories/ipBlocks.js (§5).
export interface IpBlock {
  blockId: string; network: string; reason: string; blockedBy: string; blockedAt: string;
  expiresAt: string | null; releasedAt: string | null; releasedBy: string | null; live: boolean;
}
export interface IpBlocksResponse {
  success: boolean; blocks: IpBlock[]; yourIp: string | null;
  enforcer: { enforcing: boolean; blocks: number; loadedAt: string | null; refreshSeconds: number };
}
export const ipBlocks = {
  list: async (includeReleased = false): Promise<IpBlocksResponse> => {
    const res = await api.get<IpBlocksResponse>('/api/admin/security/ip-blocks', { params: includeReleased ? { includeReleased: 1 } : {} });
    return res.data;
  },
  block: async (body: { network: string; reason: string; expiresInMinutes?: number }) => {
    const res = await api.post<{ success: boolean; block: IpBlock }>('/api/admin/security/ip-blocks', body);
    return res.data;
  },
  release: async (blockId: string) => {
    const res = await api.post<{ success: boolean; block: IpBlock }>(`/api/admin/security/ip-blocks/${encodeURIComponent(blockId)}/release`, {});
    return res.data;
  },
};
