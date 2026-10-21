// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import {
  User, Bet, GameCycle, BettingSide,
  PromoContent, PromoLocation, HomePromoCard, PromoDevice,
  SystemConfigData
} from '../types';

/**
 * Where to open the Mini App, and until when (Step 3). Every Telegram step on
 * every panel renders this one block: `telegramBlock` in
 * `backend/domains/identity/telegramChallenge.service.js` is its owner.
 */
/** `telegramBlock` (telegramChallenge.service.js): the https link, and `appUrl`, the
 *  same link addressed to the Telegram app (`tg://resolve`), null with no bot. */
export interface TelegramBlock { url: string; appUrl?: string | null; botUsername: string; expiresAt: string }

/**
 * What "Continue with Telegram" leaves the screen to do next.
 *
 * `done`: seated. `telegram`: open `telegram.url` and poll with
 * `challengeToken`. `unavailable`: no bot is configured, said plainly.
 */
export type SignInStep =
  | { kind: 'done'; user: User }
  | { kind: 'telegram'; challengeToken: string;
      telegram: TelegramBlock | null; message: string;
      /** How the approval comes back, and the MATCH number to show. */
      delivery?: TelegramDelivery; matchNumber?: number | null }
  | { kind: 'unavailable'; message: string };

/**
 * How an approved "Continue with Telegram" reaches a browser (CLAUDE.md §33):
 * MATCH, this screen polls and shows a number the Mini App must match;
 * HANDOFF, Telegram opens the site on the phone that pressed Verify.
 */
export type TelegramDelivery = 'MATCH' | 'HANDOFF';

/**
 * One poll of a Telegram step: still waiting, seated, or handed off (verified,
 * and the session went where Telegram opened the site). A refusal throws.
 */
export type PollResult = { state: 'pending' } | { state: 'done'; user: User } | { state: 'handedOff'; message: string };

/** `GET /api/telegram/mini-app?panel=PLAYER`. */
export interface TelegramSetup { available: boolean; botUsername: string }

export interface Backend {
  // --- AUTH ---
  //
  // "Continue with Telegram", and nothing else (owner, 2026-10-14): no
  // password, no form, no reset. Signing up and signing in are one action;
  // the first Verify shares the contact once and makes the account.

  /** Ask once whether Telegram has answered; seats on approval. */
  pollSignIn(challengeToken: string): Promise<PollResult>;

  /** "Continue with Telegram": opens a sign-in whose link the player opens. */
  loginWithTelegram(opts?: { delivery?: TelegramDelivery; referralCode?: string; captchaToken?: string | null }): Promise<SignInStep>;

  /** The one-time ticket the Mini App opened this site with, exchanged for the session. */
  redeemTelegramTicket(ticket: string): Promise<User>;

  /** Is Telegram available. Public. */
  getTelegramSetup(): Promise<TelegramSetup>;

  /** Is this invite code real, and whose? Used to confirm a pre-filled code. */
  checkInvite(code: string): Promise<{ valid: boolean; code?: string; invitedBy?: string }>;


  // --- CORE SERVICES ---
  
  getUserData(userId: string): Promise<{ 
    user: User; 
    bets: Bet[]; 
    history: string[] 
  } | null>;

  getPublicContent(location: PromoLocation): Promise<PromoContent[]>;
  /** The home promo cards and the screens they are drawn for (`GET /api/v1/content/promo/HOME`). */
  getHomeCards(): Promise<{ cards: HomePromoCard[]; devices: PromoDevice[] }>;

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

  
  getCycleHistory(type?: string, limit?: number, audience?: string): Promise<GameCycle[]>;

  // --- REAL-TIME SUBSCRIPTIONS ---

  subscribeToUserUpdates(userId: string, callback: (data: any) => void): () => void;
  subscribeToBranding(callback: (branding: any) => void): () => void;
  subscribeToCricket(onOdds: (data: any) => void, onSettled: (data: any) => void): () => void;


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
   * Force the live stream to rebuild. Optional: only the real backend holds
   * one. Used by the native shell on foreground, where Android can leave a
   * frozen connection reporting itself as healthy.
   */
  reconnectRealtime?(): void;

  /** Move the live stream onto the current session (after a sign-out). */
  syncRealtimeSession?(): void;
}
