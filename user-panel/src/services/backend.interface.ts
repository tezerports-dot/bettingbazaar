// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import {
  User, Bet, GameCycle, BettingSide, CycleType, AdminUser, AuditLog,
  PromoContent, Transaction, PromoLocation, MerchantProfile, PaymentOrder,
  GameState, SystemConfigData, ChatMessage
} from '../types';

/**
 * What the gate needs, from `GET /api/v1/auth/verification`.
 *
 * `reason` is the SINGLE value a screen reads — one name for the one thing to
 * do next, in the order the player must do it in. A screen deriving that from
 * four booleans would derive it differently from the next screen that tried
 * (§5). Mirrors the object `signupVerification.service.js` returns; §2 names
 * that module as the owner.
 */
export interface VerificationState {
  verified: boolean;
  /** null when verified. */
  reason: 'no_bot' | 'no_channel' | 'share_contact' | 'contact_changed' | 'join_channel' | null;
  contactShared: boolean;
  channelJoined: boolean;
  bot: { username: string } | null;
  botLink: string;
  channel: { inviteLink: string; username: string };
  generation: number;
  /** A live check was asked for and declined by the per-user floor. */
  throttled?: boolean;
}

export interface Backend {
  // --- AUTH ---
  //
  // A FORM, and nothing else. The bot no longer signs anybody in: it proves a
  // phone number and admits somebody to a channel, and the two credentials it
  // used to mint — a one-time link and a six-digit code — are deleted along
  // with the tables that held them (see telegram.routes.js). A compromised or
  // suspended bot must not be an account takeover, and with a fleet of hundreds
  // that stopped being a hypothetical.

  /**
   * Create an account from the SIGNUP FORM.
   *
   * Aadhaar, the Aadhaar-linked mobile, a password, and the invite code if the
   * player arrived through a referral link. The captcha token rides along when
   * Turnstile is configured; the server treats its absence as "not configured"
   * rather than as a refusal, which is how every integration in this repo ships.
   *
   * Resolves with a SESSION on success: the very next thing the player sees is
   * the Telegram verification gate, and the gate has to know who is standing at
   * it. Sending them back to a login form to find that out is a step that
   * exists only to be completed.
   */
  register(form: {
    aadhaar: string; mobile: string; password: string; confirmPassword: string;
    referralCode?: string; captchaToken?: string;
  }): Promise<{ success: boolean; token?: string; user?: User; message?: string }>;

  /**
   * Sign in with the mobile and password.
   *
   * A wrong password, an unknown number and a blocked account are deliberately
   * NOT distinguishable from the two the server answers identically — a login
   * form that says "no such account" is a way to test whether a given person
   * gambles here.
   *
   * `twoFactorRequired` comes back INSTEAD of a session for an enrolled
   * account, carrying a short-lived `challengeToken` that `verifySecondFactor`
   * redeems. `success` is false in that case, deliberately: nothing downstream
   * may mistake a challenge for a login.
   */
  login(mobile: string, password: string, captchaToken?: string): Promise<{
    success: boolean; token?: string; user?: User; message?: string;
    twoFactorRequired?: boolean; challengeToken?: string }>;

  /** Redeem a 2FA challenge with the code from an authenticator app. */
  verifySecondFactor(challengeToken: string, code: string): Promise<{
    success: boolean; token?: string; user?: User; message?: string }>;

  /** Is this invite code real, and whose? Used to confirm a pre-filled code. */
  checkInvite(code: string): Promise<{ valid: boolean; code?: string; invitedBy?: string }>;

  /**
   * The verification gate: may this player use the app, and if not, what next?
   *
   * ONE call, deliberately. The contact share and the channel membership are
   * two halves of one question, and asking them separately means the screen has
   * to decide between two answers that can disagree — which they do, the first
   * time somebody's contact is stood down while their cached channel status
   * still reads `member`.
   *
   * `verify: true` asks for a LIVE check and is what the "I've done it" button
   * sends, once. The default is cache-only and costs nothing.
   */
  getVerification(opts?: { verify?: boolean }): Promise<VerificationState>;

  /**
   * Redeem a reset link the bot sent and SET a password.
   *
   * It does not sign anybody in — see `passwordReset.service.js`. The panel
   * sends them to the login form afterwards.
   */
  resetPassword(token: string, password: string, confirmPassword: string): Promise<{
    success: boolean; message?: string }>;

  /** A REJECTED player submits a corrected Aadhaar, from the panel. */
  resubmitAadhaar(aadhaar: string): Promise<{ success: boolean; message?: string; last4?: string }>;

  // --- CORE SERVICES ---
  getServerTime(): Promise<{ unixtime: number }>;
  
  getUserData(userId: string): Promise<{ 
    user: User; 
    bets: Bet[]; 
    history: string[] 
  } | null>;

  getPublicContent(location: PromoLocation): Promise<PromoContent[]>;

  updateUserProfile(userId: string, updates: any): Promise<User>;

  // SYSTEM CONFIG
  getSystemConfig(): Promise<SystemConfigData>;
  updateSystemConfig(config: SystemConfigData, adminId: string): Promise<void>;

  // AI ANALYSIS
  getAIAnalysis(): Promise<{ text: string, cached: boolean }>;

  // KYC & BANKING
  // uploadKYC removed 2026-08-25 with POST /api/user/:userId/kyc. The bot takes
  // the Aadhaar number before the account exists; there is nothing for a
  // signed-in player to submit.
  approveKYC(adminId: string, userId: string, status: 'APPROVED' | 'REJECTED', reason?: string): Promise<void>;
  updateBankDetails(userId: string, details: User['bankDetails']): Promise<User>;

  placeBet(userId: string, cycleId: string, amount: number, side: BettingSide): Promise<{
    bet: Bet;
    balance: { deposit: number; winnings: number; locked: number; total: number };
  }>;

  placePhantomBet(userId: string, cycleId: string, amount: number, side: BettingSide): Promise<{ bet: Bet }>;

  getCycleState(type: CycleType, startTime: number): Promise<{
    totalDelhi: number;
    totalBombay: number;
    realDelhi: number; 
    realBombay: number; 
    status?: GameState;
    isPaused?: boolean;
    pendingResult?: BettingSide;
    winner?: BettingSide;
  }>;
  
  getCycleHistory(): Promise<GameCycle[]>;
  getBetHistory(userId: string): Promise<Bet[]>;

  // --- REAL-TIME SUBSCRIPTIONS ---

  subscribeToTicker(callback: (data: { id: string, text: string, side: 'DELHI' | 'BOMBAY', amount: number }) => void): () => void;
  subscribeToUserUpdates(userId: string, callback: (data: any) => void): () => void;
  subscribeToBranding(callback: (branding: any) => void): () => void;


  // Token conversion is fixed 1:1 (Phase 006 flattening, 2026-07-08) —
  // getTokenRates/updateTokenRates removed with the TokenRates model.

  // Admin Ops for Merchants
  addMerchant(profile: Partial<MerchantProfile>, adminId: string): Promise<MerchantProfile & { initialPassword?: string }>;
  removeMerchant(merchantId: string, adminId: string): Promise<void>;
  toggleMerchantOnline(merchantId: string, isOnline: boolean, adminId: string): Promise<void>;
  updateMerchantLimits(merchantId: string, updates: Partial<MerchantProfile>, adminId: string): Promise<void>;
  resetMerchantPassword(merchantId: string, adminId: string): Promise<string>;
  
  // Merchant App Specific
  getMerchantProfile(merchantId?: string): Promise<MerchantProfile>;
  updateMerchantProfile(merchantId: string, updates: Partial<MerchantProfile>): Promise<MerchantProfile>;
  getMerchantList(): Promise<MerchantProfile[]>;
  
  // Payment Order Flow
  // createPaymentOrder / getUserPaymentOrders / getAllPaymentOrders /
  // updateOrderStatus / sendChatMessage / getOrderChat were removed 2026-08-24:
  // no screen implemented them and every one addressed the retired `/api/p2p/*`
  // prefix, so they would have 404'd on first use. The player wallet talks to
  // `/api/payment/*` through apiClient from WalletPage.tsx — see the note in
  // realBackend.ts. Do not re-declare these here without a caller.
  getMerchantPaymentOrders(merchantId: string, type?: string): Promise<PaymentOrder[]>;

  // Files
  
  
  
  
  uploadFile(file: File): Promise<string>;

  // --- ADMIN & SECURITY SERVICES ---
  // Admin sign-in is NOT here. The admin panel is a separate application with
  // its own API layer and talks to /api/admin/login directly; the stubs that
  // used to shadow it in this file had no callers and half of them lied about
  // succeeding.

  logAudit(adminId: string, action: string, details: string, targetId?: string): Promise<void>;


  getAdminDashboardData(): Promise<{
    users: User[];
    auditLogs: AuditLog[];
    metrics: any;
  }>;

  getFinancialStats(): Promise<any>;
  
  getCycleAnalytics(): Promise<Array<{
    id: string;
    endTime: number;
    type: CycleType;
    realDelhi: number;
    realBombay: number;
    winner: BettingSide;
    realPool: number;
    payout: number;
    netProfit: number;
  }>>;

  getUserDetails(adminId: string, targetUserId: string): Promise<{
    user: User;
    bets: Bet[];
    transactions: Transaction[];
  }>;

  updateUserStatus(adminId: string, userId: string, status: User['status'], reason: string): Promise<void>;
  deleteUser(adminId: string, userId: string): Promise<void>;
  addUserBalance(adminId: string, userId: string, amount: number, type: 'WITHDRAWABLE' | 'LOCKED', reason: string): Promise<User>;
  
  setUserRole(adminId: string, userId: string, updates: Partial<User>): Promise<User>;


  manageCycle(adminId: string, action: string, payload: any): Promise<void>;

  /**
   * Force the realtime connection to rebuild. Optional: only the real backend
   * holds a socket. Used by the native shell on foreground, where Android can
   * leave a frozen connection reporting itself as healthy.
   */
  reconnectRealtime?(): void;
}
