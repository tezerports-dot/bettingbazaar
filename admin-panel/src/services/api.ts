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
  StaffRow, StaffRole,
} from '../types';

const _adminViteUrl = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '');
const _adminIsLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
// Same origin unless VITE_API_URL names another, as sse.ts and the merchant
// panel do: the server serves this panel at /admin/ beside the API, and the
// Docker image sets no VITE_API_URL. (A throw here blanked the whole panel.)
const API_URL = _adminViteUrl || (_adminIsLocal ? 'http://localhost:8080' : window.location.origin);

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
    // A held session without its second factor is not a session: the 403
    // `TWO_FACTOR_REQUIRED` every staff route answers to a token that carries
    // no authenticator code. Any other 403 is "not permitted", which ends
    // nothing.
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
 * A staff sign-in is a mobile and password, then a 6-digit code from an
 * authenticator app (owner, 2026-10-13; no Telegram). The password leg never
 * answers a session: it answers which code step comes next, with a
 * `challengeToken` that only the code legs accept.
 */

/** A staff session as the door sends it. */
export interface StaffSession {
  token: string;
  admin: Admin;
  /** Only from `/login/totp/activate`: the ten recovery codes, shown once. */
  recoveryCodes?: string[];
  /** Only after signing in with a recovery code: how many are left. */
  recoveryCodesLeft?: number;
}

/** What the password leg answered: which code step is next. */
export type LoginAnswer =
  | { kind: 'totp'; challengeToken: string; message: string }
  | { kind: 'totpSetup'; challengeToken: string; message: string };

/** `POST /api/admin/login/totp/setup` — what the person scans. */
export interface TotpSetup {
  secret: string;
  otpauthUri: string;
  qrDataUrl: string;
}

/** `GET /api/admin/account/2fa` — never a secret. */
export interface AuthenticatorState {
  enrolled: boolean;
  enrolledAt: string | null;
  recoveryCodesLeft: number;
  recoveryGeneratedAt: string | null;
}

const sessionOf = (data: any): StaffSession | null =>
  data?.success && data?.token
    ? {
      token: data.token, admin: data.user,
      ...(Array.isArray(data.recoveryCodes) ? { recoveryCodes: data.recoveryCodes as string[] } : {}),
      ...(typeof data.recoveryCodesLeft === 'number' ? { recoveryCodesLeft: data.recoveryCodesLeft as number } : {}),
    }
    : null;

/** A 2xx the panel has no branch for, thrown in the shape every caller reads. */
const unexpected = (status: number, data: any): Error =>
  Object.assign(new Error(data?.message || 'Sign-in failed. Please try again.'), { response: { status, data } });

export const auth = {
  /**
   * The password leg.
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
  ): Promise<LoginAnswer> => {
    const res = await api.post<any>('/api/admin/login', { mobile, password, loginType });
    // Not an error: the password was accepted and a code is next.
    if (res.data?.twoFactorRequired && res.data?.challengeToken) {
      return {
        kind: res.data.totpSetupRequired ? 'totpSetup' : 'totp',
        challengeToken: res.data.challengeToken, message: res.data.message || '',
      };
    }
    throw unexpected(res.status, res.data);
  },

  /** The 6-digit code (or a recovery code), then a session. */
  totp: async (challengeToken: string, code: string): Promise<StaffSession> => {
    const res = await api.post<any>('/api/admin/login/totp', { challengeToken, code });
    const session = sessionOf(res.data);
    if (session) return session;
    throw unexpected(res.status, res.data);
  },

  /** First sign-in: the secret and its QR. */
  totpSetup: async (challengeToken: string): Promise<TotpSetup> => {
    const res = await api.post<any>('/api/admin/login/totp/setup', { challengeToken });
    if (res.data?.success && res.data?.qrDataUrl) {
      return { secret: res.data.secret, otpauthUri: res.data.otpauthUri, qrDataUrl: res.data.qrDataUrl };
    }
    throw unexpected(res.status, res.data);
  },

  /** First sign-in: the first code. A session AND the recovery codes. */
  totpActivate: async (challengeToken: string, code: string): Promise<StaffSession> => {
    const res = await api.post<any>('/api/admin/login/totp/activate', { challengeToken, code });
    const session = sessionOf(res.data);
    if (session?.recoveryCodes) return session;
    throw unexpected(res.status, res.data);
  },

  logout: async () => {
    try {
      await api.post('/api/v1/auth/logout');
    } catch {}
  },

  verifySession: async () => {
    // The staff-only restore: a player's or merchant's session is refused here
    // (403 WRONG_PANEL) and ended, never shown the panel (§33.5).
    const res = await api.get<any>('/api/admin/account/me');
    if (res.data?.success && res.data?.user) {
      return { success: true, data: { admin: res.data.user as Admin } };
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
  // The players table (adminDirectory.listPlayers). `sort` is one of the keys
  // the route sends back as `sorts`; the panel keeps no list of its own.
  getAll: async (q: { page?: number; limit?: number; search?: string; status?: string; sort?: string; dir?: 'asc' | 'desc' } = {}) => {
    const res = await api.get<any>('/api/admin/users', { params: { page: 1, limit: 50, ...q } });
    if (res.data?.success && res.data?.users) {
      return { success: true, data: res.data.users, sorts: res.data.sorts as string[], pagination: res.data.pagination };
    }
    return res.data;
  },

  // One player's page: the account, its table row (`summary`), sell escrow,
  // recent bets and wallet movements (users.admin.routes.js GET /users/:userId).
  getProfile: async (userId: string) => {
    const res = await api.get<any>(`/api/admin/users/${encodeURIComponent(userId)}`);
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
  /** Keep (or stop keeping) the app open to this player during maintenance (owner, 2026-10-20). */
  setMaintenanceTester: async (userId: string, on: boolean) => {
    const res = await api.put(`/api/admin/users/${userId}/maintenance-tester`, { on });
    return res.data as { success: boolean; message: string; maintenanceTester: boolean };
  },

  /** The players who keep the app during maintenance. */
  maintenanceTesters: async () => {
    const res = await api.get('/api/admin/maintenance-testers');
    return (res.data?.testers ?? []) as Array<{ userId: string; username: string; joiningNumber: number | null }>;
  },
};

// --- MERCHANTS ----------------------------------------------------------------

export const merchants = {
  // The merchants table (adminDirectory.listMerchants). `status` is the
  // approval status, `role` one of the route's `roles`, `sort` one of `sorts`.
  getAll: async (q: { page?: number; limit?: number; status?: string; role?: string; search?: string; sort?: string; dir?: 'asc' | 'desc' } = {}) => {
    const res = await api.get<any>('/api/admin/merchants', { params: { page: 1, limit: 50, ...q } });
    if (res.data?.success && res.data?.merchants) {
      return { success: true, data: res.data.merchants, sorts: res.data.sorts as string[], roles: res.data.roles as string[], pagination: res.data.pagination };
    }
    return res.data;
  },

  getProfile: async (merchantId: string) => {
    const res = await api.get<any>(`/api/admin/merchants/${merchantId}/profile`);
    if (res.data?.success && res.data?.merchant) {
      return { success: true, data: res.data.merchant, summary: res.data.summary, choices: res.data.choices };
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
  // `kind`: 'AGENT' (works in a team under a supervisor) or 'DIRECT' (a
  // merchant account: INR, its own pool, accounts and sub-members). Owner,
  // 2026-10-11; the server refuses any other value (UNKNOWN_KIND).
  create: async (data: { username: string; mobile: string; email?: string; kind: 'AGENT' | 'DIRECT' }) => {
    const res = await api.post('/api/admin/merchants/create', data);
    return res.data;
  },

  // ── Merchant accounts (owner, 2026-10-11 — Phase B) ──────────────────────
  // merchantAccount.admin.routes.js, all `canManageMerchants`.
  listMerchantAccounts: async () => {
    const res = await api.get<any>('/api/admin/merchant-accounts');
    return res.data;
  },
  makeMerchantAccount: async (merchantId: string) => {
    const res = await api.post('/api/admin/merchant-accounts', { merchantId });
    return res.data;
  },
  listMerchantFlags: async (days = 30) => {
    const res = await api.get<any>('/api/admin/merchant-flags', { params: { days } });
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

/** Filters of Admin › Cycle History, each applied by the server. */
export interface CycleHistoryFilters {
  type?: string;
  audience?: 'VIP' | 'GENERAL';
  search?: string;
  /** IST calendar days the round ended on, `YYYY-MM-DD`, both inclusive. */
  from?: string;
  to?: string;
}
/** One board and profile among the matching cycles (`cycleHistory` totals). */
export interface CycleHistoryTotal {
  type: string; audience: 'VIP' | 'GENERAL'; cycles: number; netProfit: number; paidOut: number;
}

/** Query params without the empty ones, so an unset filter is not sent as ''. */
export const cleanParams = (o: object): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

/**
 * Download a CSV a route builds, under the name the server gives it
 * (`Content-Disposition`), else `fallbackName`. Every table's "Download CSV"
 * goes through here, so the file is always the server's rows, never a copy
 * the screen assembled.
 */
export async function downloadCsv(path: string, params: Record<string, unknown>, fallbackName: string): Promise<void> {
  const res = await api.get(path, { params, responseType: 'blob' });
  const named = /filename="?([^";]+)"?/.exec(String(res.headers?.['content-disposition'] || ''))?.[1];
  const url = URL.createObjectURL(new Blob([res.data as BlobPart], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = named || fallbackName;
  a.click();
  URL.revokeObjectURL(url);
}

export const cycles = {
  getActive: async () => {
    const res = await api.get<any>('/api/cycles/active');
    if (res.data?.success && res.data?.cycles) {
      return { success: true, data: res.data.cycles };
    }
    return res.data;
  },

  /**
   * Finished cycles (`GET /api/admin/cycles/history`): every filter is applied
   * by the server, and `totals` covers every matching cycle, not the page.
   */
  getHistory: async (page = 1, limit = 50, filters: CycleHistoryFilters = {}) => {
    const res = await api.get<any>('/api/admin/cycles/history', { params: { page, limit, ...cleanParams(filters) } });
    // Backend returns { success, cycles, totals, pagination }
    if (res.data?.success && res.data?.cycles) {
      return { success: true, data: res.data.cycles, totals: res.data.totals as CycleHistoryTotal[], pagination: res.data.pagination };
    }
    return res.data;
  },

  /** The same filtered rows as CSV (`GET /api/admin/cycles/history.csv`). */
  downloadHistoryCsv: (filters: CycleHistoryFilters = {}) =>
    downloadCsv('/api/admin/cycles/history.csv', cleanParams(filters), 'cycle-history.csv'),

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

export interface DemoResultsEntry { results: string; count: number; bombay: number; delhi: number }
export interface DemoResultsPage {
  success: boolean;
  max: number;
  audiences: Array<'VIP' | 'GENERAL'>;
  boards: Array<{ key: string; name: string; enabled: boolean; VIP: DemoResultsEntry; GENERAL: DemoResultsEntry }>;
}

// --- BOARDS (owner, 2026-10-08) ------------------------------------------------
// Admin-created board games, each with its own timer, and their home-page order.
// backend/routes/admin/boards.admin.routes.js. Screens that only LABEL boards
// read the public list instead (hooks/useBoards.ts).
export const boards = {
  list: async () => (await api.get<any>('/api/admin/boards')).data,
  create: async (body: Record<string, unknown>) => (await api.post<any>('/api/admin/boards', body)).data,
  update: async (key: string, patch: Record<string, unknown>) =>
    (await api.put<any>(`/api/admin/boards/${encodeURIComponent(key)}`, patch)).data,
  setOrder: async (keys: string[]) => (await api.put<any>('/api/admin/boards/order', { keys })).data,
  rtpFunds: async () => (await api.get<any>('/api/admin/rtp')).data,
  // Demo results the admin types, per board and profile (owner, 2026-10-20).
  demoResults: async () => (await api.get<DemoResultsPage>('/api/admin/boards/demo-results')).data,
  saveDemoResults: async (key: string, audience: string, results: string) =>
    (await api.put<{ success: boolean; count: number; bombay: number; delhi: number; results: string }>(
      `/api/admin/boards/${encodeURIComponent(key)}/demo-results`, { audience, results })).data,
  importDemoResults: async (text: string) =>
    (await api.post<{ success: boolean; saved: Array<{ key: string; audience: string; count: number }> }>(
      '/api/admin/boards/demo-results/import', { text })).data,
  downloadDemoResults: () => downloadCsv('/api/admin/boards/demo-results.csv', {}, 'demo-results.csv'),
  saveRtp: async (game: string, audience: string, body: { enabled: boolean; ratePercent: number }) =>
    (await api.put<any>(`/api/admin/rtp/${encodeURIComponent(game)}/${encodeURIComponent(audience)}`, body)).data,
  rtpEntries: async (game: string, audience: string) =>
    (await api.get<any>(`/api/admin/rtp/${encodeURIComponent(game)}/${encodeURIComponent(audience)}/entries`)).data,
};

// --- CRICKET (owner, 2026-10-18) ---------------------------------------------
// Admin › Cricket: backend/domains/cricket/cricket.admin.routes.js. The game's
// settings are `SystemConfig.cricket`, saved through `system.updateConfig`.
export const cricket = {
  overview: async () => (await api.get<any>('/api/admin/cricket')).data,
  saveToken: async (provider: string, token: string) => (await api.put<any>('/api/admin/cricket/feed-token', { provider, token })).data,
  setProvider: async (provider: string) => (await api.put<any>('/api/admin/cricket/feed-provider', { provider })).data,
  sync: async () => (await api.post<any>('/api/admin/cricket/sync')).data,
  publish: async (matchId: string) =>
    (await api.post<any>(`/api/admin/cricket/matches/${encodeURIComponent(matchId)}/publish`)).data,
  unpublish: async (matchId: string) =>
    (await api.post<any>(`/api/admin/cricket/matches/${encodeURIComponent(matchId)}/unpublish`)).data,
  setOrder: async (matchIds: string[]) => (await api.put<any>('/api/admin/cricket/matches/order', { matchIds })).data,
  follow: async (seriesId: string, seriesName: string) =>
    (await api.post<any>(`/api/admin/cricket/series/${encodeURIComponent(seriesId)}/follow`, { seriesName })).data,
  unfollow: async (seriesId: string) =>
    (await api.delete<any>(`/api/admin/cricket/series/${encodeURIComponent(seriesId)}/follow`)).data,
  polls: async (matchId: string) =>
    (await api.get<any>(`/api/admin/cricket/matches/${encodeURIComponent(matchId)}/polls`)).data,
  settle: async (pollId: string, winningOptions: string[]) =>
    (await api.post<any>(`/api/admin/cricket/polls/${encodeURIComponent(pollId)}/settle`, { winningOptions })).data,
  voidPoll: async (pollId: string, reason: string) =>
    (await api.post<any>(`/api/admin/cricket/polls/${encodeURIComponent(pollId)}/void`, { reason })).data,
  report: async (from: string, to: string) =>
    (await api.get<any>('/api/admin/cricket/report', { params: { from, to } })).data,
  reportCsv: (from: string, to: string) => downloadCsv('/api/admin/cricket/report.csv', { from, to }, 'cricket-polls.csv'),
};

// --- RULES POP-UP (owner, 2026-10-14) -------------------------------------------
// The board rules players accept before betting, edited and published here.
// backend/routes/admin/boardRules.admin.routes.js; shapes mirror
// database/repositories/boardRules.js (`currentText`, `history`).
export interface BoardRulesTextDraft {
  heading: string;
  intro: string;
  sections: { title: string; body: string }[];
}
/** What players are shown: the text filled in, plus the phantom-bets line (renderBoardRules). */
export interface BoardRulesPreview extends BoardRulesTextDraft {
  phantomBetsNotice?: string;
}
export const boardRules = {
  get: async () => (await api.get<any>('/api/admin/board-rules')).data,
  publish: async (text: BoardRulesTextDraft) => (await api.put<any>('/api/admin/board-rules', text)).data,
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

  
  // Take a started order off its member and offer it to the next one, only
  // while nobody can have paid on it (`canReassign`). No body: the server
  // routes it, and its message says whether anybody took it.
  reassignOrder: async (orderId: string) => {
    const res = await api.post(`/api/admin/payment-orders/${orderId}/reassign`);
    return res.data;
  },
};

// --- TELEGRAM -----------------------------------------------------------------
/**
 * Slot 1 carries the Mini App that verifies every player and merchant account
 * and approves their sign-ins (Step 3); slots 2-4 hold standby bots that take
 * over when Telegram refuses the one in use (owner, 2026-10-14). Staff have no
 * Telegram (owner, 2026-10-13). Server: backend/routes/admin/telegram.admin.routes.js.
 */

/** One saved bot, never its token. */
export interface TelegramBotSlot {
  slot: number;
  botId: string;
  botUsername: string;
  miniAppShortName: string;
  suspended: boolean;
  suspendedAt: string | null;
  suspendedReason: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** `GET /api/admin/telegram/bot` — the bot in use (top level) and every saved bot. */
export interface TelegramBot {
  success: boolean;
  configured: boolean;
  slot: number | null;
  botId: string | null;
  botUsername: string;
  miniAppShortName: string;
  updatedAt: string | null;
  updatedBy: string | null;
  /** How many slots there are: the primary and the standbys. */
  slots: number;
  bots: TelegramBotSlot[];
}

export const telegram = {
  getBot: async () => {
    const res = await api.get<TelegramBot>('/api/admin/telegram/bot');
    return res.data;
  },

  /**
   * Either field may be sent alone; `slot` is 1 when left out. The token is
   * asked of Telegram before it is stored; a refusal (400 TOKEN_INVALID,
   * SHORT_NAME_INVALID, SLOT_INVALID, 409 NO_BOT, BOT_IN_OTHER_SLOT) carries
   * the server's own words.
   */
  saveBot: async (body: { slot?: number; token?: string; miniAppShortName?: string }) => {
    const res = await api.put<TelegramBotSlot & { success: boolean }>('/api/admin/telegram/bot', body);
    return res.data;
  },

  /** Remove a standby (slot 2+). */
  removeBot: async (slot: number) => {
    const res = await api.delete<{ success: boolean; slot: number }>(`/api/admin/telegram/bot/${slot}`);
    return res.data;
  },

  /** Put a suspended bot back in use; refused (409 TOKEN_STILL_REFUSED) while Telegram still refuses it. */
  resumeBot: async (slot: number) => {
    const res = await api.post<TelegramBotSlot & { success: boolean }>(`/api/admin/telegram/bot/${slot}/resume`);
    return res.data;
  },
};

// --- MY ACCOUNT: the signed-in staff account's own authenticator --------------
// Server: backend/routes/admin/account.admin.routes.js (SELF_ROUTES).
export const account = {
  authenticator: async (): Promise<AuthenticatorState> => {
    const res = await api.get<any>('/api/admin/account/2fa');
    return {
      enrolled: res.data?.enrolled === true,
      enrolledAt: res.data?.enrolledAt ?? null,
      recoveryCodesLeft: Number(res.data?.recoveryCodesLeft ?? 0),
      recoveryGeneratedAt: res.data?.recoveryGeneratedAt ?? null,
    };
  },

  /** Ten new recovery codes, shown once; needs a current authenticator code. */
  regenerateRecoveryCodes: async (code: string): Promise<string[]> => {
    const res = await api.post<any>('/api/admin/account/2fa/recovery-codes', { code });
    if (res.data?.success && Array.isArray(res.data.recoveryCodes)) return res.data.recoveryCodes as string[];
    throw unexpected(res.status, res.data);
  },
};

// --- SUPERVISORS & TEAMS (redesign Step 2a) ----------------------------------
// Backend: backend/domains/team/team.admin.routes.js, area canManageTeams.
export const teams = {
  list: async () => {
    const res = await api.get<any>('/api/admin/teams');
    return res.data as {
      success: boolean; supervisors: TeamSupervisor[]; teams: TeamView[]; members: TeamMemberView[];
      /** Mirrors ROUTING_PRIORITY in database/repositories/merchants.js. */
      routingPriority: { MIN: number; MAX: number; DEFAULT: number };
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
  /** A member's routing priority, 1–5 (Phase A): highest is offered orders first. */
  setPriority: async (merchantId: string, priority: number) =>
    (await api.put(`/api/admin/merchants/${merchantId}/priority`, { priority })).data as
      { success: boolean; priority: number; message: string },
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
  /**
   * The staff table (`GET /api/admin/staff`, full admin): every STAFF account
   * with its roles, areas and whether it has an authenticator, sorted by a key
   * the server offers (`sorts`) and narrowed to a role it names (`roles`).
   */
  listStaff: async (q: { page?: number; limit?: number; search?: string; role?: string; sort?: string; dir?: 'asc' | 'desc' } = {}) => {
    const res = await api.get<any>('/api/admin/staff', { params: q });
    return res.data as { success: boolean; staff: StaffRow[]; sorts: string[]; roles: StaffRole[]; pagination: { total: number; pages: number } };
  },

  /** One staff account's page (`GET /api/admin/staff/:userId`). */
  getStaff: async (userId: string) => {
    const res = await api.get<any>(`/api/admin/staff/${encodeURIComponent(userId)}`);
    return res.data as { success: boolean; staff: StaffRow; isSelf: boolean };
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
   * Queue-manager authority: routes players' payments, so a STAFF account
   * only (the server refuses any other with 409 and says what to do).
   */
  setQueueManager: async (userId: string, enable: boolean) => {
    const res = await api.post(`/api/admin/users/${userId}/queue-manager`, { enable });
    return res.data;
  },

  delete: async (subAdminId: string) => {
    const res = await api.delete(`/api/admin/sub-admins/${subAdminId}`);
    return res.data;
  },

  /**
   * Forget a staff account's authenticator and end its sessions (full admin
   * only, never your own). Their next sign-in sets up a new app.
   */
  resetAuthenticator: async (userId: string) => {
    const res = await api.post(`/api/admin/staff/${userId}/reset-authenticator`);
    return res.data as { success: boolean; hadAuthenticator?: boolean; message?: string };
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
    // 'NONE', a board's key, or 'BOTH' (= every board); the server holds it to
    // an existing board (`users_phantom_access_known`).
    access: string
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
      // `help`: what each setting means, by dotted path (configHelp.js).
      return { success: true, data: res.data.config, help: res.data.help ?? {} };
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


// --- ERROR LOG --------------------------------------------------------------
// Every failure, server and panels, one row per distinct error (owner,
// 2026-10-20; backend/routes/admin/system.admin.routes.js, the vocabulary
// arriving with each answer).

export type ErrorSeverity = 'CRITICAL' | 'WARNING' | 'MINOR';
export type ErrorStatus = 'OPEN' | 'FIXED';
export interface ErrorLogEntry {
  id: number;
  source: string;
  category: string;
  severity: ErrorSeverity;
  message: string;
  detail: string | null;
  component: string | null;
  location: string | null;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  status: ErrorStatus;
  fixedAt: string | null;
  fixedBy: string | null;
  reopened: number;
}
export interface ErrorLogPage {
  entries: ErrorLogEntry[];
  totals: { total: number; open: number; critical: number; warning: number; minor: number; fixed: number };
  sources: string[];
  categories: string[];
  severities: ErrorSeverity[];
  statuses: ErrorStatus[];
}

export const errorLog = {
  list: async (filters: Partial<Record<'source' | 'category' | 'severity' | 'status', string>>): Promise<ErrorLogPage> => {
    const res = await api.get<ErrorLogPage & { success: boolean }>('/api/admin/error-log', { params: filters });
    return res.data;
  },
  setStatus: async (id: number, status: ErrorStatus): Promise<ErrorLogEntry> => {
    const res = await api.patch<{ success: boolean; entry: ErrorLogEntry }>(`/api/admin/error-log/${id}`, { status });
    return res.data.entry;
  },
  clearFixed: async (): Promise<{ cleared: number; message: string }> => {
    const res = await api.delete<{ success: boolean; cleared: number; message: string }>('/api/admin/error-log/fixed');
    return res.data;
  },
  /** A failure on this panel (`POST /api/internal/error-report`). Best-effort: never throws. */
  report: (report: Record<string, unknown>): void => {
    api.post('/api/internal/error-report', { ...report, panel: 'admin' }).catch(() => {});
  },
};

// --- COLD STORAGE -------------------------------------------------------------
// Old rounds, chats and notifications moved off every live screen, readable by
// a full admin only (owner, 2026-10-20; backend/routes/admin/coldStorage.admin.routes.js).

export type ColdKind = 'CYCLE' | 'CHAT' | 'NOTIFICATION';
export interface ColdEntry {
  id: number;
  kind: ColdKind;
  ref: string;
  firstAt: string;
  lastAt: string;
  rowCount: number;
  archivedAt: string;
}
export interface ColdPage {
  kinds: ColdKind[];
  coldAfterDays: number;
  entries: ColdEntry[];
  totals: Record<ColdKind, { entries: number; rows: number }>;
}

export const coldStorage = {
  list: async (filters: { kind?: string; ref?: string; offset?: number }): Promise<ColdPage> =>
    (await api.get<ColdPage & { success: boolean }>('/api/admin/cold-storage', { params: filters })).data,
  open: async (id: number): Promise<ColdEntry & { rows: Array<{ table: string; row: Record<string, unknown> }> }> =>
    (await api.get<{ success: boolean; entry: ColdEntry & { rows: Array<{ table: string; row: Record<string, unknown> }> } }>(
      `/api/admin/cold-storage/${id}`)).data.entry,
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
};

// ─── SUPPORT DESKS ─────────────────────────────────────────────────────────
// Player and merchant support desks (CLAUDE.md §2, "Support desks";
// backend/domains/support/supportDesk.admin.routes.js). Each desk is its own
// base path behind its own permission.
export type SupportDeskKey = 'PLAYER' | 'MERCHANT';
const DESK_BASE: Record<SupportDeskKey, string> = {
  PLAYER: '/api/admin/support/tickets',
  MERCHANT: '/api/admin/merchant-support/tickets',
};
export const supportDesk = {
  list: async (desk: SupportDeskKey, params: { status?: string; older?: boolean; q?: string }) => {
    const res = await api.get<any>(DESK_BASE[desk], { params: { status: params.status || undefined, older: params.older ? '1' : undefined, q: params.q || undefined } });
    return res.data;
  },
  get: async (desk: SupportDeskKey, id: string) => {
    const res = await api.get<any>(`${DESK_BASE[desk]}/${id}`);
    return res.data;
  },
  revealNumber: async (desk: SupportDeskKey, id: string) => {
    const res = await api.post<any>(`${DESK_BASE[desk]}/${id}/reveal-number`);
    return res.data;
  },
  addNote: async (desk: SupportDeskKey, id: string, content: string) => {
    const res = await api.post<any>(`${DESK_BASE[desk]}/${id}/notes`, { content });
    return res.data;
  },
  setStatus: async (desk: SupportDeskKey, id: string, status: string) => {
    const res = await api.post<any>(`${DESK_BASE[desk]}/${id}/status`, { status });
    return res.data;
  },
  contacts: async () => {
    const res = await api.get<any>('/api/admin/support/contacts');
    return res.data;
  },
  addContact: async (body: { desk: string; telegramUsername: string; label: string }) => {
    const res = await api.post<any>('/api/admin/support/contacts', { ...body, active: true });
    return res.data;
  },
  updateContact: async (id: string, body: { telegramUsername: string; label: string; active: boolean }) => {
    const res = await api.put<any>(`/api/admin/support/contacts/${id}`, body);
    return res.data;
  },
};

// ─── USDT DEPOSITS ─────────────────────────────────────────────────────────
// USDT buys paid to the platform on BNB Smart Chain (`canManageUsdtDeposits`;
// backend/domains/payment/usdtDeposit.admin.routes.js). The shapes mirror
// `toDeposit`, `transfersFor`, `depositTotals` (database/repositories/
// usdtDeposits.js) and `watcherStatus` (usdtDeposit.service.js) (§5).
export interface UsdtDeposit {
  orderId: string; userId: string; username: string | null;
  address: string; derivationIndex: number; keyId: string;
  state: string; createdAt: string; expiresAt: string | null; creditedAt: string | null;
  usdtRequired: number; usdtReceived: number; tokens: number; transfers: number; lastSeenAt: string | null;
  attention: 'LATE' | 'OVERPAID' | 'AFTER_CREDIT' | null;
  sweptAt: string | null; sweptTxHash: string | null; sweptBy: string | null;
}
export interface UsdtTransfer {
  txHash: string; logIndex: number; from: string; usdt: number; blockNumber: number;
  orderStateAtArrival: string; seenAt: string;
  handledAt: string | null; handledBy: string | null; handledNote: string | null;
}
export interface UsdtDepositTotals {
  waiting: number; credited: number; creditedTokens: number; usdtReceived: number; usdtUnswept: number;
}
export interface UsdtWatcherStatus {
  configured: boolean; activeKeyId: string | null; nextBlock: number | null; headBlock: number | null;
  lastOkAt: string | null; lastError: string | null; lastErrorAt: string | null;
}
/** The owner's own wallet the sweep sends to (`usdt_final_wallets`, newest row in use). */
export interface UsdtFinalWallet { address: string; setBy: string; setAt: string }
export interface UsdtDepositsResponse {
  success: boolean; filters: string[]; filter: string; total: number; page: number; pages: number;
  deposits: UsdtDeposit[]; totals: UsdtDepositTotals; watcher: UsdtWatcherStatus;
  finalWallet: UsdtFinalWallet | null; finalWalletHistory: UsdtFinalWallet[]; mayChangeFinalWallet: boolean;
}
export const usdtDeposits = {
  list: async (filter: string, page = 1, limit = 50) =>
    (await api.get<UsdtDepositsResponse>('/api/admin/usdt-deposits', { params: { filter, page, limit } })).data,
  transfers: async (orderId: string) =>
    (await api.get<{ success: boolean; transfers: UsdtTransfer[] }>(`/api/admin/usdt-deposits/${encodeURIComponent(orderId)}/transfers`)).data,
  markHandled: async (orderId: string, note: string) =>
    (await api.post<{ success: boolean; marked: number }>(`/api/admin/usdt-deposits/${encodeURIComponent(orderId)}/handled`, { note })).data,
  recordSweep: async (orderId: string, txHash: string) =>
    (await api.post<{ success: boolean }>(`/api/admin/usdt-deposits/${encodeURIComponent(orderId)}/sweep`, { txHash })).data,
  /** The sweep tool's results file, pasted whole. */
  recordSweeps: async (results: string) =>
    (await api.post<{ success: boolean; recorded: number; results: Array<{ orderId: string; recorded: boolean; reason: string | null }> }>(
      '/api/admin/usdt-deposits/sweeps', { results })).data,
  downloadSweepFile: () => downloadCsv('/api/admin/usdt-deposits/sweep.csv', {}, 'usdt-sweep.csv'),
  /** Full admins only. */
  setFinalWallet: async (address: string) =>
    (await api.put<{ success: boolean; changed: boolean; finalWallet: UsdtFinalWallet }>('/api/admin/usdt-deposits/final-wallet', { address })).data,
};

export default {
  auth,
  analytics,
  users,
  merchants,
  cycles,
  boards,
  boardRules,
  depositPolicy,
  queueManager,
  teams,
  telegram,
  account,
  referrals,
  subAdmins,
  finance,
  branding,
  cdn,
  content,
  system,
  disputes,
  utr,
  usdtDeposits,
  errorLog,
  coldStorage,
  appAssets,
  orderActions,
  chat,
  supportDesk,
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
