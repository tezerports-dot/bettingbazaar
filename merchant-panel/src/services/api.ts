// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import {
  MerchantProfile,
  PaymentOrder,
  ChatMessage,
  AuthResponse,
  Earnings,
  Stats,
} from '../types';
import { ENDPOINTS, ERROR_MESSAGES } from '../constants';

// BUG FIX: Was returning window.location.origin in production.
// In Railway's 4-service deployment, the merchant panel runs on its own Caddy domain
// (e.g. merchant-panel.up.railway.app) which is NOT the backend domain.
// Returning window.location.origin caused every API call to hit Caddy -> 404.
// Fix: read VITE_API_URL (set in Railway -> merchant-panel service -> Variables).
const getAPIBaseURL = (): string => {
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return (import.meta.env.VITE_API_URL as string) || 'http://localhost:8080';
  }
  // Production: MUST use VITE_API_URL env var.
  // Set VITE_API_URL = https://your-backend.up.railway.app in Railway Variables.
  return (import.meta.env.VITE_API_URL as string) || window.location.origin;
};

const BASE_URL = getAPIBaseURL();

export const getAuthToken = (): string | null => {
  return localStorage.getItem('merchantToken');
};

export const getMerchantData = (): MerchantProfile | null => {
  const data = localStorage.getItem('merchantData');
  return data ? JSON.parse(data) : null;
};

const setMerchantData = (merchant: MerchantProfile): void => {
  localStorage.setItem('merchantData', JSON.stringify(merchant));
};

const clearAuthData = (): void => {
  localStorage.removeItem('merchantToken');
  localStorage.removeItem('merchantData');
};

export const isAuthenticated = (): boolean => {
  return !!getAuthToken();
};

export const getCurrentMerchant = (): MerchantProfile | null => {
  return getMerchantData();
};

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = getAuthToken();
  
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(token && { Authorization: `Bearer ${token}` }),
    ...options.headers,
  };

  if (options.body instanceof FormData) {
    delete (headers as any)['Content-Type'];
  }

  try {
    const url = `${BASE_URL}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers,
      mode: 'cors',
      credentials: 'include',
    });
    
    if (response.status === 401) {
      const hadSession = !!getAuthToken();
      clearAuthData();
      // Read the actual error message from the backend response
      let errMsg = ERROR_MESSAGES.SESSION_EXPIRED;
      try {
        const errData = await response.clone().json();
        if (errData?.message) errMsg = errData.message;
      } catch { /* ignore parse errors */ }
      if (hadSession) {
        window.location.href = '/merchant/';
      }
      throw new Error(errMsg);
    }
    
    const contentType = response.headers.get('content-type');
    let data: any;
    
    if (contentType && contentType.includes('application/json')) {
      data = await response.json();
    } else {
      const text = await response.text();
      data = { message: text };
    }
    
    if (!response.ok) {
      throw new Error(data.message || `Request failed with status ${response.status}`);
    }
    
    return data as T;
  } catch (error: any) {
    console.error(`API Error [${endpoint}]:`, error);
    throw error;
  }
}

// =======================================================================
// AUTHENTICATION
// =======================================================================

export const merchantLogin = async (mobile: string, password: string): Promise<AuthResponse> => {
  try {
    // FIX 2: No longer sends loginType -- the dedicated merchant endpoint handles auth
    const data = await request<AuthResponse>(ENDPOINTS.AUTH.LOGIN, {
      method: 'POST',
      body: JSON.stringify({ mobile, password }),
    });
    
    if (data.token) {
      localStorage.setItem('merchantToken', data.token);
    }
    
    const merchant = data.user || data.merchant;
    if (merchant) {
      setMerchantData(merchant);
    }
    
    return data;
  } catch (error: any) {
    throw new Error(error.message || 'Login failed');
  }
};

// FIX 2: New -- allows merchants to self-register; admin must approve before they can login
export const merchantSignup = async (fields: {
  username: string;
  mobile: string;
  email?: string;
  password: string;
  confirmPassword: string;
}): Promise<{ success: boolean; message: string }> => {
  try {
    const data = await request<{ success: boolean; message: string }>(ENDPOINTS.AUTH.SIGNUP, {
      method: 'POST',
      body: JSON.stringify(fields),
    });
    return data;
  } catch (error: any) {
    throw new Error(error.message || 'Signup failed');
  }
};

export const logout = (): void => {
  clearAuthData();
  window.location.href = "/merchant/";
};

export const getMerchantProfile = async (): Promise<MerchantProfile> => {
  const data = await request<any>(ENDPOINTS.AUTH.PROFILE);
  return data.merchant || data;
};

// =======================================================================
// ORDERS
// =======================================================================

export const getOrders = async (params?: {
  status?: string;
  type?: string;
  limit?: number;
  skip?: number;
}): Promise<{ orders: PaymentOrder[]; pagination?: any }> => {
  try {
    const queryParams = new URLSearchParams();
    if (params?.status) queryParams.append('status', params.status);
    if (params?.type) queryParams.append('type', params.type);
    if (params?.limit) queryParams.append('limit', params.limit.toString());
    if (params?.skip) queryParams.append('skip', params.skip.toString());
    
    const endpoint = `${ENDPOINTS.ORDERS.LIST}${queryParams.toString() ? '?' + queryParams.toString() : ''}`;
    const data = await request<any>(endpoint);
    
    return { 
      orders: data.orders || data || [], 
      pagination: data.pagination 
    };
  } catch (error) {
    console.error('Error loading orders:', error);
    return { orders: [] };
  }
};

export const acceptOrder = async (orderId: string): Promise<PaymentOrder> => {
  const data = await request<any>(ENDPOINTS.ORDERS.ACCEPT(orderId), {
    method: 'POST',
  });
  return data.order || data;
};

// FE 4.1 FIX: was sending {transactionProof}, backend reads {proof, utrNumber}
// -> payment proof always saved as empty string, UTR fraud detection bypassed
// confirmPayment works for BOTH:
//   DEPOSIT:    marks order COMPLETED (releases tokens to user after payment received)
//   WITHDRAWAL: marks order PAID (records that merchant sent money with UTR)
export const confirmPayment = async (orderId: string, proof?: string, utrNumber?: string): Promise<PaymentOrder> => {
  const data = await request<any>(ENDPOINTS.ORDERS.CONFIRM(orderId), {
    method: 'POST',
    body: JSON.stringify({ proof, utrNumber }),  // correct field names
  });
  return data.order || data;
};

export const rejectOrder = async (orderId: string, reason: string): Promise<PaymentOrder> => {
  const data = await request<any>(ENDPOINTS.ORDERS.REJECT(orderId), {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
  return data.order || data;
};

// =======================================================================
// DISPUTE
// =======================================================================

// Raise a dispute for an order.
export const raiseDispute = async (orderId: string, reason?: string): Promise<PaymentOrder> => {
  // Uses the new merchant dispute endpoint (Section 2C)
  const data = await request<any>(`/api/merchant/order/${orderId}/dispute`, {
    method: 'POST',
    body: JSON.stringify({ reason: reason || 'Merchant raised dispute' }),
  });
  return data.order || data;
};

// =======================================================================
// ORDER APPROVE / REJECT (Migration Patch Section 16.1 / 11.1 / 11.2)
// =======================================================================

/** approveOrder — POST /api/merchant/orders/:id/approve. Triggers 90/10 token allocation. */
export const approveOrder = async (orderId: string): Promise<any> => {
  const data = await request<any>(`/api/merchant/orders/${orderId}/approve`, { method: 'POST' });
  return data;
};

// =======================================================================


// Merchants review proofScreenshot (inline image) + utrNumber on order card.
// =======================================================================

// =======================================================================
// EARNINGS & STATS
// =======================================================================

export const getEarnings = async (params?: {
  startDate?: string;
  endDate?: string;
}): Promise<{ earnings: Earnings }> => {
  try {
    const queryParams = new URLSearchParams();
    if (params?.startDate) queryParams.append('startDate', params.startDate);
    if (params?.endDate) queryParams.append('endDate', params.endDate);
    
    const endpoint = `${ENDPOINTS.EARNINGS.GET}${queryParams.toString() ? '?' + queryParams.toString() : ''}`;
    const data = await request<any>(endpoint);
    
    // Backend returns structure: { earnings: { lifetime: {...}, today: {...} } }
    return {
      earnings: {
        today: data.earnings?.today?.deposits?.totalFees || 0,
        week: 0, // Calculate from lifetime if needed
        month: 0, // Calculate from lifetime if needed
        total: data.earnings?.lifetime?.totalEarnings || 0,
        lifetime: data.earnings?.lifetime,
        pending: data.earnings?.pending || 0,
      }
    };
  } catch (error) {
    console.error('Error loading earnings:', error);
    return {
      earnings: { today: 0, week: 0, month: 0, total: 0 }
    };
  }
};

export const getStats = async (): Promise<Stats> => {
  try {
    const data = await request<any>(ENDPOINTS.EARNINGS.STATS);
    
    // Backend returns: { stats: { pending, processing, completedToday } }
    return {
      pending: data.stats?.pending || 0,
      processing: data.stats?.processing || 0,
      completedToday: data.stats?.completedToday || 0,
      todayOrders: data.stats?.completedToday || 0,
      weekOrders: 0,
      monthOrders: 0,
      todayEarnings: 0,
      weekEarnings: 0,
      monthEarnings: 0,
      successRate: 0,
      averageOrderValue: 0,
    };
  } catch (error) {
    console.error('Error loading stats:', error);
    return {
      pending: 0,
      processing: 0,
      completedToday: 0,
    };
  }
};

// =======================================================================
// MERCHANT STATUS & PREFERENCES
// =======================================================================

export const toggleOnlineStatus = async (isOnline: boolean): Promise<MerchantProfile> => {
  const data = await request<any>(ENDPOINTS.AUTH.STATUS, {
    method: 'PUT',
    body: JSON.stringify({ isOnline }),
  });
  return data.merchant || data;
};

export const updatePreferences = async (preferences: {
  acceptsDeposits?: boolean;
  acceptsWithdrawals?: boolean;
}): Promise<MerchantProfile> => {
  const data = await request<any>(ENDPOINTS.AUTH.PREFERENCES, {
    method: 'PUT',
    body: JSON.stringify(preferences),
  });
  return data.merchant || data;
};

// =======================================================================
// PROFILE UPDATE (FIX M6)
// =======================================================================

export const updateProfile = async (data: {
  upiId?: string;
  qrCodeUrl?: string;
  bankDetails?: { accountHolderName?: string; bankName?: string; accountNo?: string; ifsc?: string };
}): Promise<any> => {
  const result = await request<any>(ENDPOINTS.PROFILE.UPDATE, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  return result.merchant || result;
};

// =======================================================================
// WEEKLY EARNINGS (FIX M4)
// =======================================================================

export const getWeeklyEarnings = async (): Promise<{ weekly: Array<{ date: string; earnings: number; orders: number }> }> => {
  const data = await request<any>(ENDPOINTS.EARNINGS.WEEKLY);
  return { weekly: data.weekly || [] };
};

// =======================================================================
// RED FLAG (FIX M5-c)
// =======================================================================

export const redFlagOrder = async (orderId: string, reason: string): Promise<any> => {
  const data = await request<any>(ENDPOINTS.ORDERS_EXTRA.RED_FLAG(orderId), {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
  return data.order || data;
};

// =======================================================================
// BULK PAYOUTS (FIX M7 / new BulkPayouts page)
// =======================================================================

export const getRates = async (): Promise<{ buyRate: number; sellRate: number; merchantProfitPerToken: number } | null> => {
  try {
    const data = await request<any>('/api/payment/rates');
    return data?.rates || null;
  } catch {
    return null;
  }
};

export const getBulkPayouts = async (date?: string): Promise<any> => {
  const qs = date ? `?date=${date}` : '';
  return request<any>(`${ENDPOINTS.BULK_PAYOUTS.LIST}${qs}`);
};

export const exportBulkPayouts = async (date?: string): Promise<any> => {
  const qs = date ? `?date=${date}` : '';
  return request<any>(`${ENDPOINTS.BULK_PAYOUTS.EXPORT}${qs}`);
};

export const markBulkPaid = async (orderIds: string[], batchRef?: string): Promise<any> => {
  return request<any>(ENDPOINTS.BULK_PAYOUTS.MARK_PAID, {
    method: 'POST',
    body: JSON.stringify({ orderIds, batchRef }),
  });
};

// =======================================================================
// UTILITIES
// =======================================================================

export const formatCurrency = (amount: number, currency = 'Rs.'): string => {
  if (typeof amount !== 'number') {
    amount = parseFloat(String(amount)) || 0;
  }
  return `${currency}${amount.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
};

export const formatDate = (dateString: string | number): string => {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  return date.toLocaleString('en-IN');
};

export const formatDateShort = (dateString: string | number): string => {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-IN');
};

export const formatTime = (dateString: string | number): string => {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
};

export const getTimeAgo = (dateString: string | number): string => {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return formatDateShort(dateString);
};

// =======================================================================
// EXPORT ALL API FUNCTIONS
// =======================================================================

export const api = {
  // Auth
  isAuthenticated,
  getCurrentMerchant,
  merchantLogin,
  merchantSignup,
  logout,
  getMerchantProfile,
  
  // Orders
  getOrders,
  acceptOrder,
  confirmPayment,
  rejectOrder,
  
  
  // Dispute
  raiseDispute,
  
  // Stats
  getEarnings,
  getWeeklyEarnings,
  getStats,
  getRates,
  
  // Status
  toggleOnlineStatus,
  updatePreferences,
  updateProfile,

  // Red Flag
  redFlagOrder,

  // Bulk payouts
  getBulkPayouts,
  exportBulkPayouts,
  markBulkPaid,
  
  // Utilities
  formatCurrency,
  formatDate,
  formatDateShort,
  formatTime,
  getTimeAgo,
  
  // Direct request function for custom calls
  request,
};

export default api;
