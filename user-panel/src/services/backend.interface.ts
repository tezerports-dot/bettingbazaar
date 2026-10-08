// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import {
  User, Bet, GameCycle, BettingSide, CycleType, AdminUser, AuditLog,
  PromoContent, Transaction, PromoLocation,
  GameState, SystemConfigData, ChatMessage
} from '../types';

/**
 * Where to open the Mini App, and until when (Step 3). Every Telegram step on
 * every panel renders this one block: `telegramBlock` in
 * `backend/domains/identity/telegramChallenge.service.js` is its owner.
 */
export interface TelegramBlock { url: string; botUsername: string; expiresAt: string }

/**
 * What a sign-in or signup leaves the form to do next.
 *
 * `done`: seated. `telegram`: open `telegram.url` and poll with
 * `challengeToken` (`leg` says which route answers the poll). `password`: a
 * "Login with Telegram" that Telegram approved and the password must finish
 * (staff and merchants only; never a player, kept for one shape across doors).
 */
export type SignInStep =
  | { kind: 'done'; user: User }
  | { kind: 'telegram'; leg: 'challenge' | 'telegramLogin'; challengeToken: string;
      telegram: TelegramBlock | null; message: string }
  | { kind: 'unavailable'; message: string };

/** One poll of a Telegram step: still waiting, or seated. A refusal throws. */
export type PollResult = { state: 'pending' } | { state: 'done'; user: User };

/** `GET /api/telegram/mini-app?panel=PLAYER`. */
export interface TelegramSetup { available: boolean; botUsername: string; resetUrl: string | null }

/** The signed-in player's own Telegram (`GET /api/v1/auth/telegram`). */
export interface MyTelegram {
  available: boolean; linked: boolean; telegramUsername: string; firstName: string;
  verifiedAt: string | null; linkedAt: string | null;
  twoFactor: { enabled: boolean; required: boolean };
}

export interface Backend {
  // --- AUTH ---
  //
  // A FORM. Telegram proves the mobile once, at signup, through the Mini App
  // (Step 3, owner 2026-10-07), and approves a sign-in only when the player
  // switched that on. Nothing the bot does grants a session by itself except
  // "Login with Telegram", which proves the same Telegram account the signup
  // verified.

  /**
   * Create an account from the SIGNUP FORM. Never a session: the account is
   * usable once its mobile is verified in Telegram, so this answers with the
   * Telegram step (or `unavailable` when no bot is configured).
   */
  register(form: {
    mobile: string; password: string; confirmPassword: string;
    referralCode?: string; captchaToken?: string;
  }): Promise<SignInStep>;

  /**
   * Sign in with the mobile and password: seated, or the Telegram step an
   * unverified account (or a player with Telegram approval on) owes first.
   *
   * A wrong password and an unknown number are deliberately the same refusal.
   */
  login(mobile: string, password: string, captchaToken?: string): Promise<SignInStep>;

  /** Ask once whether Telegram has answered a step; seats on approval. */
  pollSignIn(leg: 'challenge' | 'telegramLogin', challengeToken: string): Promise<PollResult>;

  /** "Login with Telegram": opens a challenge whose link the player opens. */
  loginWithTelegram(): Promise<SignInStep>;

  /** Is Telegram available, and the "Forgot password" link. Public. */
  getTelegramSetup(): Promise<TelegramSetup>;

  /** The Profile screen's Telegram card. */
  getMyTelegram(): Promise<MyTelegram>;
  /** Move to another Telegram account: the link to open in THAT account. */
  relinkTelegram(): Promise<{ telegram: TelegramBlock; message?: string }>;
  /** The player's own switch: on at once; off once Telegram approves (202). */
  setTelegramTwoFactor(enabled: boolean): Promise<{
    twoFactor?: { enabled: boolean; required: boolean };
    approvalRequired?: boolean; telegram?: TelegramBlock; message?: string }>;

  /** Is this invite code real, and whose? Used to confirm a pre-filled code. */
  checkInvite(code: string): Promise<{ valid: boolean; code?: string; invitedBy?: string }>;

  /**
   * Redeem a reset link (from the Mini App's "Forgot password") and SET a password.
   *
   * It does not sign anybody in — see `passwordReset.service.js`. The panel
   * sends them to the login form afterwards.
   */
  resetPassword(token: string, password: string, confirmPassword: string): Promise<{
    success: boolean; message?: string }>;

  // --- CORE SERVICES ---
  
  getUserData(userId: string): Promise<{ 
    user: User; 
    bets: Bet[]; 
    history: string[] 
  } | null>;

  getPublicContent(location: PromoLocation): Promise<PromoContent[]>;

  updateUserProfile(userId: string, updates: any): Promise<User>;

  // SYSTEM CONFIG
  getSystemConfig(): Promise<SystemConfigData>;

  // AI ANALYSIS

  // BANKING
  updateBankDetails(userId: string, details: User['bankDetails']): Promise<User>;

  placeBet(userId: string, cycleId: string, amount: number, side: BettingSide): Promise<{
    bet: Bet;
    balance: { deposit: number; winnings: number; locked: number; total: number };
  }>;

  placePhantomBet(userId: string, cycleId: string, amount: number, side: BettingSide): Promise<{ bet: Bet }>;

  
  getCycleHistory(): Promise<GameCycle[]>;

  // --- REAL-TIME SUBSCRIPTIONS ---

  subscribeToUserUpdates(userId: string, callback: (data: any) => void): () => void;
  subscribeToBranding(callback: (branding: any) => void): () => void;


  // Token conversion is fixed 1:1 (Phase 006 flattening, 2026-07-08) —
  // getTokenRates/updateTokenRates removed with the TokenRates model.

  // Payment Order Flow
  // createPaymentOrder / getUserPaymentOrders / getAllPaymentOrders /
  // updateOrderStatus / sendChatMessage / getOrderChat were removed 2026-08-24:
  // no screen implemented them and every one addressed the retired `/api/p2p/*`
  // prefix, so they would have 404'd on first use. The player wallet talks to
  // `/api/payment/*` through apiClient from WalletPage.tsx — see the note in
  // realBackend.ts. Do not re-declare these here without a caller. The
  // merchant methods that sat here went 2026-10-01: a player token cannot reach
  // a merchant route.

  // Files
  
  
  
  
  uploadFile(file: File): Promise<string>;

  // --- ADMIN & SECURITY SERVICES ---
  // Admin sign-in is NOT here. The admin panel is a separate application with
  // its own API layer and talks to /api/admin/login directly; the stubs that
  // used to shadow it in this file had no callers and half of them lied about
  // succeeding.

  // The admin calls that used to be declared here (dashboard, users, balances,
  // merchants, cycle control, audit log, and a resetMerchantPassword that
  // invented a password client-side for a route that does not exist) were
  // deleted 2026-09-30. None had a caller, and the player app has no admin
  // screen: every one shipped the admin API's shape to every player's device
  // for nothing. The admin panel has its own API layer.

  /**
   * Force the realtime connection to rebuild. Optional: only the real backend
   * holds a socket. Used by the native shell on foreground, where Android can
   * leave a frozen connection reporting itself as healthy.
   */
  reconnectRealtime?(): void;
}
