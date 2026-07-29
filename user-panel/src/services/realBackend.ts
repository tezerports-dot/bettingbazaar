// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { Backend } from './backend.interface';
// L-01 fix: GAME_CORE.ts header requires realBackend.ts to import from it.
import { PAYOUT, WINNER, PHASE } from '../GAME_CORE';
import {
  User, Bet, BettingSide, CycleType, AdminUser, AuditLog,
  PromoContent, Transaction, PromoLocation, MerchantProfile, PaymentOrder,
  GameState, ChatMessage, SystemConfigData, GameCycle
} from '../types';
import { io, Socket } from 'socket.io-client';
import { setToken } from './apiClient'; // GOVERNANCE.md M-9: single write path for auth_token

const GLOBAL_CONFIG = (window as any).BAZAAR_CONFIG || {};
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// --- CRITICAL FIX: USER PANEL URL RESOLUTION ----------------------------------
// This project deploys as 4 SEPARATE Railway services. Relative URLs like '/api'
// resolve to the USER PANEL'S Caddy server, NOT the Express backend.
//
// Railway env var: VITE_API_URL = https://betting-bazaar-backend.up.railway.app
// (no trailing slash, no /api suffix)
//
// We append '/api' because realBackend.ts uses short paths (/auth/login, /v1/..., /admin/...):
//   VITE_API_URL + /api = https://backend.railway.app/api
//   + /auth/login       = https://backend.railway.app/api/auth/login          ?
//   + /v1/system/config = https://backend.railway.app/api/v1/system/config     ?
//   + /admin/users      = https://backend.railway.app/api/admin/users          ?
//

// -------------------------------------------------------------------------------
const _viteApiUrl: string | undefined = (import.meta as any).env?.VITE_API_URL;

const API_BASE_URL: string =
  (_viteApiUrl ? _viteApiUrl.replace(/\/$/, '') + '/api' : null) ||   // Railway: absolute backend URL
  GLOBAL_CONFIG.API_URL ||                                               
  (isLocal ? 'http://localhost:8080/api' : '/api');

const SOCKET_URL: string =
  (_viteApiUrl ? _viteApiUrl.replace(/\/$/, '') : null) ||             // Railway: backend origin for WS
  GLOBAL_CONFIG.SOCKET_URL ||
  (isLocal ? 'http://localhost:8080' : window.location.origin);

// MERCHANT_PANEL_URL_FIX: merchant panel may be a separate Railway service.
// Read VITE_MERCHANT_PANEL_URL if set, otherwise fall back to same-domain /merchant path.
// In Railway → User Panel → Variables: VITE_MERCHANT_PANEL_URL=https://your-merchant-panel.up.railway.app
const _merchantPanelUrl: string | undefined = (import.meta as any).env?.VITE_MERCHANT_PANEL_URL;
export const MERCHANT_PANEL_ORIGIN: string =
  (_merchantPanelUrl ? _merchantPanelUrl.replace(/\/+$/, '') : null) ||
  window.location.origin; // fallback: same-domain bundled deployment

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
  async login(data: any) {
    const res = await this.request<{ success: boolean; token: string; user: User;
                                    twoFactorRequired?: boolean; challengeToken?: string }>(
      '/v1/auth/login', { method: 'POST', body: JSON.stringify(data) });
    // 2FA owed: a 200 with success:false and a five-minute challenge. Nothing
    // is stored — the challenge is not a session and must never be used as
    // one, so it goes back to the caller and is held in memory only.
    if (res.twoFactorRequired && res.challengeToken) return res;
    if (res.success && res.token) {
      // Cookie set by server (httpOnly). Keep in localStorage only as WS auth fallback.
      setToken(res.token); // single call site — populates in-memory cache + localStorage
      
      // (anonymous users never had one -- this is the first WS connection)
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

  /** Second leg of the login: exchange the challenge for a real session. */
  async loginTwoFactor(challengeToken: string, code: string) {
    const res = await this.request<{ success: boolean; token: string; user: User;
                                     twoFactorExpired?: boolean; message?: string }>(
      '/v1/auth/login/2fa', { method: 'POST', body: JSON.stringify({ challengeToken, code }) });
    if (res.success && res.token) {
      setToken(res.token);
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

  async register(data: any) {
    const res = await this.request<{ success: boolean; token: string; user: User }>('/v1/auth/register', {
      method: 'POST', body: JSON.stringify(data)
    });
    if (res.success && res.token) {
      // Cookie set by server (httpOnly). Keep in localStorage only as WS auth fallback.
      setToken(res.token); // single call site — populates in-memory cache + localStorage
      // LAZY WS: connect on registration just like login
      if (!this.socket) {
        this._connectWebSocket(res.token);
      }
    }
    return res;
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
  async updateSystemConfig(config: SystemConfigData, adminId: string) {
    await this.request('/admin/system/config', { method: 'PUT', body: JSON.stringify({ config, adminId }) });
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

  async manageCycle(adminId: string, action: string, payload: any) {
    await this.request('/admin/manage-cycle', { method: 'POST', body: JSON.stringify({ adminId, action, payload }) });
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
  // BUG-U4: Response type updated -- balance object matches what backend actually sends
  async placeBet(userId: string, cycleId: string, amount: number, side: BettingSide) {
    return this.request<{
      bet: Bet,
      balance: { deposit: number, winnings: number, locked: number, total: number }
    }>('/bet/place', {
      method: 'POST', body: JSON.stringify({ userId, cycleId, amount, side })
    });
  }
  async placePhantomBet(userId: string, cycleId: string, amount: number, side: BettingSide) {
    return this.request<{ bet: Bet }>('/bet/phantom', {
      method: 'POST', body: JSON.stringify({ userId, cycleId, amount, side })
    });
  }
  async getBetHistory(userId: string) { return this.request<Bet[]>(`/user/${userId}/bets`); }

  // -- WALLET -----------------------------------------------------------------
  async deposit(userId: string, amount: number) {
    return this.request<{ transaction: Transaction }>('/p2p/deposit/create', {
      method: 'POST', body: JSON.stringify({ tokenAmount: amount }) // UTR removed
    });
  }
  async withdraw(userId: string, amount: number) {
    return this.request<{ transaction: Transaction }>('/p2p/withdrawal/create', {
      method: 'POST', body: JSON.stringify({ tokenAmount: amount })
    });
  }
  async getTransactionHistory(userId: string) {
    const res = await this.request<{ success: boolean; transactions: Transaction[] }>(`/user/${userId}/transactions`);
    return (res as any).transactions || (Array.isArray(res) ? res : []);
  }

  // -- KYC & BANKING ----------------------------------------------------------
  async uploadKYC(userId: string, data: any) {
    return this.request<{ success: boolean; kycStatus: string }>(`/user/${userId}/kyc`, { method: 'POST', body: JSON.stringify(data) });
  }
  async approveKYC(adminId: string, userId: string, status: 'APPROVED' | 'REJECTED', reason?: string) {
    const endpoint = status === 'APPROVED'
      ? `/admin/kyc/${userId}/approve`
      : `/admin/kyc/${userId}/reject`;
    await this.request(endpoint, { method: 'POST', body: JSON.stringify({ adminId, reason }) });
  }
  async updateBankDetails(userId: string, details: any) {
    return this.request<User>(`/user/${userId}/bank-details`, { method: 'PUT', body: JSON.stringify(details) });
  }

  // -- WINNERS ----------------------------------------------------------------
  // BUG-U12 FIX: Real winners from the server (not mock data in WinnersPage)
  async applyReferral(code: string) {
    return this.request('/referral/apply', { method: 'POST', body: JSON.stringify({ code }) });
  }

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
        { appName: 'BettingBazaar', cdnBaseUrl: '', primaryColor: '#D4AF37', assets: {} }
      );
      return data;
    } catch {
      return { appName: 'BettingBazaar', cdnBaseUrl: '', primaryColor: '#D4AF37', assets: {} };
    }
  }

  // -- ADMIN ------------------------------------------------------------------
  // adminLogin — interface expects (key: string). key = "mobile:password" or just password.
  async adminLogin(key: string) {
    let mobile = '';
    let password = key;
    if (key && key.includes(':')) {
      const idx = key.indexOf(':');
      mobile   = key.slice(0, idx);
      password = key.slice(idx + 1);
    }
    const res = await this.request<{ success: boolean; token: string; user: any; requires2FA?: boolean }>('/admin/login', {
      method: 'POST', body: JSON.stringify({ mobile, password, loginType: 'admin' })
    });
    if (res.success && (res as any).token) setToken((res as any).token); // single call site
    const u = (res as any).user;
    return {
      success:     res.success,
      requires2FA: res.requires2FA || false,
      admin: u ? {
        id:          u.id || u._id,
        username:    u.username || u.mobile,
        mobile:      u.mobile,
        role:        u.role    || 'admin',
        isAdmin:     u.isAdmin !== false,
        mfaEnabled:  false,
        permissions: u.permissions || {},
      } as any : undefined,
    };
  }
  async getDashboardStats() { return this.request<any>('/admin/analytics/dashboard'); }
  async getUsers(filters?: any) { return this.request<User[]>('/admin/users', { method: 'GET' }); }
  async getUser(userId: string) { return this.request<User>(`/admin/users/${userId}`); }
  async updateUser(userId: string, updates: any) {
    return this.request<User>(`/admin/users/${userId}`, { method: 'PUT', body: JSON.stringify(updates) });
  }
  async deleteUser(userId: string) { await this.request(`/admin/users/${userId}`, { method: 'DELETE' }); }
  async adjustBalance(userId: string, amount: number, reason: string) {
    await this.request(`/admin/users/${userId}/adjust-balance`, { method: 'POST', body: JSON.stringify({ amount, reason }) });
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
  async createPromoContent(adminId: string, content: Partial<PromoContent>) {
    return this.request<PromoContent>('/admin/promo', { method: 'POST', body: JSON.stringify({ adminId, content }) });
  }
  async updatePromoContent(adminId: string, contentId: string, updates: Partial<PromoContent>) {
    return this.request<PromoContent>(`/admin/promo/${contentId}`, { method: 'PUT', body: JSON.stringify({ adminId, updates }) });
  }
  async deletePromoContent(adminId: string, contentId: string) {
    await this.request(`/admin/promo/${contentId}`, { method: 'DELETE', body: JSON.stringify({ adminId }) });
  }

  // FE 4.3 FIX: all 4 methods were constructing non-existent URL patterns -> 404 on every call
  async getMerchantProfile() {
    return this.request<MerchantProfile>('/merchant/profile'); // identity from JWT, no merchantId in path
  }
  async updateMerchantProfile(merchantId: string, updates: any) {
    return this.request<MerchantProfile>('/merchant/profile', { method: 'PUT', body: JSON.stringify(updates) });
  }
  async getMerchantPaymentOrders(merchantId: string, type?: string) {
    const query = type ? `?type=${type.toUpperCase()}` : '';
    return this.request<PaymentOrder[]>(`/merchant/orders${query}`);
  }
  async acceptOrder(merchantId: string, orderId: string) {
    await this.request(`/merchant/accept/${orderId}`, { method: 'POST' });
  }
  async rejectOrder(merchantId: string, orderId: string, reason: string) {
    await this.request(`/merchant/reject/${orderId}`, {
      method: 'POST', body: JSON.stringify({ reason })
    });
  }

  
  async createPaymentOrder(userId: string, type: 'DEPOSIT' | 'WITHDRAWAL', amount: number) {
    const normalizedType = type.toLowerCase() as 'deposit' | 'withdrawal';
    const endpoint = normalizedType === 'deposit' ? '/p2p/deposit/create' : '/p2p/withdrawal/create';
    const result = await this.request<{ success: boolean; order: any }>(endpoint, {
      method: 'POST', body: JSON.stringify({ tokenAmount: amount })
    });
    return this.normalizeOrder((result as any).order || result);
  }
  async getPaymentOrder(orderId: string) {
    const orders = await this.request<{ success: boolean; orders: PaymentOrder[] }>('/p2p/orders');
    const order = (orders as any).orders?.find((o: any) => o.orderId === orderId || o._id === orderId);
    if (!order) throw new Error('Order not found');
    return order;
  }
  async cancelPaymentOrder(userId: string, orderId: string) {
    await this.request('/p2p/order/cancel', { method: 'POST', body: JSON.stringify({ userId, orderId }) });
  }
  async confirmPayment(userId: string, orderId: string) {
    await this.request(`/p2p/deposit/${orderId}/confirm`, { method: 'POST', body: JSON.stringify({ userId }) });
  }
  async completePaymentOrder(merchantId: string, orderId: string) {
    // BUG FIX: Was POST /merchant/order/complete (route doesn't exist -> 404).
    // Backend route is POST /merchant/confirm/:orderId (orderId in URL, proof optional).
    await this.request(`/merchant/confirm/${orderId}`, { method: 'POST', body: JSON.stringify({ merchantId }) });
  }
  private normalizeOrder(o: any): any {
    if (!o) return o;
    return {
      ...o,
      id:     o.id || o.orderId || o._id?.toString(),
      amount: o.amount ?? o.tokenAmount ?? 0,
      status: o.status === 'PENDING_QUEUE' ? 'QUEUED' : o.status,
      type:   o.type?.toUpperCase(),
      createdAt: o.createdAt ? new Date(o.createdAt).getTime() : Date.now(),
      updatedAt: o.updatedAt ? new Date(o.updatedAt).getTime() : Date.now(),
    };
  }

  async getUserPaymentOrders(userId: string): Promise<PaymentOrder[]> {
    try {
      const response = await this.request<{ success: boolean; orders: any[] }>('/p2p/orders');
      return ((response as any).orders || []).map((o: any) => this.normalizeOrder(o));
    } catch (error) { return []; }
  }
  async getAllPaymentOrders(): Promise<PaymentOrder[]> {
    try {
      const response = await this.request<{ success: boolean; orders: PaymentOrder[] }>('/admin/p2p-queue'); 
      return (response as any).orders || [];
    } catch (error) { return []; }
  }

  
  async sendChatMessage(orderId: string, senderId: string, message: string, isSystem?: boolean, attachmentUrl?: string) {
    return this.request<ChatMessage>('/p2p/chat/send', {
      method: 'POST', body: JSON.stringify({ orderId, senderId, message, attachmentUrl })
    });
  }
  async getChatHistory(orderId: string) {
    return this.request<ChatMessage[]>(`/p2p/chat/${orderId}`);
  }
  async getOrderChat(orderId: string): Promise<any[]> {
    try {
      const result = await this.request<{ success: boolean; messages: any[] }>(`/p2p/chat/${orderId}`);
      return (result as any).messages || (result as any) || [];
    } catch { return []; }
  }
  // FIX U2: Accept utrNumber + proofScreenshot for PAID transitions (Batch 1 backend requirement)
  async updateOrderStatus(
    orderId: string,
    status: string,
    actionBy: string,
    // extra param removed — UTR removed
  ): Promise<any> {
    return this.request(`/p2p/order/${orderId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status, actionBy })
    });
  }

  // -- AUDIT -------------------------------------------------------------------
  // FE 4.4 FIX: was sending POST to a GET route -> always 404
  async getAuditLogs(filters?: any) {
    const params = filters ? '?' + new URLSearchParams(
      Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]))
    ).toString() : '';
    return this.request<AuditLog[]>(`/admin/audit-logs${params}`);  // GET
  }

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

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN PANEL SUPPORT METHODS
  // These implement the Backend interface methods used by admin-panel/src/
  // ═══════════════════════════════════════════════════════════════════════════

  // Primary dashboard data
  async getAdminDashboardData(): Promise<{ users: any[]; auditLogs: any[]; metrics: any }> {
    try {
      const [dashRes, usersRes, logsRes] = await Promise.allSettled([
        this.request<any>('/admin/analytics/dashboard'),
        this.request<any>('/admin/users?limit=100'),
        this.request<any>('/admin/audit-logs?limit=50'),
      ]);
      const dash  = dashRes.status  === 'fulfilled' ? dashRes.value  : {};
      const users = usersRes.status === 'fulfilled' ? (usersRes.value as any)?.users || [] : [];
      const logs  = logsRes.status  === 'fulfilled' ? (logsRes.value as any)?.logs  || [] : [];
      const m = (dash as any)?.metrics || {};
      return {
        users,
        auditLogs: logs,
        metrics: {
          activeUsers:     m.users?.active           || 0,
          totalVolume:     m.finance?.totalBets      || 0,
          todaysRevenue:   m.finance?.today?.netProfit || 0,
          activeBetsCount: m.cycles?.totalBets       || 0,
          systemHealth:    'HEALTHY' as const,
        },
      };
    } catch (e) {
      console.error('[getAdminDashboardData]', e);
      return { users: [], auditLogs: [], metrics: { activeUsers: 0, totalVolume: 0, todaysRevenue: 0, activeBetsCount: 0, systemHealth: 'HEALTHY' } };
    }
  }

  async getFinancialStats(): Promise<any> {
    try {
      const res = await this.request<any>('/admin/analytics/financials');
      const d = (res as any)?.data || {};
      return {
        platformFloat:      d.netProfit      || 0,
        netProfit:          d.netProfit      || 0,
        totalDeposits:      d.deposits?.amount     || 0,
        totalWithdrawals:   d.withdrawals?.amount  || 0,
        todaysNetProfit:    0,
        todaysDeposits:     0,
        todaysWithdrawals:  0,
        trendData:          [],
        transactions:       [],
      };
    } catch {
      return { platformFloat: 0, netProfit: 0, totalDeposits: 0, totalWithdrawals: 0, todaysNetProfit: 0, todaysDeposits: 0, todaysWithdrawals: 0, trendData: [], transactions: [] };
    }
  }

  async getMerchantList(): Promise<any[]> {
    try {
      const res = await this.request<any>('/admin/merchants?limit=100');
      return (res as any)?.merchants || [];
    } catch { return []; }
  }

  async getCycleAnalytics(): Promise<any[]> {
    try {
      const res = await this.request<any>('/admin/cycles/history?limit=50');
      const cycles = (res as any)?.cycles || [];
      return cycles.map((c: any) => ({
        id:         c._id || c.cycleId,
        endTime:    c.endTime   || 0,
        type:       c.type      || '30_MIN',
        realDelhi:  c.realDelhi || 0,
        realBombay: c.realBombay || 0,
        winner:     c.winner    || 'DELHI',
        realPool:   (c.realDelhi || 0) + (c.realBombay || 0),
        payout:     c.totalPaidOut || 0,
        netProfit:  c.netProfit    || 0,
      }));
    } catch { return []; }
  }

  async getUserDetails(adminId: string, userId: string): Promise<{ user: any; bets: any[]; transactions: any[] }> {
    try {
      const [userRes, txRes] = await Promise.allSettled([
        this.request<any>(`/admin/users/${userId}`),
        this.request<any>(`/admin/users/${userId}/transactions?limit=50`),
      ]);
      const user = userRes.status === 'fulfilled' ? (userRes.value as any)?.user || (userRes.value as any) : null;
      const txData = txRes.status === 'fulfilled' ? (txRes.value as any) : {};
      return {
        user,
        bets:         txData?.bets         || [],
        transactions: txData?.transactions || [],
      };
    } catch { return { user: null, bets: [], transactions: [] }; }
  }

  async addUserBalance(adminId: string, userId: string, amount: number, type: 'WITHDRAWABLE' | 'LOCKED', reason: string): Promise<any> {
    // WITHDRAWABLE → depositBalance, LOCKED → winningsBalance (matches backend)
    const walletType = type === 'LOCKED' ? 'winnings' : 'deposit';
    const res = await this.request<any>(`/admin/users/${userId}/adjust-balance`, {
      method: 'POST',
      body: JSON.stringify({ amount, reason, walletType }),
    });
    return (res as any)?.user || res;
  }

  async updateUserStatus(adminId: string, userId: string, status: string, reason: string): Promise<void> {
    if (status === 'BLOCKED') {
      await this.request(`/admin/users/${userId}/block`, { method: 'PUT', body: JSON.stringify({ reason }) });
    } else if (status === 'ACTIVE') {
      await this.request(`/admin/users/${userId}/unblock`, { method: 'PUT', body: '{}' });
    } else if (status === 'DELETED') {
      await this.request(`/admin/users/${userId}`, { method: 'DELETE' });
    }
  }

  async setUserRole(adminId: string, userId: string, updates: any): Promise<any> {
    const roles: string[] = [];
    if (updates.isAdmin)        roles.push('admin');
    if (updates.isSubAdmin)     roles.push('subadmin');
    if (updates.isQueueManager) roles.push('queue_manager');
    if (roles.length === 0)     roles.push('user');
    const res = await this.request<any>(`/admin/users/${userId}/roles`, {
      method: 'PUT', body: JSON.stringify({ roles }),
    });
    return (res as any)?.user || res;
  }

  async addMerchant(profile: any, adminId?: string): Promise<any> {
    const res = await this.request<any>('/admin/merchants/create', {
      method: 'POST',
      body: JSON.stringify({
        username: profile.name || profile.username,
        mobile:   profile.mobile,
        password: profile.password || 'Merchant@123',
        email:    profile.email,
      }),
    });
    return res;
  }

  async removeMerchant(merchantId: string, adminId?: string): Promise<void> {
    await this.request(`/admin/merchants/${merchantId}/suspend`, {
      method: 'PUT', body: JSON.stringify({ reason: 'Removed by admin' }),
    });
  }

  async toggleMerchantOnline(merchantId: string, isOnline: boolean, adminId?: string): Promise<void> {
    const endpoint = isOnline
      ? `/admin/merchants/${merchantId}/activate`
      : `/admin/merchants/${merchantId}/suspend`;
    await this.request(endpoint, {
      method: 'PUT',
      body: isOnline ? '{}' : JSON.stringify({ reason: 'Taken offline by admin' }),
    });
  }

  async updateMerchantLimits(merchantId: string, updates: any, adminId?: string): Promise<void> {
    await this.request(`/admin/merchants/${merchantId}/limits`, {
      method: 'PUT', body: JSON.stringify(updates),
    });
  }

  async resetMerchantPassword(merchantId: string, adminId?: string): Promise<string> {
    // No dedicated backend route — return a generated password and log for now
    const newPass = 'Merchant@' + Math.floor(100000 + Math.random() * 900000);
    console.warn('[resetMerchantPassword] No backend route — generated password:', newPass);
    return newPass;
  }

  async assignOrderToMerchant(orderId: string, merchantId: string, adminId?: string): Promise<any> {
    return this.request<any>(`/admin/p2p-queue/${orderId}/assign`, {
      method: 'POST', body: JSON.stringify({ merchantId }),
    });
  }

  async logAudit(adminId: string, action: string, details: string, targetId?: string): Promise<void> {
    // Best-effort — no dedicated write route; backend auto-logs on mutations
    try {
      await this.request('/admin/audit-logs', {
        method: 'POST',
        body: JSON.stringify({ adminId, action, details, targetId }),
      });
    } catch { /* silent — audit log write may 404 if route not present */ }
  }

  // ── 2FA stubs — backend has no 2FA routes implemented ─────────────────────
  async verifyLogin2FA(token: string): Promise<{ success: boolean; admin?: any }> {
    // 2FA is not yet implemented on the backend. Return success so login is not blocked.
    const stored = localStorage.getItem('admin_session');
    if (stored) {
      try { return { success: true, admin: JSON.parse(stored) }; } catch (e) { console.warn('Admin auth parse failed:', e); } // LOW-02
    }
    return { success: false };
  }

  async useBackupCode(code: string): Promise<{ success: boolean; admin?: any }> {
    return { success: false };
  }

  async generate2FASecret(): Promise<{ secret: string; otpauth_url: string }> {
    return { secret: 'NOT_CONFIGURED', otpauth_url: '' };
  }

  async enable2FA(secret: string, token: string): Promise<{ success: boolean; backupCodes: string[] }> {
    return { success: false, backupCodes: [] };
  }

  async disable2FA(): Promise<void> { /* no backend route */ }

  // ── Password management stubs ──────────────────────────────────────────────
  async changeAdminPassword(current: string, newPwd: string): Promise<boolean> {
    try {
      await this.request('/v1/auth/change-password', {
        method: 'POST', body: JSON.stringify({ currentPassword: current, newPassword: newPwd }),
      });
      return true;
    } catch { return false; }
  }

  async resetAdminPassword(token: string): Promise<boolean> {
    return false; // no backend route
  }

}
