// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import axios, { AxiosInstance, AxiosError } from 'axios';
import { endRefusedSession, serverRefusal } from './signedOut';
import type { StaffPermissionCatalog } from '../utils/permissions';
import type {
  Admin,
  User,
  Cycle,
  Merchant,
  MerchantProfile,
  PaymentOrder,
  Transaction,
  Branding,
  DashboardStats,
  CDNImage,
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
    return Promise.reject(error);
  }
);

// --- AUTH ---------------------------------------------------------------------

export const auth = {
  /**
   * loginType:
   *   'admin'         -- full admin
   *   'subadmin'      -- sub-admin (permissions from subAdminPermissions on User doc)
   *   'queue_manager' -- queue manager (sees only queue dashboard)
   */
  login: async (
    mobile: string,
    password: string,
    loginType: 'admin' | 'subadmin' | 'queue_manager' = 'admin'
  ) => {
    const res = await api.post<any>('/api/admin/login', { mobile, password, loginType }); // MED-02: use /api/admin/login for adminAuthLimiter
    // 2FA: the server answers success:false + twoFactorRequired and hands back
    // a five-minute challenge instead of a session. This is NOT an error —
    // the password was accepted; the login is simply half done.
    if (res.data?.twoFactorRequired && res.data?.challengeToken) {
      return { success: false, twoFactorRequired: true, challengeToken: res.data.challengeToken as string };
    }
    if (res.data?.success && res.data?.token) {
      // `mustEnroll2FA` is carried through, not dropped. The server has sent it
      // since 2026-09-10 — computed from `requires2FA()` so the panel and the
      // policy cannot disagree — and this mapper returned a fixed
      // `{token, admin}` shape that discarded it, so an admin who must hold a
      // second factor and never enrolled was never once asked. The merchant
      // panel has routed on the same flag all along (F-011).
      return {
        success: true,
        data: { token: res.data.token, admin: res.data.user },
        mustEnroll2FA: !!res.data.mustEnroll2FA,
      };
    }
    return res.data;
  },

  /** Second leg: exchange the challenge for a real session. */
  loginTwoFactor: async (challengeToken: string, code: string) => {
    const res = await api.post<any>('/api/admin/login/2fa', { challengeToken, code });
    if (res.data?.success && res.data?.token) {
      // Carried here too, though it is always false on this leg by
      // construction: reaching it means a factor was presented, so the account
      // is enrolled. Reading the server's answer rather than assuming that
      // keeps one owner for the question.
      return {
        success: true,
        data: { token: res.data.token, admin: res.data.user },
        mustEnroll2FA: !!res.data.mustEnroll2FA,
      };
    }
    return res.data;
  },

  logout: async () => {
    try {
      await api.post('/api/v1/auth/logout');
    } catch {}
  },

  verifySession: async () => {
    const res = await api.get<any>('/api/v1/auth/me');
    if (res.data?.success && res.data?.user) {
      // Carried for the same reason as on login, and this is the path that
      // catches an account PROMOTED to staff while holding a session: the
      // obligation begins at the promotion, not at their next sign-in.
      return {
        success: true,
        data: { admin: res.data.user },
        mustEnroll2FA: !!res.data.mustEnroll2FA,
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
  getAll: async (page = 1, limit = 50, status?: string) => {
    const res = await api.get<any>('/api/admin/merchants', { params: { page, limit, status } });
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
  // them — a dead QR, a closed UPI handle. It is not a suspension and they were
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

// --- TELEGRAM & REFERRALS -------------------------------------------------
/**
 * The identity and payout control plane. Every endpoint behind these is
 * `isAdmin`, never `isAdminOrSubAdmin`: they move the platform's identity root
 * and release national identity numbers, and admin 2FA is mandatory, so
 * "isAdmin" also means "proved a second factor".
 */
/**
 * Which panel a Telegram screen is configuring.
 *
 * §5 MIRROR of `ACCOUNT_TYPES` in database/repositories/users.js, which is the
 * one owner of these values — an account's `account_type` IS its Telegram
 * audience, which is what stops "which bot serves this person" acquiring a
 * second answer. Change them in the same commit.
 */
export type Audience = 'PLAYER' | 'MERCHANT' | 'STAFF';
export const AUDIENCES: Audience[] = ['PLAYER', 'MERCHANT', 'STAFF'];

/** What the admin panel calls each one, so three screens say the same words. */
export const AUDIENCE_LABEL: Record<Audience, string> = {
  PLAYER: 'User panel',
  MERCHANT: 'Merchant panel',
  STAFF: 'Admin panel',
};

/**
 * The answer to "may this staff account use the admin panel yet?"
 *
 * The SAME shape the player and merchant panels receive, because it is the same
 * server function behind all three mounts (§5). `bootstrap` is the one field
 * only this panel acts on — see the gate component.
 */
export interface StaffVerification {
  success: boolean;
  verified: boolean;
  bootstrap: boolean;
  audience: Audience;
  reason: string | null;
  contactShared: boolean;
  channelJoined: boolean;
  bot: { username: string } | null;
  botLink: string;
  channel: { inviteLink: string; username: string };
  generation: number;
  throttled?: boolean;
}

export const telegram = {
  /**
   * The staff gate's own read. Cache-only unless `verify` is passed, which the
   * "I've done it" button sends once — the server floors it per account.
   */
  getVerification: async (opts: { verify?: boolean } = {}) => {
    // Two whole literals rather than one interpolated path, deliberately:
    // `check:ui-coverage` resolves a panel call by reading the string at the
    // call site, and a path carrying `${…}` is one it cannot follow to a route.
    // A gate that cannot see a call cannot tell a working button from a dead
    // one (§28), and the fix is to write something it can read — not to exempt
    // the file.
    const res = opts.verify
      ? await api.get<any>('/api/admin/verification?verify=1')
      : await api.get<any>('/api/admin/verification');
    return res.data as StaffVerification;
  },

  getConfig: async (audience: Audience = 'PLAYER') => {
    const res = await api.get<any>(`/api/admin/telegram/config?audience=${audience}`);
    return res.data as {
      success: boolean;
      active?: {
        generation: number; botUsername: string; recoveryBotUsername?: string;
        channelId: string; channelUsername?: string; channelInviteLink?: string;
        botTokenConfigured: boolean; recoveryBotConfigured: boolean;
        /** Whether the live credential comes from the bot registry or from the generation. */
        signinSource?: 'registry' | 'generation';
        recoverySource?: 'registry' | 'generation' | 'none';
      } | null;
      history?: Array<{
        generation: number; botUsername: string; channelId: string; channelUsername?: string;
        active: boolean; activatedAt: string; reason?: string;
        activatedBy?: { username?: string } | null;
      }>;
      message?: string;
    };
  },

  /**
   * Activate a new generation.
   *
   * Tokens are write-only by design: there is no read path for one, so an
   * operator changing a bot supplies a fresh value rather than editing what is
   * stored. The server verifies it against Telegram BEFORE storing, because a
   * config with a dead token takes signup and login down until someone notices.
   */
  activate: async (body: {
    // REQUIRED, and with no default on purpose: activating a channel is what
    // makes every cached membership for that panel stale, so a guessed audience
    // re-gates a population the operator was not thinking about.
    audience: Audience;
    botToken: string; recoveryBotToken?: string; channelId: string;
    channelUsername?: string; channelInviteLink?: string; webhookBaseUrl?: string; reason?: string;
  }) => {
    const res = await api.post<any>('/api/admin/telegram/config', body);
    return res.data as {
      success: boolean; generation?: number; botUsername?: string;
      webhook?: string; message?: string;
    };
  },

  /**
   * Replace the CHANNEL only, carrying the current bots forward.
   *
   * Separate from `activate` because in an incident the two are almost never
   * the same event: a channel is deleted while the bot is fine. Requiring a
   * working bot token to be re-pasted to fix an unrelated channel is one more
   * way to fail under pressure.
   *
   * Every player is asked to join the new channel on their next protected
   * action; nothing else about their account moves.
   */
  replaceChannel: async (body: {
    audience: Audience;
    channelId: string; channelUsername?: string; channelInviteLink?: string; reason?: string;
  }) => {
    const res = await api.post<any>('/api/admin/telegram/channel', body);
    return res.data as {
      success: boolean; generation?: number;
      channelId?: string; channelUsername?: string; message?: string;
    };
  },
};

/** A bot in the fleet, as the panel sees it — never with a token. */
export interface FleetBot {
  id: string;
  label: string;
  role: 'signin' | 'recovery' | 'broadcast' | 'moderation' | 'generic';
  /** Which panel this bot serves. One bot serves exactly one. */
  audience: Audience;
  botId: string;
  username: string;
  status: 'ACTIVE' | 'STANDBY' | 'RETIRED';
  live: boolean;
  webhookUrl: string;
  webhookRegisteredAt: string | null;
  lastError: string;
  addedAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
  notes: string;
}

/**
 * The bot fleet.
 *
 * Spares are registered and verified while everything is calm, and sit on
 * STANDBY. When Telegram suspends the live bot, `promote` is the whole incident
 * response — no token to find, no @BotFather to open, no deploy.
 */
export const telegramBots = {
  list: async () => {
    const res = await api.get<any>('/api/admin/telegram/bots');
    // `loads` arrives with the listing rather than from a second call: the
    // screen renders each figure INTO the bot's own row, and two fetches would
    // let the table and the numbers beside it come from different moments.
    return res.data as {
      success: boolean; bots?: FleetBot[];
      /** botId → accounts assigned. Live sign-in bots only. */
      loads?: Record<string, number>;
      message?: string;
    };
  },

  register: async (body: {
    label: string; role: FleetBot['role']; audience: Audience; token: string; notes?: string;
  }) => {
    const res = await api.post<any>('/api/admin/telegram/bots', body);
    return res.data as { success: boolean; bot?: FleetBot; message?: string };
  },

  promote: async (id: string, webhookBaseUrl?: string) => {
    const res = await api.post<any>(`/api/admin/telegram/bots/${id}/promote`, { webhookBaseUrl });
    return res.data as {
      success: boolean; bot?: FleetBot; displaced?: FleetBot | null;
      webhook?: string; alreadyLive?: boolean; message?: string;
    };
  },

  retryWebhook: async (id: string, webhookBaseUrl?: string) => {
    const res = await api.post<any>(`/api/admin/telegram/bots/${id}/webhook`, { webhookBaseUrl });
    return res.data as { success: boolean; bot?: FleetBot; message?: string };
  },

  retire: async (id: string) => {
    const res = await api.post<any>(`/api/admin/telegram/bots/${id}/retire`, {});
    return res.data as { success: boolean; bot?: FleetBot; message?: string };
  },
};

export interface BotTemplate {
  key: string;
  body: string;
  default: string;
  customised: boolean;
  variables: string[];
  updatedAt: string | null;
}

/**
 * What the bot says.
 *
 * The welcome message is the first sentence anyone reads from this platform and
 * carries the requirement that their Telegram account be on the mobile they
 * signed up with. Getting it wrong shows up weeks later as failed verifications, so it
 * is editable here rather than in a deploy.
 */
export const telegramTemplates = {
  list: async () => {
    const res = await api.get<any>('/api/admin/telegram/templates');
    return res.data as { success: boolean; templates?: BotTemplate[]; message?: string };
  },

  /** An empty body reverts the key to the shipped wording. */
  save: async (key: string, body: string) => {
    const res = await api.put<any>(`/api/admin/telegram/templates/${key}`, { body });
    return res.data as { success: boolean; template?: BotTemplate; message?: string };
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

// --- TWO-FACTOR ENROLMENT -----------------------------------------------------
// Admins and sub-admins live in the User collection, so they use the shared
// /api/2fa router. Two steps on purpose: /setup stores a PENDING secret and
// only /activate makes it live, so closing the tab mid-scan cannot leave an
// account demanding codes from an authenticator entry that was never created.
export const twoFactor = {
  status: async () => {
    const res = await api.get<any>('/api/2fa/status');
    return res.data;
  },
  /** Returns { secret, otpauthUri } — render the URI as a QR. */
  setup: async () => {
    const res = await api.post<any>('/api/2fa/setup', {});
    return res.data;
  },
  /** Returns { backupCodes } — shown exactly once, never again. */
  activate: async (code: string) => {
    const res = await api.post<any>('/api/2fa/activate', { code });
    return res.data;
  },
};

export default {
  auth,
  twoFactor,
  analytics,
  users,
  merchants,
  cycles,
  depositPolicy,
  queueManager,
  teams,
  telegram,
  telegramBots,
  telegramTemplates,
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
