// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * ======================================================================
 * ? REAL BACKEND -- v4.3.0
 * ======================================================================
 *
 * FIXES vs v4.2.0:
 *
 * BUG-U1  -- getCycleState now unwraps { success, cycle:{} } -> cycle object.
 *            Before: data.totalDelhi was undefined -> pools showed Rs.0 forever.
 *            After:  const res = await request<{cycle:GameCycle}>(...); return res.cycle || res;
 *
 * BUG-U2  -- getCycleHistory now unwraps { success, cycles:[] } -> GameCycle[].
 *            Also maps delhiPool->totalDelhi / bombayPool->totalBombay for
 *            HistoryPage which reads totalDelhi/totalBombay.
 *            Before: setPastCycles({success,cycles:[...]}) -> pastCycles.filter is not a function
 *
 * BUG-U3  -- getPublicContent / getPromoContent now unwraps { success, content:[] } -> PromoContent[].
 *            Before: data.map(...) -> TypeError on RulesPage / PromoPage / GamePage popup.
 *
 * BUG-U4  -- placeBet response now reads result.balance.deposit/winnings/locked
 *            (handled in GameContext, but return type corrected here too).
 *
 * NEW     -- getWinners(), getFaq(), getSupportLinks(), getBranding() methods added.
 *            Required by WinnersPage, FaqPage, SupportPage, and app-init branding fetch.
 */
// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import { Backend, VerificationState } from './backend.interface';
// L-01 fix: GAME_CORE.ts header requires realBackend.ts to import from it.
import { PAYOUT, WINNER, PHASE } from '../GAME_CORE';
import {
  User, Bet, BettingSide, CycleType, AdminUser, AuditLog,
  PromoContent, Transaction, PromoLocation,
  GameState, ChatMessage, SystemConfigData, GameCycle
} from '../types';
import { io, Socket } from 'socket.io-client';
import { setToken } from './apiClient'; // GOVERNANCE.md M-9: single write path for auth_token
// Bot-mitigation token, attached to credential submits only. Resolves null and
// submits without one when Turnstile is unconfigured or unreachable — the
// server applies the policy, so an outage there must not block the form here.
import { getCaptchaToken } from './captcha';

const GLOBAL_CONFIG = (window as any).BAZAAR_CONFIG || {};
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// --- USER PANEL URL RESOLUTION ------------------------------------------------
// The default launch (docs/GO_LIVE_RUNBOOK.md) serves the user panel and the
// Express backend from the SAME origin behind NGINX, so a relative '/api' just
// works and no env var is needed — that is the last fallback below.
//
// SPLIT-ORIGIN deploys (panel on a different host than the API, or the Capacitor
// Android shell whose origin is https://localhost) instead set, at BUILD time:
//   VITE_API_URL = https://your-backend-domain   (no trailing slash, no /api)
// and we append '/api' because this file uses short paths (/auth/login, /v1/...,
// /admin/...). Native builds are additionally guarded by scripts/assert-native-env.mjs.
//

// -------------------------------------------------------------------------------
const _viteApiUrl: string | undefined = (import.meta as any).env?.VITE_API_URL;

const API_BASE_URL: string =
  (_viteApiUrl ? _viteApiUrl.replace(/\/$/, '') + '/api' : null) ||   // split-origin: absolute backend URL
  GLOBAL_CONFIG.API_URL ||
  (isLocal ? 'http://localhost:8080/api' : '/api');                   // same-origin default

const SOCKET_URL: string =
  (_viteApiUrl ? _viteApiUrl.replace(/\/$/, '') : null) ||             // split-origin: backend origin for WS
  GLOBAL_CONFIG.SOCKET_URL ||
  (isLocal ? 'http://localhost:8080' : window.location.origin);       // same-origin default

// SSE URL -- public broadcast stream (all users, anonymous or logged-in)
const SSE_URL: string =
  (_viteApiUrl ? _viteApiUrl.replace(/\/$/, '') + '/api/sse/events' : null) ||
  (isLocal ? 'http://localhost:8080/api/sse/events' : '/api/sse/events');


class SSEEventBridge extends EventTarget {
  private sse: EventSource | null = null;

  constructor() {
    super();
    this._connect();
  }

  private _connect() {
    try {
      this.sse = new EventSource(SSE_URL);

      // Register all public events we care about
      const publicEvents = [
        'cycle_snapshot', 'new_cycle', 'cycle_result',
        'cycle_phase', 'celebration', 'fireworks', 'cycle_history',
        'bet_placed', 'system_config', 'branding', 'branding_updated',
      ];

      for (const eventName of publicEvents) {
        this.sse.addEventListener(eventName, (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data);
            this.dispatchEvent(Object.assign(new Event(eventName), { data }));
          } catch { /* ignore malformed events */ }
        });
      }

      this.sse.onopen  = () => console.log('[SSE] SSE: Connected to public stream');
      this.sse.onerror = () => console.warn('[SSE] SSE: Connection issue -- browser will auto-reconnect');
    } catch (err) {
      console.error('[SSE] SSE: EventSource creation failed:', err);
    }
  }

  disconnect() {
    this.sse?.close();
    this.sse = null;
  }
}

export class RealBackend implements Backend {
  private socket: Socket | null = null;
  public  sseBridge: SSEEventBridge;

  constructor() {
    // SSE connects immediately for ALL users -- public stream, zero WS overhead
    this.sseBridge = new SSEEventBridge();

    
    
    const token = this.getToken();
    if (token) {
      this._connectWebSocket(token);
    }
  }

  
  private _connectWebSocket(token?: string | null) {
    if (this.socket?.connected) {
      // Already connected -- just refresh auth token if provided
      if (token) {
        (this.socket as any).auth = { token };
      }
      return;
    }

    const authToken = token || this.getToken();
    this.socket = io(SOCKET_URL, {
      transports:           ['websocket'],
      upgrade:              false,
      autoConnect:          true,
      withCredentials:      false,
      reconnectionAttempts: Infinity,
      reconnectionDelay:    1000,
      reconnectionDelayMax: 5000,
      randomizationFactor:  0.5,
      timeout:              45000,
      auth: authToken ? { token: authToken } : undefined
    });

    this.socket.on('connect_error', (err) => {
      console.warn('Socket connect error:', err.message);
    });

    // Join personal room on every (re)connect if logged in
    this.socket.on('connect', () => {
      const userId = this.getUserIdFromToken();
      if (userId) {
        this.socket?.emit('join_user_room', userId);
      }
    });
  }

  /**
   * Force the realtime socket to rebuild itself.
   *
   * socket.io reconnects on its own when it NOTICES a drop, and that covers
   * ordinary network loss. It does not cover the Android case: while the app is
   * backgrounded the OS freezes the connection, and on resume the socket can
   * still report `connected` over a WebSocket that is dead. Detection then
   * waits on the server's ping timeout — tens of seconds during which a live
   * cycle screen shows pools and odds that stopped updating, with no visible
   * sign anything is wrong.
   *
   * Tearing it down explicitly costs one reconnect per foreground, which is the
   * right trade on a screen where stale numbers are what people bet against.
   */
  reconnectRealtime(): void {
    if (!this.socket) {
      this._connectWebSocket();
      return;
    }
    (this.socket as any).auth = { token: this.getToken() };
    this.socket.disconnect();
    this.socket.connect();
  }

  private getToken(): string | null {
    return localStorage.getItem('auth_token');
  }

  private getUserIdFromToken(): string | null {
    try {
      const token = this.getToken();
      if (!token) return null;
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload?.id || payload?.userId || null;
    } catch { return null; }
  }

  private async delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  
  private wsRequest<T>(
    requestEvent: string,
    responseEvent: string,
    payload?: any,
    timeoutMs = 8000,
    defaultValue?: T
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        if (defaultValue !== undefined) resolve(defaultValue);
        else reject(new Error('Socket not initialised'));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.socket?.off(responseEvent, handler);
        if (defaultValue !== undefined) resolve(defaultValue);
        else reject(new Error(`WS timeout waiting for ${responseEvent}`));
      }, timeoutMs);

      const handler = (data: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(data);
      };

      this.socket.once(responseEvent, handler);
      if (payload !== undefined) {
        this.socket.emit(requestEvent, payload);
      } else {
        this.socket.emit(requestEvent);
      }
    });
  }

  private async request<T>(endpoint: string, options: RequestInit = {}, retries = 3): Promise<T> {
    const token = this.getToken();
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...(token && { 'Authorization': `Bearer ${token}` }),  // kept for admin panel compat
      ...options.headers,
    };

    try {
      const response = await fetch(`${API_BASE_URL}${endpoint}`, { ...options, headers, credentials: 'include' });

      if (response.status === 401) {
        localStorage.removeItem('auth_token');
        document.cookie = 'auth_token=; Max-Age=0; path=/';
        throw new Error('Unauthorized');
      }

      if (response.status >= 500 && retries > 0) {
        console.warn(`Server Error ${response.status} at ${endpoint}. Retrying... (${retries} left)`);
        await this.delay(1000 * (4 - retries));
        return this.request<T>(endpoint, options, retries - 1);
      }

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(errorBody.message || `API Error: ${response.status}`);
      }

      if (response.status === 204) return {} as T;
      return await response.json();

    } catch (error: any) {
      if ((error.name === 'TypeError' || error.message === 'Failed to fetch') && retries > 0) {
        console.warn(`Network Error at ${endpoint}. Retrying... (${retries} left)`);
        await this.delay(1000 * (4 - retries));
        return this.request<T>(endpoint, options, retries - 1);
      }
      throw error;
    }
  }

  // -- AUTH -----------------------------------------------------------------
  /**
   * Seat a player, and re-authenticate the socket as them.
   *
   * ── One place, because it was three ────────────────────────────────────
   * The three ways in (the link exchange, the OTP verify, and now the form)
   * each did this token dance themselves. It is four statements and every copy
   * got them right — but a second way of seating a player that forgot to
   * re-auth the socket leaves somebody signed in with a live feed still
   * authenticated as nobody, and that is invisible until a private event does
   * not arrive. So there is one.
   */
  private seat<T extends { success: boolean; token?: string }>(res: T): T {
    if (res.success && res.token) {
      setToken(res.token);   // single call site — in-memory cache + localStorage
      if (!this.socket) {
        this._connectWebSocket(res.token);
      } else {
        (this.socket as any).auth = { token: res.token };
        this.socket.disconnect();
        this.socket.connect();
      }
    }
    return res;
  }

  /**
   * The signup form.
   *
   * The captcha token is fetched HERE rather than by the form, so no screen can
   * forget it and the one place it is obtained is the one place that knows
   * which endpoints require it. `getCaptchaToken` resolves null — never rejects
   * — when Turnstile is unconfigured or Cloudflare is unreachable; the server
   * then decides, and its policy is to allow when its own verifier is down.
   * Throwing on the client would turn somebody else's outage into a signup
   * outage before the server ever got to apply that.
   */
  async register(form: {
    aadhaar: string; mobile: string; password: string; confirmPassword: string;
    referralCode?: string; captchaToken?: string;
  }) {
    const captchaToken = form.captchaToken ?? (await getCaptchaToken()) ?? undefined;
    return this.seat(await this.request<{
      success: boolean; token?: string; user?: User; message?: string }>(
      '/v1/auth/register', { method: 'POST', body: JSON.stringify({ ...form, captchaToken }) }));
  }

  /** The login form. Same captcha posture as `register`. */
  async login(mobile: string, password: string, captchaToken?: string) {
    const token = captchaToken ?? (await getCaptchaToken()) ?? undefined;
    return this.seat(await this.request<{
      success: boolean; token?: string; user?: User; message?: string;
      twoFactorRequired?: boolean; challengeToken?: string }>(
      '/v1/auth/login', { method: 'POST', body: JSON.stringify({ mobile, password, captchaToken: token }) }));
  }

  /** The second leg, for an account with an authenticator enrolled. */
  async verifySecondFactor(challengeToken: string, code: string) {
    return this.seat(await this.request<{
      success: boolean; token?: string; user?: User; message?: string }>(
      '/v1/auth/login/2fa', { method: 'POST', body: JSON.stringify({ challengeToken, code }) }));
  }

  /**
   * Is this invite code real, and whose?
   *
   * Asked because the signup form PRE-FILLS the code from a referral link and
   * makes it non-editable in that case (owner decision). A field somebody
   * cannot change had better be right, and "Invited by player3210" is the
   * confirmation that the link worked.
   */
  async checkInvite(code: string) {
    return this.request<{ valid: boolean; code?: string; invitedBy?: string }>(
      `/v1/auth/invite/${encodeURIComponent(code)}`);
  }

  /** The verification gate's one question. */
  async getVerification(opts: { verify?: boolean } = {}) {
    return this.request<VerificationState>(
      `/v1/auth/verification${opts.verify ? '?verify=1' : ''}`);
  }

  /**
   * Redeem a reset link. Same captcha posture as the other credential routes.
   *
   * NOT seated through `this.seat`: this call returns no token by design, and
   * routing it through the seater would invite somebody to "fix" that by
   * issuing one.
   */
  async resetPassword(token: string, password: string, confirmPassword: string) {
    const captchaToken = (await getCaptchaToken()) ?? undefined;
    return this.request<{ success: boolean; message?: string }>(
      '/v1/auth/password/reset',
      { method: 'POST', body: JSON.stringify({ token, password, confirmPassword, captchaToken }) });
  }

  /** A rejected player submits a corrected Aadhaar. */
  async resubmitAadhaar(aadhaar: string) {
    return this.request<{ success: boolean; message?: string; last4?: string }>(
      '/v1/auth/kyc/resubmit', { method: 'POST', body: JSON.stringify({ aadhaar }) });
  }

  // -- AI ANALYSIS ----------------------------------------------------------
  // BUG-U14 FIX: route now exists at /v1/content/ai-analysis
  async getAIAnalysis() {
    return this.request<{ text: string, cached: boolean, data?: any }>('/v1/content/ai-analysis');
  }

  // -- SYSTEM CONFIG --------------------------------------------------------
  async getSystemConfig(): Promise<SystemConfigData> {
    // WS REPLACEMENT: server pushes 'system_config' on connect AND responds to
    // 'request_system_config'. wsRequest registers the listener first, then emits
    // the request -- whichever event (connect-push or explicit response) arrives
    
    //
    // FIX: Previous HTTP version returned { success, config: { maintenanceMode } }
    // but checkSystem() read config.maintenanceMode -> was always undefined.
    // Server now sends fields FLAT so SystemConfigData is returned directly.
    const defaults: SystemConfigData = {
      maintenanceMode: false, maintenanceMessage: '',
      minVersion: '1.0.0',   latestVersion: '1.0.0',
    };
    try {
      return await this.wsRequest<SystemConfigData>(
        'request_system_config', 'system_config', undefined, 8000, defaults
      );
    } catch {
      return defaults;
    }
  }

  // -- SUBSCRIPTIONS ---------------------------------------------------------
  subscribeToTicker(callback: (data: { id: string, text: string, side: 'DELHI' | 'BOMBAY', amount: number }) => void) {
    if (!this.socket) return () => {};
    this.socket.on('ticker_update', callback);
    return () => { this.socket?.off('ticker_update', callback); };
  }

  subscribeToUserUpdates(userId: string, callback: (data: any) => void) {
    if (!this.socket) return () => {};
    const balanceHandler = (data: any) => callback(data);
    const payoutHandler  = (data: any) => callback({ ...data, type: 'PAYOUT_SUCCESS' });
    const orderHandler   = (data: any) => callback({ ...data, type: 'ORDER_UPDATE' }); // CROSS-4 fix
    this.socket.on('user_update',    balanceHandler);
    this.socket.on('payout_success', payoutHandler);
    this.socket.on('order_update',   orderHandler);
    return () => {
      this.socket?.off('user_update',    balanceHandler);
      this.socket?.off('payout_success', payoutHandler);
      this.socket?.off('order_update',   orderHandler);
    };
  }

  subscribeToBranding(callback: (branding: any) => void) {
    if (!this.socket) return () => {};
    const brandingHandler = (data: any) => callback(data);
    const updatedHandler = (data: any) => callback(data?.branding ?? data);
    this.socket.on('branding', brandingHandler);
    this.socket.on('branding_updated', updatedHandler);
    return () => {
      this.socket?.off('branding', brandingHandler);
      this.socket?.off('branding_updated', updatedHandler);
    };
  }

  subscribeToAdminNotifications(callback: (data: any) => void) {
    if (!this.socket) return () => {};
    this.socket.on('admin_notification', callback);
    return () => { this.socket?.off('admin_notification', callback); };
  }

  subscribeToChat(orderId: string, callback: (msg: ChatMessage) => void) {
    if (!this.socket) return () => {};
    this.socket.on(`chat_${orderId}`, callback);
    return () => { this.socket?.off(`chat_${orderId}`, callback); };
  }

  // -- CYCLE MANAGEMENT ------------------------------------------------------
  // BUG-U1 FIX: backend wraps cycle in { success, cycle:{} } -- unwrap here.
  async getCycleState(type: CycleType, startTime: number): Promise<GameCycle> {
    const res = await this.request<{ success: boolean; cycle: GameCycle }>(`/v1/game/cycle/${type}/${startTime}`);
    const cycle = (res as any).cycle || res;
    // Normalise field aliases so GameContext always has totalDelhi/totalBombay
    return {
      ...cycle,
      totalDelhi:  cycle.totalDelhi  || cycle.delhiPool  || 0,
      totalBombay: cycle.totalBombay || cycle.bombayPool || 0,
    };
  }

  // BUG-U2 FIX: backend returns { success, cycles:[] } -- unwrap and normalise fields.
  async getCycleHistory(type?: string, limit = 50): Promise<GameCycle[]> {
    // WS REPLACEMENT: replaces GET /v1/game/cycles/history.
    // Server also auto-pushes 'cycle_history' after every cycle result, so
    // GameContext doesn't need a polling interval -- it just listens passively.
    try {
      const res = await this.wsRequest<{ cycles: any[] }>(
        'request_cycle_history', 'cycle_history', { type, limit }, 8000, { cycles: [] }
      );
      const arr = res.cycles || [];
      return arr.map((c: any) => ({
        ...c,
        totalDelhi:  c.totalDelhi  || c.delhiPool  || 0,
        totalBombay: c.totalBombay || c.bombayPool || 0,
      }));
    } catch {
      return [];
    }
  }


  // -- USER ------------------------------------------------------------------
  async getUserData(userId: string) {
    // Returns { success, user, bets[], history[] } -- GameContext reads all three
    return this.request<{ user: User, bets: Bet[], history: string[] }>(`/v1/user/${userId}/data`);
  }
  async updateUserProfile(userId: string, updates: any) {
    return this.request<User>(`/user/${userId}/profile`, { method: 'PUT', body: JSON.stringify(updates) });
  }

  // -- BETTING ---------------------------------------------------------------
  /**
   * A fresh idempotency key per user action (per tap). It is generated ONCE here
   * and — because request() reuses the same `options` across its internal 500/
   * network retries — every retry of THIS bet carries the SAME key, so a flaky
   * mobile connection can never turn one tap into two bets. A separate tap is a
   * separate call, gets a new key, and is a genuinely new bet. The backend
   * requires this header on /bet/place and returns the original bet for any
   * redelivery (no second debit, no doubled pool, no duplicate transaction).
   */
  private newIdempotencyKey(): string {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch { /* older webview — fall through to the manual key */ }
    return `bk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  // BUG-U4: Response type updated -- balance object matches what backend actually sends
  async placeBet(userId: string, cycleId: string, amount: number, side: BettingSide) {
    return this.request<{
      bet: Bet,
      balance: { deposit: number, winnings: number, locked: number, total: number }
    }>('/bet/place', {
      method: 'POST',
      headers: { 'Idempotency-Key': this.newIdempotencyKey() },
      body: JSON.stringify({ userId, cycleId, amount, side })
    });
  }
  async placePhantomBet(userId: string, cycleId: string, amount: number, side: BettingSide) {
    return this.request<{ bet: Bet }>('/bet/phantom', {
      method: 'POST', body: JSON.stringify({ userId, cycleId, amount, side })
    });
  }
  async getBetHistory(userId: string) { return this.request<Bet[]>(`/user/${userId}/bets`); }

  // -- WALLET -----------------------------------------------------------------
  // deposit() / withdraw() removed 2026-08-24 — dead, and pointed at the retired
  // `/api/p2p/*` prefix. WalletPage.tsx owns this flow via apiClient.
  async getTransactionHistory(userId: string) {
    const res = await this.request<{ success: boolean; transactions: Transaction[] }>(`/user/${userId}/transactions`);
    return (res as any).transactions || (Array.isArray(res) ? res : []);
  }

  // -- KYC & BANKING ----------------------------------------------------------
  async updateBankDetails(userId: string, details: any) {
    return this.request<User>(`/user/${userId}/bank-details`, { method: 'PUT', body: JSON.stringify(details) });
  }

  // -- WINNERS ----------------------------------------------------------------
  // BUG-U12 FIX: Real winners from the server (not mock data in WinnersPage)

  async getWinners(period: 'today' | 'week' = 'today', limit = 10) {
    const res = await this.request<{ success: boolean; winners: any[] }>(`/v1/winners?period=${period}&limit=${limit}`);
    return (res as any).winners || [];
  }

  // -- FAQ --------------------------------------------------------------------
  // BUG-U9 / CROSS-1 FIX: Admin FAQs now exposed to user panel
  async getFaq() {
    const res = await this.request<{ success: boolean; faqs: any[] }>('/v1/content/faq?isPublished=true');
    return (res as any).faqs || [];
  }

  // -- SUPPORT LINKS ---------------------------------------------------------
  // BUG-U19 FIX: Admin-configured support channels for SupportPage
  async getSupportLinks() {
    const res = await this.request<{ success: boolean; links: any }>('/v1/content/support-links');
    return (res as any).links || {};
  }

  // -- BRANDING --------------------------------------------------------------
  // CROSS-2 FIX: Fetch branding on app init so getAssetUrl() works in production
  async getBranding() {
    // WS REPLACEMENT: server pushes 'branding' on every connect and on 'request_branding'.
    // No HTTP call needed -- branding arrives before any component mounts.
    try {
      const data = await this.wsRequest<any>(
        'request_branding', 'branding', undefined, 8000,
        { appName: 'BettingBazaar', cdnBaseUrl: '', primaryColor: 'var(--brand-primary, #D4AF37)', assets: {} }
      );
      return data;
    } catch {
      return { appName: 'BettingBazaar', cdnBaseUrl: '', primaryColor: 'var(--brand-primary, #D4AF37)', assets: {} };
    }
  }


  // -- PROMO CONTENT ----------------------------------------------------------
  // BUG-U3 FIX: Both methods now unwrap { success, content:[] } before returning
  async getPromoContent(location: PromoLocation): Promise<PromoContent[]> {
    // WS REPLACEMENT: replaces GET /v1/content/promo/:location.
    // Server responds to 'request_promo' with 'promo_data' containing { location, content }.
    // We match on the location field so concurrent requests for different locations
    // don't resolve each other's promises.
    return new Promise((resolve) => {
      if (!this.socket) { resolve([]); return; }
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve([]); } }, 8000);
      const handler = (data: { location: string; content: PromoContent[] }) => {
        if (settled || data.location !== location) return;
        settled = true;
        clearTimeout(timer);
        this.socket?.off('promo_data', handler);
        resolve(data.content || []);
      };
      this.socket.on('promo_data', handler); // use .on not .once (multiple locations possible)
      this.socket.emit('request_promo', { location });
    });
  }
  async getPublicContent(location: PromoLocation): Promise<PromoContent[]> {
    return this.getPromoContent(location);
  }

  // getMerchantProfile / updateMerchantProfile / getMerchantPaymentOrders /
  // acceptOrder / rejectOrder removed 2026-10-01: MERCHANT routes in the
  // PLAYER bundle, called by no screen (measured: report:routes, "client
  // methods no screen calls"). A player token cannot pass merchantAuth, so
  // they could never have worked here; the merchant panel has its own client.
  
  // ── Payment-order + order-chat API removed 2026-08-24 ─────────────────────
  // createPaymentOrder / getPaymentOrder / cancelPaymentOrder / confirmPayment /
  // completePaymentOrder / getUserPaymentOrders / getAllPaymentOrders /
  // sendChatMessage / getChatHistory / getOrderChat / updateOrderStatus and the
  // normalizeOrder helper all addressed an `/api/p2p/*` prefix that no longer
  // exists — the backend serves these under `/api/payment/*`. Nothing called
  // them, so the mismatch stayed invisible: each would have 404'd on first use.
  //
  // The live wallet flow is WalletPage.tsx talking to apiClient directly
  // (`/api/payment/deposit/create`, `/withdrawal/create`, `/orders`,
  // `/order/:id/mark-paid`, `/order/cancel`). Keep it that way — a second client
  // surface for the same endpoints is what let these rot unnoticed.


  // -- TOKEN RATES --------------------------------------------------------------
  // Removed: token conversion is fixed 1:1 (Phase 006 flattening, 2026-07-08).

  // -- IMAGE / FILE UPLOAD -------------------------------------------------------
  // Uses S3 presigned URL flow (IDrive E2 S3 + BunnyCDN delivery):
  //   1. POST /user/profile/picture/upload-url -> presigned S3 PUT URL (5 min expiry)
  //   2. PUT file directly to S3 from browser (no backend bandwidth)
  //   3. POST /user/profile/picture/confirm-upload -> verify object and store CDN URL in User.profilePic
  // No URL/base64 fallback is allowed for persisted user images.
  async uploadImage(file: File) {
    const url = await this.uploadFile(file);
    return { url, imageUrl: url };
  }

  async uploadFile(file: File): Promise<string> {
    // Guard: if file is large and S3 is not configured, warn and compress
    if (file.size > 800_000) {
      console.warn('[uploadFile] Large file (' + (file.size/1024).toFixed(0) + 'kb) — S3 required for files >800kb');
    }
    try {
      const urlRes = await this.request<{
        success: boolean; uploadUrl: string; fileKey: string; cdnUrl: string;
      }>('/user/profile/picture/upload-url', {
        method: 'POST',
        body: JSON.stringify({ fileName: file.name, contentType: file.type, fileSize: file.size })
      });
      if (!urlRes.success || !urlRes.uploadUrl) throw new Error('No upload URL returned');

      const s3Res = await fetch(urlRes.uploadUrl, {
        method:  'PUT',
        headers: { 'Content-Type': file.type },
        body:    file
      });
      if (!s3Res.ok) throw new Error(`S3 upload failed: ${s3Res.status}`);

      await this.request('/user/profile/picture/confirm-upload', {
        method: 'POST',
        body:   JSON.stringify({ fileKey: urlRes.fileKey, cdnUrl: urlRes.cdnUrl })
      });
      return urlRes.cdnUrl; // BunnyCDN URL -- globally accessible
    } catch (err: any) {
      throw new Error(err?.message || 'Upload failed');
    }
  }

  // -- SERVER TIME --------------------------------------------------------------
  async getMe() {
    // Used by GameContext to restore user session on page refresh.
    // Reads token from localStorage (set by login/register) and validates it server-side.
    return this.request<{ success: boolean; user: any }>('/v1/auth/me');
  }

  async getServerTime() { return this.request<{ unixtime: number }>('/v1/system/time'); }












}
