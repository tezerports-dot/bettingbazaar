// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import {
  MerchantProfile,
  PaymentOrder,
  AuthResponse,
  Earnings,
  Stats,
  PaymentModeView,
  CashLinkState,
  CashLink,
  OutstandingCdmReceipt,
} from '../types';
import { ENDPOINTS, ERROR_MESSAGES } from '../constants';

// URL resolution. On a SPLIT-ORIGIN deploy the merchant panel is served from a
// different host than the backend, so window.location.origin is the panel's host,
// not the API — every call would 404. Set VITE_API_URL (at build time) to the
// backend URL for that case. On the default single-origin launch (NGINX serves
// the panel and proxies /api to the backend) the origin fallback is correct and
// no env var is needed.
const getAPIBaseURL = (): string => {
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return (import.meta.env.VITE_API_URL as string) || 'http://localhost:8080';
  }
  // Split-origin: set VITE_API_URL to the backend URL. Same-origin: fall back to
  // the current origin (NGINX proxies /api).
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
      // The status and the body travel WITH the error. This threw a bare
      // `Error(message)`, so everything the server said beyond one sentence was
      // discarded at the boundary — a caller could not tell a 429 from a 400,
      // and structured fields like `retryAfter` / `retryAt` were unreachable no
      // matter how carefully the server sent them.
      const err = new Error(data?.message || `Request failed with status ${response.status}`) as
        Error & { status?: number; data?: unknown };
      err.status = response.status;
      err.data = data;
      throw err;
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
    
    // 2FA: a 200 with success:false and a challenge. NOT an error — the
    // password was accepted; the login is half done. Store nothing: the
    // challenge is not a session and must never reach the Authorization
    // header, so it is returned to the caller and held in memory only.
    if (data.twoFactorRequired && data.challengeToken) {
      return data;
    }

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

/** Second leg of the merchant login: exchange the challenge for a session. */
export const merchantLoginTwoFactor = async (challengeToken: string, code: string): Promise<AuthResponse> => {
  const data = await request<AuthResponse>(ENDPOINTS.AUTH.LOGIN_2FA, {
    method: 'POST',
    body: JSON.stringify({ challengeToken, code }),
  });
  if (data.token) localStorage.setItem('merchantToken', data.token);
  const merchant = data.user || data.merchant;
  if (merchant) setMerchantData(merchant);
  return data;
};

// --- 2FA enrolment (merchants are a separate model from users) ---------------
export const twoFactorStatus = async () =>
  request<{ success: boolean; enabled: boolean; mandatory: boolean; backupCodesRemaining: number }>(
    ENDPOINTS.AUTH.TWO_FA_STATUS, { method: 'GET' });

export const twoFactorSetup = async () =>
  request<{ success: boolean; secret: string; otpauthUri: string; message?: string }>(
    ENDPOINTS.AUTH.TWO_FA_SETUP, { method: 'POST', body: JSON.stringify({}) });

export const twoFactorActivate = async (code: string) =>
  request<{ success: boolean; backupCodes: string[]; message?: string }>(
    ENDPOINTS.AUTH.TWO_FA_ACTIVATE, { method: 'POST', body: JSON.stringify({ code }) });

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

/**
 * Which settlement rail this merchant is on, and the windows they are held to.
 *
 * Read on panel load. The rail can change under a merchant mid-shift, and the
 * notification and the SSE push are both best-effort — a merchant with no
 * linked player account has no inbox, and a dropped socket misses the
 * broadcast. This read is the one that is always correct.
 */
export const getPaymentMode = async (): Promise<PaymentModeView> => {
  const data = await request<any>(ENDPOINTS.AUTH.PAYMENT_MODE);
  return {
    activeMode: data.activeMode ?? null,
    version: data.version ?? null,
    label: data.label ?? '',
    merchantMessage: data.merchantMessage ?? '',
    timers: data.timers ?? null,
  };
};

/**
 * The ATM cash rail: what this merchant is holding, and whether a trip is
 * worth making.
 *
 * `worthGoing` is computed by the SERVER using the same function that decides
 * who the demand broadcast reaches. Deciding it here from `waiting > 0` would
 * put a different answer on the screen than in the notification, and an
 * expired link earns a merchant nothing — so a wrong "yes" costs them a
 * journey.
 */
export const getCashLinkState = async (): Promise<CashLinkState> => {
  const data = await request<any>(ENDPOINTS.CASH_LINKS.CURRENT);
  return {
    approved: Boolean(data.approved),
    denomination: data.denomination ?? null,
    live: data.live ?? null,
    waiting: data.waiting ?? 0,
    worthGoing: Boolean(data.worthGoing),
  };
};

/** Supply the link the ATM just produced. Amount and lifetime are the server's. */
export const supplyCashLink = async (paymentLink: string): Promise<CashLink> => {
  const data = await request<any>(ENDPOINTS.CASH_LINKS.SUPPLY, {
    method: 'POST',
    body: JSON.stringify({ paymentLink }),
  });
  return data.link;
};

/** Withdraw a link this merchant can no longer honour. */
export const cancelCashLink = async (linkId: string): Promise<void> => {
  await request<any>(`${ENDPOINTS.CASH_LINKS.SUPPLY}/${encodeURIComponent(linkId)}`, {
    method: 'DELETE',
  });
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

/**
 * Reject an order the player says they paid, because the money never arrived.
 *
 * Different from `rejectOrder` above, which declines an order BEFORE payment
 * and returns it to the queue. This one cancels the order, adds a warning to
 * the player's account and can auto-block them — so the backend requires a
 * reason of at least ten characters and a proof image, and refuses without
 * either.
 *
 * Three steps, in this order: ask for a presigned URL (which also checks the
 * order is this merchant's and is actually awaiting confirmation), PUT the
 * file, then send the reference. The proof is verified server-side against
 * THIS merchant and THIS order before it is stored, so a key from somewhere
 * else is refused.
 */
export const rejectPaidOrder = async (
  orderId: string, reason: string, proof: File,
): Promise<PaymentOrder> => {
  const presigned = await request<any>(ENDPOINTS.ORDERS.REJECT_PROOF_UPLOAD_URL(orderId), {
    method: 'POST',
    body: JSON.stringify({ fileName: proof.name, contentType: proof.type, fileSize: proof.size }),
  });
  if (!presigned?.uploadUrl || !presigned?.fileKey) {
    throw new Error('Could not prepare the proof upload');
  }

  const put = await fetch(presigned.uploadUrl, {
    method: 'PUT', body: proof, headers: { 'Content-Type': proof.type },
  });
  if (!put.ok) throw new Error('The proof image failed to upload');

  const data = await request<any>(ENDPOINTS.ORDERS.REJECT_PAID(orderId), {
    method: 'POST',
    body: JSON.stringify({
      reason, proofFileKey: presigned.fileKey, proofCdnUrl: presigned.cdnUrl,
    }),
  });
  return data.order || data;
};

/**
 * Submit the CDM receipt for a cash payout.
 *
 * ── Read this before changing anything here ────────────────────────────────
 * Once submitted the merchant CANNOT SEE IT AGAIN. Only an admin or a disputes
 * manager can. So the upload step is the last point at which they can check
 * what they are sending, and the caller must let them replace the file freely
 * up to the moment they press submit.
 *
 * Three steps, in this order, mirroring the reject proof: ask for a presigned
 * URL (which also checks the order is this merchant's and is a payout), PUT the
 * file, then send the reference. The receipt is verified server-side against
 * THIS merchant and THIS order before it is stored, so a key staged elsewhere
 * is refused.
 *
 * Returns what the server accepted — the transaction id and the time — because
 * that confirmation is the only look the merchant gets.
 */
export const submitCdmReceipt = async (
  orderId: string, transactionId: string, receipt: File,
): Promise<{ transactionId: string; submittedAt: string }> => {
  const presigned = await request<any>(ENDPOINTS.CDM_RECEIPT.UPLOAD_URL(orderId), {
    method: 'POST',
    body: JSON.stringify({ fileName: receipt.name, contentType: receipt.type, fileSize: receipt.size }),
  });
  if (!presigned?.uploadUrl || !presigned?.fileKey) {
    throw new Error('Could not prepare the receipt upload');
  }

  const put = await fetch(presigned.uploadUrl, {
    method: 'PUT', body: receipt, headers: { 'Content-Type': receipt.type },
  });
  if (!put.ok) throw new Error('The receipt image failed to upload');

  const data = await request<any>(ENDPOINTS.CDM_RECEIPT.SUBMIT(orderId), {
    method: 'POST',
    body: JSON.stringify({
      transactionId, receiptFileKey: presigned.fileKey, receiptCdnUrl: presigned.cdnUrl,
    }),
  });
  return data.submitted;
};

/**
 * The payouts this merchant still owes a slip for.
 *
 * An empty list is the normal state and means nothing is outstanding. It does
 * NOT mean "no receipts exist" — a submitted one is invisible to the merchant
 * who submitted it, so a row leaving this list is the only confirmation they
 * ever get that theirs landed.
 */
export const getOutstandingCdmReceipts = async (): Promise<OutstandingCdmReceipt[]> => {
  const data = await request<any>(ENDPOINTS.CDM_RECEIPT.OUTSTANDING);
  return data.outstanding || [];
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

// The backend enforces rail exclusivity on this endpoint: an INR merchant may
// send upiId/qrCodeUrl/bankDetails, a USDT merchant may send only
// usdtWalletAddress. Sending a field for the wrong rail is a 400, not a silent
// no-op (backend/domains/merchant/merchant.routes.js PUT /profile).
export const updateProfile = async (data: {
  upiId?: string;
  qrCodeUrl?: string;
  bankDetails?: { accountHolderName?: string; bankName?: string; accountNo?: string; ifsc?: string };
  usdtWalletAddress?: string;
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




export const formatTime = (dateString: string | number): string => {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
};


// =======================================================================
// EXPORT ALL API FUNCTIONS
// =======================================================================

export const api = {
  // Auth
  isAuthenticated,
  getCurrentMerchant,
  merchantLogin,
  merchantLoginTwoFactor,
  twoFactorStatus,
  twoFactorSetup,
  twoFactorActivate,
  merchantSignup,
  logout,
  getMerchantProfile,
  
  // Orders
  getOrders,
  acceptOrder,
  confirmPayment,
  rejectOrder,
  rejectPaidOrder,
  
  
  // Dispute
  raiseDispute,
  
  // Stats
  getEarnings,
  getWeeklyEarnings,
  getStats,

  // Status
  toggleOnlineStatus,
  updatePreferences,
  updateProfile,

  // Red Flag
  // Utilities
  formatTime,
  // Direct request function for custom calls
  request,
};

export default api;
