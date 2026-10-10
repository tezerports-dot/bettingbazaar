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
import { setToken } from './apiClient'; // GOVERNANCE.md M-9: single write path for auth_token
import {
  currentOrigin, whenEndpointReady, onOriginChange,
  reportOriginUnreachable, failoverAvailable,
} from './originFailover';
// Bot-mitigation token, attached to credential submits only. Resolves null and
// submits without one when Turnstile is unconfigured or unreachable — the
// server applies the policy, so an outage there must not block the form here.
import { getCaptchaToken } from './captcha';
import { secureFetch, openEventStream, type EventStream } from './secureTransport';

const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// --- USER PANEL URL RESOLUTION ------------------------------------------------
// Every URL is built from the origin `originFailover` adopted, per call, so a
// failover mid-session is followed without a reload — and nothing here opens a
// connection before that origin has been discovered and validated
// (`whenEndpointReady`). An empty origin is a same-origin web deploy: relative
// '/api' works. In local development (Vite on localhost) the SSE stream goes
// straight to the backend, because the dev proxy carries only /api,
// /app-assets and /storage (vite.config.ts) and does not stream.
function apiBase(): string {
  const o = currentOrigin();
  return o ? `${o}/api` : '/api';
}
/**
 * The ONE live connection this app opens (2026-10-10; it opens no socket).
 * Signed out: the public stream. Signed in: the player stream, which carries
 * the same public events plus this player's own pushes, admitted by the server's
 * player door (`authenticatePlayer`). EventSource sends no headers, so the
 * token travels as the query parameter the private streams take.
 */
function sseUrl(token: string | null): string {
  const o = currentOrigin() || (isLocal ? 'http://localhost:8080' : '');
  return token
    ? `${o}/api/sse/player/events?token=${encodeURIComponent(token)}`
    : `${o}/api/sse/events`;
}

/** Retried after a transport failure or a 5xx; anything else may have been applied. */
const IDEMPOTENT = new Set(['GET', 'HEAD']);


/**
 * Every event this app hears, all on the one stream. Public: the cycle
 * lifecycle, pools, history, branding and config. Private (player stream only):
 * `realtimeEmitters.emitToPlayer`'s names. A name not listed here is never
 * heard (§12: compare BOTH lists when adding or renaming an event).
 */
const STREAM_EVENTS = [
  'cycle_snapshot', 'new_cycle', 'cycle_result',
  'cycle_phase', 'celebration', 'fireworks', 'cycle_history',
  'bet_placed', 'system_config', 'branding', 'branding_updated',
  'user_balance_update', 'user_update', 'round_result', 'payout_success', 'order_update',
] as const;

class SSEEventBridge extends EventTarget {
  private sse: EventStream | null = null;
  /** The token the open stream was admitted with; null = the public stream. */
  private openedWith: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The latest payload of each event. `system_config` and `branding` arrive
   * once, at open, and a screen that asks after that must not wait for the
   * next open to hear them.
   */
  readonly last = new Map<string, unknown>();

  constructor(private readonly token: () => string | null) { super(); }

  /** Opened by RealBackend once the endpoint is validated — never at construction. */
  start() {
    if (this.sse) return;
    this._connect();
  }

  /** Reopen against the current origin and session (failover, foreground, sign-in). */
  restart() {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    try { this.sse?.close(); } catch { /* already closed */ }
    this.sse = null;
    this._connect();
  }

  /** Reopen only if the session changed since the stream opened (sign-in, sign-out). */
  syncAuth() {
    if (!this.sse && !this.retryTimer) return;      // not started yet: start() will pick it up
    if (this.token() !== this.openedWith) this.restart();
  }

  /**
   * The current value of a once-per-open event, or the next one, or `fallback`
   * after `timeoutMs`. Never rejects.
   */
  latest<T>(event: string, timeoutMs: number, fallback: T): Promise<T> {
    if (this.last.has(event)) return Promise.resolve(this.last.get(event) as T);
    return new Promise((resolve) => {
      const done = (v: T) => { clearTimeout(timer); this.removeEventListener(event, on); resolve(v); };
      const on = (e: Event) => done((e as any).data as T);
      const timer = setTimeout(() => done(fallback), timeoutMs);
      this.addEventListener(event, on);
    });
  }

  private _connect(asPublic = false) {
    try {
      const token = asPublic ? null : this.token();
      this.openedWith = token;
      // Through the encrypted-DNS transport in the Android shell (secureTransport.ts).
      const es = openEventStream(sseUrl(token));
      this.sse = es;

      for (const eventName of STREAM_EVENTS) {
        es.addEventListener(eventName, (e: Event) => {
          try {
            const data = JSON.parse((e as MessageEvent).data);
            this.last.set(eventName, data);
            this.dispatchEvent(Object.assign(new Event(eventName), { data }));
          } catch { /* ignore malformed events */ }
        });
      }

      es.onopen  = () => console.log(`[SSE] Connected (${token ? 'player' : 'public'} stream)`);
      es.onerror = () => {
        // A probe, not a switch: it moves only if this origin is really gone.
        if (failoverAvailable()) void reportOriginUnreachable(currentOrigin());
        // A dropped stream reconnects by itself (`retry: 3000`). A REFUSED one
        // — the player door's 401/403, or a 5xx — is CLOSED and never retried
        // by the browser. A refused session falls back to the public stream so
        // the boards keep moving (its API calls sign it out on their own 401);
        // anything else is retried here.
        if (es.readyState !== es.CLOSED || this.sse !== es) return;
        this.sse = null;
        this.retryTimer = setTimeout(() => { this.retryTimer = null; this._connect(Boolean(token)); }, 3000);
      };
    } catch (err) {
      console.error('[SSE] EventSource creation failed:', err);
    }
  }
}

export class RealBackend implements Backend {
  public  sseBridge: SSEEventBridge;

  constructor() {
    // The one live connection, for every visitor. Created now, OPENED only
    // once the API origin is validated: no realtime connection to an
    // unvalidated host.
    this.sseBridge = new SSEEventBridge(() => this.getToken());

    void whenEndpointReady().then(() => {
      this.sseBridge.start();
      // A failover moves the stream to the new origin, keeping every listener
      // the screens attached.
      onOriginChange(() => this.sseBridge.restart());
    });
  }

  /**
   * Rebuild the live stream (the native shell, on every foreground).
   *
   * EventSource reconnects on its own when it NOTICES a drop. It does not
   * cover the Android case: while the app is backgrounded the OS freezes the
   * connection, and on resume it can still look open over a dead socket, with
   * a live cycle screen showing pools and timers that stopped moving. One
   * reconnect per foreground is the right trade on a screen where stale numbers
   * are what people bet against; the reopened stream re-sends the snapshot.
   */
  reconnectRealtime(): void {
    this.sseBridge.restart();
  }

  /** Follow a sign-in or sign-out onto the right stream (public or player). */
  syncRealtimeSession(): void {
    this.sseBridge.syncAuth();
  }

  private getToken(): string | null {
    return localStorage.getItem('auth_token');
  }

  private async delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
      const response = await secureFetch(`${apiBase()}${endpoint}`, { ...options, headers, credentials: 'include' });

      if (response.status === 401) {
        localStorage.removeItem('auth_token');
        document.cookie = 'auth_token=; Max-Age=0; path=/';
        this.sseBridge.syncAuth();   // off the player stream: the session is gone
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
   * Seat a player, and move the live stream onto their session.
   *
   * ── One place, because it was three ────────────────────────────────────
   * Every way in (the form, the Telegram poll) seats through here. A second way
   * of seating a player that forgot to move the stream leaves somebody signed
   * in on the public stream, and that is invisible until a private event — a
   * payout, an order update — does not arrive. So there is one.
   */
  private seat<T extends { success: boolean; token?: string }>(res: T): T {
    if (res.success && res.token) {
      setToken(res.token);   // single call site — in-memory cache + localStorage
      this.sseBridge.syncAuth();
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
    // The stream's `system_config`: sent at open and re-sent on every admin
    // save, so the latest one IS the current config and asking costs nothing.
    // Before the stream has delivered one, `GET /api/v1/system/config` — the
    // same builder (systemConfigPayload.js), fields FLAT as SystemConfigData
    // reads them.
    const defaults: SystemConfigData = {
      maintenanceMode: false, maintenanceMessage: '',
      minVersion: '1.0.0',   latestVersion: '1.0.0',
    };
    const streamed = await this.sseBridge.latest<SystemConfigData | null>('system_config', 3000, null);
    if (streamed) return streamed;
    try {
      const res = await this.request<{ config?: SystemConfigData }>('/v1/system/config');
      return res.config ?? defaults;
    } catch {
      return defaults;
    }
  }

  // -- SUBSCRIPTIONS ---------------------------------------------------------
  /** One stream listener, returning its remover. */
  private onStream(event: string, handler: (data: any) => void): () => void {
    const wrapped = (e: Event) => handler((e as any).data);
    this.sseBridge.addEventListener(event, wrapped);
    return () => this.sseBridge.removeEventListener(event, wrapped);
  }

  // `userId` is the screen's; the stream is already this session's own.
  subscribeToUserUpdates(_userId: string, callback: (data: any) => void) {
    const offs = [
      this.onStream('user_update',    (data) => callback(data)),
      this.onStream('payout_success', (data) => callback({ ...data, type: 'PAYOUT_SUCCESS' })),
      this.onStream('order_update',   (data) => callback({ ...data, type: 'ORDER_UPDATE' })), // CROSS-4 fix
    ];
    return () => offs.forEach((off) => off());
  }

  subscribeToBranding(callback: (branding: any) => void) {
    const offs = [
      this.onStream('branding',         (data) => callback(data)),
      this.onStream('branding_updated', (data) => callback(data?.branding ?? data)),
    ];
    return () => offs.forEach((off) => off());
  }


  // -- CYCLE MANAGEMENT ------------------------------------------------------
  // BUG-U2 FIX: backend returns { success, cycles:[] } -- unwrap and normalise fields.
  async getCycleHistory(type?: string, limit = 50, audience?: string): Promise<GameCycle[]> {
    // `limit` is PER TYPE (cycleHistory.service.js). The stream sends 50 rows
    // per type at open and re-sends a board's recent rows after each result;
    // this is for a deeper window, one board at a time.
    try {
      const q = new URLSearchParams({ limit: String(limit) });
      if (type) q.set('type', type);
      if (audience) q.set('audience', audience);
      const res = await this.request<{ cycles: any[] }>(`/v1/game/cycles/history?${q}`);
      return (res.cycles || []).map((c: any) => ({
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
  // WinnersPage fetches /v1/winners itself, the cycle comes over the stream,
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
    // The stream sends `branding` the moment it opens; this is that payload,
    // or the defaults if it has not arrived in 8 s.
    return this.sseBridge.latest<any>('branding', 8000,
      { appName: 'BettingBazaar', cdnBaseUrl: '', primaryColor: 'var(--brand-primary, #D4AF37)', assets: {} });
  }


  // -- PROMO CONTENT ----------------------------------------------------------
  // BUG-U3 FIX: Both methods now unwrap { success, content:[] } before returning
  async getPromoContent(location: PromoLocation): Promise<PromoContent[]> {
    // `GET /api/v1/content/promo/:location` — the published promos, most
    // important first. An empty list on any failure: a missing pop-up is not
    // worth an error on the screen that shows it.
    try {
      const res = await this.request<{ content?: PromoContent[] }>(
        `/v1/content/promo/${encodeURIComponent(location)}`);
      return res.content || [];
    } catch {
      return [];
    }
  }
  async getPublicContent(location: PromoLocation): Promise<PromoContent[]> {
    return this.getPromoContent(location);
  }

  // The home cards come with `devices`: each screen's frame, from the server's
  // one list (database/spec/promoDevices.js), so the app keeps no copy.
  async getHomeCards(): Promise<{ cards: HomePromoCard[]; devices: PromoDevice[] }> {
    // The same door as getPromoContent; an empty row on any failure.
    try {
      const res = await this.request<{ content?: HomePromoCard[]; devices?: PromoDevice[] }>(
        '/v1/content/promo/HOME');
      return { cards: res.content || [], devices: res.devices || [] };
    } catch {
      return { cards: [], devices: [] };
    }
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

    const s3Res = await secureFetch(urlRes.uploadUrl, {
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
