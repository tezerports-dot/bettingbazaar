// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import {
  User, Bet, GameCycle, BettingSide, CycleType, AdminUser, AuditLog,
  PromoContent, Transaction, PromoLocation, MerchantProfile, PaymentOrder,
  GameState, SystemConfigData, ChatMessage
} from '../types';

export interface Backend {
  // --- AUTH ---
  register(data: any): Promise<{ success: boolean; token: string; user: User }>;
  login(data: any): Promise<{ success: boolean; token: string; user: User;
                              twoFactorRequired?: boolean; challengeToken?: string }>;
  /** Second leg of a 2FA login: exchange the challenge for a session. */
  loginTwoFactor(challengeToken: string, code: string): Promise<{
    success: boolean; token: string; user: User; twoFactorExpired?: boolean; message?: string }>;
  
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
  uploadKYC(userId: string, data: any): Promise<{ success: boolean; kycStatus: string }>;
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
  adminLogin(key: string): Promise<{ success: boolean; requires2FA: boolean; admin?: AdminUser }>;
  changeAdminPassword(current: string, newPwd: string): Promise<boolean>;
  verifyLogin2FA(token: string): Promise<{ success: boolean; admin?: AdminUser }>;
  useBackupCode(code: string): Promise<{ success: boolean; admin?: AdminUser }>;
  resetAdminPassword(token: string): Promise<boolean>;
  
  generate2FASecret(): Promise<{ secret: string; otpauth_url: string }>;
  enable2FA(secret: string, token: string): Promise<{ success: boolean; backupCodes: string[] }>;
  disable2FA(): Promise<void>;
  
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
