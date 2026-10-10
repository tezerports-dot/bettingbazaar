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
import { Backend, SignInStep, PollResult, TelegramSetup, MyTelegram, TelegramBlock } from './backend.interface';
import {
  User, Bet, BettingSide,
  PromoContent, PromoLocation, HomePromoCard, PromoDevice,
  SystemConfigData, GameCycle
} from '../types';
import { io, Socket } from 'socket.io-client';
import { setToken } from './apiClient'; // GOVERNANCE.md M-9: single write path for auth_token
import {
  currentOrigin, whenEndpointReady, endpointState, onOriginChange,
  reportOriginUnreachable, failoverAvailable,
} from './originFailover';
// Bot-mitigation token, attached to credential submits only. Resolves null and
// submits without one when Turnstile is unconfigured or unreachable — the
// server applies the policy, so an outage there must not block the form here.
import { getCaptchaToken } from './captcha';

const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// --- USER PANEL URL RESOLUTION ------------------------------------------------
// Every URL is built from the origin `originFailover` adopted, per call, so a
// failover mid-session is followed without a reload — and nothing here opens a
// connection before that origin has been discovered and validated
// (`whenEndpointReady`). An empty origin is a same-origin web deploy: relative
// '/api' works. In local development (Vite on localhost) the two realtime
// transports go straight to the backend, because the dev proxy carries only
// /api, /app-assets and /storage (vite.config.ts).
function apiBase(): string {
  const o = currentOrigin();
  return o ? `${o}/api` : '/api';
}
function socketUrl(): string {
  return currentOrigin() || (isLocal ? 'http://localhost:8080' : window.location.origin);
}
function sseUrl(): string {
  const o = currentOrigin();
  return o ? `${o}/api/sse/events` : (isLocal ? 'http://localhost:8080/api/sse/events' : '/api/sse/events');
}

/** Retried after a transport failure or a 5xx; anything else may have been applied. */
const IDEMPOTENT = new Set(['GET', 'HEAD']);


class SSEEventBridge extends EventTarget {
  private sse: EventSource | null = null;

  /** Opened by RealBackend once the endpoint is validated — never at construction. */
  start() {
    if (this.sse) return;
    this._connect();
  }

  /** Reopen against the current origin (after a failover). */
  restart() {
    try { this.sse?.close(); } catch { /* already closed */ }
    this.sse = null;
    this._connect();
  }

  private _connect() {
    try {
      const url = sseUrl();
      this.sse = new EventSource(url);

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
      this.sse.onerror = () => {
        console.warn('[SSE] SSE: Connection issue -- browser will auto-reconnect');
        // A probe, not a switch: it moves only if this origin is really gone.
        if (failoverAvailable()) void reportOriginUnreachable(currentOrigin());
      };
    } catch (err) {
      console.error('[SSE] SSE: EventSource creation failed:', err);
    }
  }
}

export class RealBackend implements Backend {
  private socket: Socket | null = null;
  public  sseBridge: SSEEventBridge;

  constructor() {
    // SSE is the public stream for ALL users. Created now, OPENED only once the
    // API origin is validated: no realtime connection to an unvalidated host.
    this.sseBridge = new SSEEventBridge();

    void whenEndpointReady().then(() => {
      this.sseBridge.start();
      const token = this.getToken();
      if (token) this._connectWebSocket(token);
      // A failover moves both realtime transports to the new origin, keeping
      // every listener the screens attached.
      onOriginChange(() => {
        this.sseBridge.restart();
        if (this.socket) {
          (this.socket.io as any).uri = socketUrl();
          this.socket.disconnect();
          this.socket.connect();
        }
      });
    });
  }

  
  private _connectWebSocket(token?: string | null) {
    if (endpointState() !== 'ready') {
      void whenEndpointReady().then(() => this._connectWebSocket(token));
      return;
    }
    if (this.socket?.connected) {
      // Already connected -- just refresh auth token if provided
      if (token) {
        (this.socket as any).auth = { token };
      }
      return;
    }

    const authToken = token || this.getToken();
    this.socket = io(socketUrl(), {
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
      if (failoverAvailable()) void reportOriginUnreachable(currentOrigin());
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
    await whenEndpointReady();
    const origin = currentOrigin();
    const idempotent = IDEMPOTENT.has(String(options.method || 'GET').toUpperCase());
    const token = this.getToken();
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...(token && { 'Authorization': `Bearer ${token}` }),  // kept for admin panel compat
      ...options.headers,
    };

    try {
      const response = await fetch(`${apiBase()}${endpoint}`, { ...options, headers, credentials: 'include' });

      if (response.status === 401) {
        localStorage.removeItem('auth_token');
        document.cookie = 'auth_token=; Max-Age=0; path=/';
        // The server's own sentence and code travel with it: a sign-in form
        // reads "Wrong mobile number or password", and a Telegram poll reads
        // TWO_FACTOR_DENIED, neither of which "Unauthorized" says.
        const body = await response.json().catch(() => ({}));
        throw Object.assign(new Error(body.message || 'Unauthorized'),
          { status: 401, code: body.code, data: body });
      }

      if (response.status >= 500 && retries > 0 && idempotent) {
        console.warn(`Server Error ${response.status} at ${endpoint}. Retrying... (${retries} left)`);
        await this.delay(1000 * (4 - retries));
        return this.request<T>(endpoint, options, retries - 1);
      }

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        // Status, code and body travel with the sentence: the login pace
        // countdown reads `retryAt`, and the Telegram step reads its link off a
        // 403 TELEGRAM_VERIFICATION_REQUIRED.
        throw Object.assign(new Error(errorBody.message || `API Error: ${response.status}`),
          { status: response.status, code: errorBody.code, data: errorBody });
      }

      if (response.status === 204) return {} as T;
      return await response.json();

    } catch (error: any) {
      const transport = error.name === 'TypeError' || error.message === 'Failed to fetch';
      // A transport failure may mean this origin is gone: let failover find a
      // live one for the next request. Only an idempotent request is replayed —
      // a POST whose answer was lost may already have been applied.
      if (transport && failoverAvailable()) await reportOriginUnreachable(origin);
      if (transport && idempotent && retries > 0) {
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
    mobile: string; password: string; confirmPassword: string;
    referralCode?: string; captchaToken?: string;
  }): Promise<SignInStep> {
    const captchaToken = form.captchaToken ?? (await getCaptchaToken()) ?? undefined;
    const res = await this.request<{
      success: boolean; verificationAvailable?: boolean; challengeToken?: string | null;
      telegram?: TelegramBlock | null; message?: string }>(
      '/v1/auth/register', { method: 'POST', body: JSON.stringify({ ...form, captchaToken }) });
    if (res.verificationAvailable === false || !res.challengeToken) {
      return { kind: 'unavailable', message: res.message || 'Your account is created. Sign in later to verify it in Telegram.' };
    }
    return { kind: 'telegram', leg: 'challenge', challengeToken: res.challengeToken,
      telegram: res.telegram ?? null, message: res.message || '' };
  }

  /**
   * The login form. Same captcha posture as `register`.
   *
   * Two answers are a Telegram step rather than a session: 200
   * `twoFactorRequired` (Telegram approval on) and 403
   * TELEGRAM_VERIFICATION_REQUIRED (the mobile was never verified). Neither is
   * a failure, so neither throws.
   */
  async login(mobile: string, password: string, captchaToken?: string): Promise<SignInStep> {
    const token = captchaToken ?? (await getCaptchaToken()) ?? undefined;
    let res: { success: boolean; token?: string; user?: User; message?: string;
      twoFactorRequired?: boolean; challengeToken?: string; telegram?: TelegramBlock | null };
    try {
      res = await this.request('/v1/auth/login',
        { method: 'POST', body: JSON.stringify({ mobile, password, captchaToken: token }) });
    } catch (err) {
      const e = err as { code?: string; data?: { challengeToken?: string; telegram?: TelegramBlock; message?: string } };
      if (e.code === 'TELEGRAM_VERIFICATION_REQUIRED' && e.data?.challengeToken) {
        return { kind: 'telegram', leg: 'challenge', challengeToken: e.data.challengeToken,
          telegram: e.data.telegram ?? null, message: e.data.message || '' };
      }
      throw err;
    }
    if (res.twoFactorRequired && res.challengeToken) {
      return { kind: 'telegram', leg: 'challenge', challengeToken: res.challengeToken,
        telegram: res.telegram ?? null, message: res.message || '' };
    }
    if (!res.success || !res.user) throw new Error(res.message || 'Could not sign you in. Please try again.');
    this.seat(res);
    return { kind: 'done', user: res.user };
  }

  /**
   * One poll. 202 is "not yet"; a session is seated here, through the one
   * seater; a 401 (denied, expired) throws with the server's sentence.
   */
  async pollSignIn(leg: 'challenge' | 'telegramLogin', challengeToken: string): Promise<PollResult> {
    const path = leg === 'challenge' ? '/v1/auth/login/2fa' : '/v1/auth/login/telegram/complete';
    const res = await this.request<{ success: boolean; pending?: boolean; token?: string; user?: User }>(
      path, { method: 'POST', body: JSON.stringify({ challengeToken }) }, 0);
    if (res.success && res.token && res.user) { this.seat(res); return { state: 'done', user: res.user }; }
    return { state: 'pending' };
  }

  async loginWithTelegram(): Promise<SignInStep> {
    const res = await this.request<{ challengeToken?: string; telegram?: TelegramBlock; message?: string }>(
      '/v1/auth/login/telegram', { method: 'POST', body: '{}' });
    if (!res.challengeToken) {
      return { kind: 'unavailable', message: res.message || 'Telegram sign-in is not available right now.' };
    }
    return { kind: 'telegram', leg: 'telegramLogin', challengeToken: res.challengeToken,
      telegram: res.telegram ?? null, message: res.message || '' };
  }

  async getTelegramSetup(): Promise<TelegramSetup> {
    return this.request<TelegramSetup>('/telegram/mini-app?panel=PLAYER');
  }

  async getMyTelegram(): Promise<MyTelegram> {
    return this.request<MyTelegram>('/v1/auth/telegram');
  }

  async relinkTelegram() {
    return this.request<{ telegram: TelegramBlock; message?: string }>(
      '/v1/auth/telegram/relink', { method: 'POST', body: '{}' });
  }

  async setTelegramTwoFactor(enabled: boolean) {
    return this.request<{ twoFactor?: { enabled: boolean; required: boolean };
      approvalRequired?: boolean; telegram?: TelegramBlock; message?: string }>(
      '/v1/auth/telegram/two-factor', { method: 'PUT', body: JSON.stringify({ enabled }) });
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


  // -- CYCLE MANAGEMENT ------------------------------------------------------
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

  // getBetHistory / getTransactionHistory / getWinners / getCycleState /
  // getAIAnalysis / getServerTime / uploadImage and the ticker, admin-
  // notification and order-chat subscriptions removed 2026-10-01: no screen
  // called any of them (report:routes). History arrives with getUserData,
  // WinnersPage fetches /v1/winners itself, the cycle comes over the socket,
  // and the server emits neither `ticker_update` nor `admin_notification`.

  // -- WALLET -----------------------------------------------------------------
  // deposit() / withdraw() removed 2026-08-24 — dead, and pointed at the retired
  // `/api/p2p/*` prefix. WalletPage.tsx owns this flow via apiClient.

  // -- BANKING ----------------------------------------------------------------
  // The four fields of a bank account; the server keeps nothing else (§24).
  async updateBankDetails(userId: string, details: User['bankDetails']) {
    return this.request<User>(`/user/${userId}/bank-details`, { method: 'PUT', body: JSON.stringify(details) });
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

  // The home cards come with `devices`: each screen's frame, from the server's
  // one list (database/spec/promoDevices.js), so the app keeps no copy.
  async getHomeCards(): Promise<{ cards: HomePromoCard[]; devices: PromoDevice[] }> {
    return new Promise((resolve) => {
      if (!this.socket) { resolve({ cards: [], devices: [] }); return; }
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ cards: [], devices: [] }); } }, 8000);
      const handler = (data: { location: string; content?: HomePromoCard[]; devices?: PromoDevice[] }) => {
        if (settled || data.location !== 'HOME') return;
        settled = true;
        clearTimeout(timer);
        this.socket?.off('promo_data', handler);
        resolve({ cards: data.content || [], devices: data.devices || [] });
      };
      this.socket.on('promo_data', handler);
      this.socket.emit('request_promo', { location: 'HOME' });
    });
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
  async uploadFile(file: File): Promise<string> {
    // Guard: if file is large and S3 is not configured, warn and compress
    if (file.size > 800_000) {
      console.warn('[uploadFile] Large file (' + (file.size/1024).toFixed(0) + 'kb) — S3 required for files >800kb');
    }
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
  }

  // -- SERVER TIME --------------------------------------------------------------
  async getMe() {
    // Used by GameContext to restore user session on page refresh.
    // Reads token from localStorage (set by login/register) and validates it server-side.
    return this.request<{ success: boolean; user: any }>('/v1/auth/me');
  }












}
