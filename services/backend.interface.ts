// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { 
  User, Bet, GameCycle, BettingSide, CycleType, AdminUser, AuditLog, 
  PromoContent, Transaction, PromoLocation, MerchantProfile, PaymentOrder, 
  TokenRates, GameState, PaymentOrder 
} from '../types';

export interface Backend {
  // --- AUTH ---
  register(data: any): Promise<{ success: boolean; token: string; user: User }>;
  login(data: any): Promise<{ success: boolean; token: string; user: User }>;
  
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
  uploadKYC(userId: string, data: any): Promise<User>;
  approveKYC(adminId: string, userId: string, status: 'APPROVED' | 'REJECTED', reason?: string): Promise<void>;
  updateBankDetails(userId: string, details: User['bankDetails']): Promise<User>;

  placeBet(userId: string, cycleId: string, amount: number, side: BettingSide): Promise<{ 
    success: boolean; 
    bet: Bet; 
    newBalance: number; 
    newLocked: number;
  }>;

  placePhantomBet(userId: string, cycleId: string, amount: number, side: BettingSide): Promise<{ 
    success: boolean; 
    totalDelhi: number;
    totalBombay: number;
  }>;

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
  
  settleCycle(cycleId: string, winner: BettingSide): void;

  // --- REAL-TIME SUBSCRIPTIONS ---

  subscribeToTicker(callback: (data: { id: string, text: string, side: 'DELHI' | 'BOMBAY', amount: number }) => void): () => void;
  subscribeToUserUpdates(userId: string, callback: (data: any) => void): () => void;

  
  getTokenRates(): Promise<TokenRates>;
  updateTokenRates(buy: number, sell: number, adminId: string): Promise<TokenRates>;
  
  // Admin Ops for Merchants
  addMerchant(profile: Partial<MerchantProfile>, adminId: string): Promise<MerchantProfile & { initialPassword?: string }>;
  removeMerchant(merchantId: string, adminId: string): Promise<void>;
  toggleMerchantOnline(merchantId: string, isOnline: boolean, adminId: string): Promise<void>;
  updateMerchantLimits(merchantId: string, updates: Partial<MerchantProfile>, adminId: string): Promise<void>;
  resetMerchantPassword(merchantId: string, adminId: string): Promise<string>;
  
  // Merchant App Specific
  merchantLogin(id: string, password: string): Promise<{ success: boolean; merchant?: MerchantProfile; user?: User }>;
  getMerchantProfile(merchantId: string): Promise<MerchantProfile>;
  updateMerchantProfile(merchantId: string, updates: Partial<MerchantProfile>): Promise<MerchantProfile>;
  getMerchantList(): Promise<MerchantProfile[]>;
  
  // Payment Order Flow
  createPaymentOrder(userId: string, type: 'DEPOSIT' | 'WITHDRAWAL', amount: number): Promise<PaymentOrder>;
  getUserPaymentOrders(userId: string): Promise<PaymentOrder[]>;
  getAllPaymentOrders(): Promise<PaymentOrder[]>;
  
  getMerchantPaymentOrders(merchantId: string): Promise<PaymentOrder[]>;
  updatePaymentOrderStatus(orderId: string, status: PaymentOrder['status'], actionBy: string): Promise<PaymentOrder>;
  assignPaymentOrderToMerchant(orderId: string, merchantId: string, adminId: string): Promise<PaymentOrder>;
  
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

  generateUser2FA(userId: string): Promise<{ secret: string; otpauth_url: string }>;
  enableUser2FA(userId: string, token: string): Promise<boolean>;
  verifyUser2FA(userId: string, token: string): Promise<boolean>;

  getAdminDashboardData(): Promise<{
    users: User[];
    auditLogs: AuditLog[];
    promos: PromoContent[];
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

  setPhantomAgent(adminId: string, userId: string, accessLevel: 'NONE' | '30_MIN' | 'FULL_DAY'): Promise<void>;

  manageCycle(adminId: string, action: string, payload: any): Promise<void>;
}
