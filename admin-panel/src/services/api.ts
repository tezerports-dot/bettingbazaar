// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import axios, { AxiosInstance, AxiosError } from 'axios';
import type {
  Admin,
  User,
  Cycle,
  TokenRates,
  Merchant,
  MerchantProfile,
  PaymentOrder,
  Transaction,
  Branding,
  DashboardStats,
  CDNImage,
  FAQ,
  SupportLinks,
} from '../types';

const _adminViteUrl = import.meta.env.VITE_API_URL as string | undefined;
const _adminIsLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
if (!_adminViteUrl && !_adminIsLocal) {
  throw new Error('[FATAL] VITE_API_URL not set in Railway admin-panel service. Set it to the backend URL.');
}
const API_URL = _adminViteUrl?.replace(/\/$/, '') || 'http://localhost:8080';

const api: AxiosInstance = axios.create({
  baseURL: API_URL,
  timeout: 30000,
  withCredentials: false,  // Using JWT Bearer tokens -- cookies are not used
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use(
  (config) => {
    let token: string | null = null;
    try {
      const stored = localStorage.getItem('admin-auth');
      if (stored) {
        const parsed = JSON.parse(stored);
        token = parsed?.state?.token ?? null;
      }
    } catch {
      token = null;
    }
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  },
  (error) => Promise.reject(error)
);

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('admin-auth');
      window.location.href = '/#/login';
    }
    return Promise.reject(error);
  }
);

// --- AUTH ---------------------------------------------------------------------

export const auth = {
  /**
   * loginType:
   *   'admin'         -- full admin
   *   'subadmin'      -- sub-admin (permissions from subAdminPermissions on User doc)
   *   'queue_manager' -- queue manager (sees only queue dashboard)
   */
  login: async (
    mobile: string,
    password: string,
    loginType: 'admin' | 'subadmin' | 'queue_manager' = 'admin'
  ) => {
    const res = await api.post<any>('/api/admin/login', { mobile, password, loginType }); // MED-02: use /api/admin/login for adminAuthLimiter
    if (res.data?.success && res.data?.token) {
      return { success: true, data: { token: res.data.token, admin: res.data.user } };
    }
    return res.data;
  },

  logout: async () => {
    try {
      await api.post('/api/v1/auth/logout');
    } catch {}
  },

  verifySession: async () => {
    const res = await api.get<any>('/api/v1/auth/me');
    if (res.data?.success && res.data?.user) {
      return { success: true, data: { admin: res.data.user } };
    }
    return res.data;
  },
};

// --- ANALYTICS ---------------------------------------------------------------

export const analytics = {
  getDashboard: async () => {
    const res = await api.get<any>('/api/admin/analytics/dashboard');
    if (res.data?.success && res.data?.metrics) {
      return { success: true, data: res.data.metrics };
    }
    return res.data;
  },

  getFinancials: async (startDate?: string, endDate?: string) => {
    const res = await api.get<any>('/api/admin/analytics/financials', {
      params: { startDate, endDate },
    });
    return res.data;
  },
};

// --- USERS --------------------------------------------------------------------

export const users = {
  getAll: async (page = 1, limit = 50, search?: string, status?: string) => {
    const res = await api.get<any>('/api/admin/users', { params: { page, limit, search, status } });
    if (res.data?.success && res.data?.users) {
      return { success: true, data: res.data.users, pagination: res.data.pagination };
    }
    return res.data;
  },

  getById: async (userId: string) => {
    const res = await api.get<any>(`/api/admin/users/${userId}`);
    if (res.data?.success && res.data?.user) {
      return { success: true, data: res.data.user };
    }
    return res.data;
  },

  updateRoles: async (userId: string, roles: string[]) => {
    const res = await api.put(`/api/admin/users/${userId}/roles`, { roles });
    return res.data;
  },

  adjustBalance: async (userId: string, amount: number, reason: string, walletType: 'depositBalance' | 'winningsBalance' = 'depositBalance') => {
    // FIX 10: walletType is now a proper param sent to backend (was stuffed into reason string)
    const res = await api.post(`/api/admin/users/${userId}/adjust-balance`, { amount, reason, walletType });
    return res.data;
  },

  blockUser: async (userId: string, reason: string) => {
    const res = await api.put(`/api/admin/users/${userId}/block`, { reason });
    return res.data;
  },

  unblockUser: async (userId: string) => {
    const res = await api.put(`/api/admin/users/${userId}/unblock`);
    return res.data;
  },

  deleteUser: async (userId: string) => {
    const res = await api.delete(`/api/admin/users/${userId}`);
    return res.data;
  },

  getTransactions: async (userId: string) => {
    const res = await api.get<any>(`/api/admin/users/${userId}/transactions`);
    if (res.data?.success && res.data?.transactions) {
      return { success: true, data: res.data.transactions };
    }
    return res.data;
  },
};

// --- MERCHANTS ----------------------------------------------------------------

export const merchants = {
  getAll: async (page = 1, limit = 50, status?: string) => {
    const res = await api.get<any>('/api/admin/merchants', { params: { page, limit, status } });
    if (res.data?.success && res.data?.merchants) {
      return { success: true, data: res.data.merchants, pagination: res.data.pagination };
    }
    return res.data;
  },

  getProfile: async (merchantId: string) => { // returns { ..merchant, merchantLimits } flattened // returns { ..merchant, merchantLimits } flattened
    const res = await api.get<any>(`/api/admin/merchants/${merchantId}/profile`);
    if (res.data?.success && res.data?.merchant) {
      return { success: true, data: res.data.merchant };
    }
    return res.data;
  },

  suspend: async (merchantId: string, reason: string) => {
    const res = await api.put(`/api/admin/merchants/${merchantId}/suspend`, { reason });
    return res.data;
  },

  activate: async (merchantId: string) => {
    const res = await api.put(`/api/admin/merchants/${merchantId}/activate`);
    return res.data;
  },

  updateLimits: async (merchantId: string, limits: any) => {
    const res = await api.put(`/api/admin/merchants/${merchantId}/limits`, limits);
    return res.data;
  },

  // setCommission removed — commission model superseded by buy/sell spread.
  // MerchantsList.tsx comment: 'commission handler removed — merchants earn via spread.'
  getEarnings: async (merchantId: string) => {
    const res = await api.get<any>(`/api/admin/merchants/${merchantId}/earnings`);
    return res.data;
  },
  setPanelUrl: async (merchantId: string, panelUrl: string) => {
    const res = await api.put(`/api/admin/merchants/${merchantId}/panel-url`, { panelUrl });
    return res.data;
  },
  // FIX 8: Top up merchant token wallet (backend: POST /merchants/:id/fund)
  fundWallet: async (merchantId: string, tokenAmount: number, note?: string) => {
    const res = await api.post(`/api/admin/merchants/${merchantId}/fund`, { tokenAmount, note });
    return res.data;
  },

  create: async (data: { username: string; mobile: string; password: string; email?: string }) => {
    const res = await api.post('/api/admin/merchants/create', data);
    return res.data;
  },

  approve: async (merchantId: string) => {
    const res = await api.put(`/api/admin/merchants/${merchantId}/approve`);
    return res.data;
  },

  // FIX A3: Reject route -- backend PUT /merchants/:id/reject added in Batch 1
  reject: async (merchantId: string, reason: string) => {
    const res = await api.put(`/api/admin/merchants/${merchantId}/reject`, { reason });
    return res.data;
  },

  getOrders: async (merchantId: string) => {
    const res = await api.get<any>(`/api/admin/merchants/${merchantId}/orders`);
    if (res.data?.success && res.data?.orders) {
      return { success: true, data: res.data.orders };
    }
    return res.data;
  },
};

// --- CYCLES ------------------------------------------------------------------

export const cycles = {
  getActive: async () => {
    const res = await api.get<any>('/api/cycles/active');
    if (res.data?.success && res.data?.cycles) {
      return { success: true, data: res.data.cycles };
    }
    return res.data;
  },

  getHistory: async (page = 1, limit = 50, type?: string) => {
    const res = await api.get<any>('/api/admin/cycles/history', { params: { page, limit, type } });
    // Backend returns { success, cycles, pagination }
    if (res.data?.success && res.data?.cycles) {
      return { success: true, data: res.data.cycles, pagination: res.data.pagination };
    }
    return res.data;
  },

  triggerEqualizer: async (cycleId: string) => {
    const res = await api.post(`/api/admin/cycles/${cycleId}/equalize`);
    return res.data;
  },

  pauseCycle: async (cycleId: string) => {
    const res = await api.post('/api/admin/manage-cycle', { action: 'PAUSE', cycleId });
    return res.data;
  },

  resumeCycle: async (cycleId: string) => {
    const res = await api.post('/api/admin/manage-cycle', { action: 'RESUME', cycleId });
    return res.data;
  },

  cancelCycle: async (cycleId: string, reason: string) => {
    const res = await api.post('/api/admin/manage-cycle', {
      action: 'CANCEL',
      cycleId,
      payload: { reason },
    });
    return res.data;
  },
};

// --- TOKEN RATES --------------------------------------------------------------

export const tokenRates = {
  getCurrent: async () => {
    const res = await api.get<any>('/api/admin/token-rates');
    return res.data;
  },

  update: async (buyRate: number, sellRate: number) => {
    const res = await api.put('/api/admin/token-rates', { buyRate, sellRate });
    return res.data;
  },
};

// --- QUEUE MANAGER ------------------------------------------------------------

export const queueManager = {
  getPendingOrders: async () => {
    const res = await api.get<any>('/api/admin/queue/pending-orders');
    if (res.data?.success && res.data?.orders) {
      return { success: true, data: res.data.orders };
    }
    return res.data;
  },

  assignOrder: async (orderId: string, merchantId: string) => {
    const res = await api.post(`/api/admin/queue/assign/${orderId}`, { merchantId });
    return res.data;
  },

  getAvailableMerchants: async (type: 'DEPOSIT' | 'WITHDRAWAL') => {
    const res = await api.get<any>('/api/admin/queue/available-merchants', { params: { type } });
    if (res.data?.success && res.data?.merchants) {
      return { success: true, data: res.data.merchants, isPoolConfigured: res.data.isPoolConfigured };
    }
    return res.data;
  },

  // Merchant pool: the 3-5 curated merchants manual/forced assignment draws
  // from, instead of searching every ACTIVE merchant. Configured by admin or
  // queue_manager. See backend/routes/admin/queue.admin.routes.js.
  getMerchantPool: async () => {
    const res = await api.get<any>('/api/admin/queue/merchant-pool');
    return res.data;
  },

  setMerchantPool: async (merchantIds: string[]) => {
    const res = await api.put('/api/admin/queue/merchant-pool', { merchantIds });
    return res.data;
  },

  getEligibleMerchants: async () => {
    const res = await api.get<any>('/api/admin/queue/eligible-merchants');
    return res.data;
  },

  
  getGroupedQueue: async (status?: string) => {
    // FIX: p2p-queue route no longer exists post P2P->Merchant migration; use payment-queue (same response shape)
    const res = await api.get<any>('/api/admin/payment-queue', { params: status ? { status } : {} });
    return res.data;
  },

  
  reassignOrder: async (orderId: string, merchantId: string) => {
    // FIX: p2p-queue route no longer exists; use payment-orders/:id/reassign (correct status guard for already-assigned orders)
    const res = await api.post(`/api/admin/payment-orders/${orderId}/reassign`, { merchantId });
    return res.data;
  },
};

// --- KYC ---------------------------------------------------------------------

export const kyc = {
  getQueue: async () => {
    const res = await api.get<any>('/api/admin/kyc/queue');
    if (res.data?.success && res.data?.queue) {
      return { success: true, data: res.data.queue };
    }
    return res.data;
  },

  approve: async (userId: string) => {
    const res = await api.post(`/api/admin/kyc/${userId}/approve`);
    return res.data;
  },

  reject: async (userId: string, reason: string) => {
    const res = await api.post(`/api/admin/kyc/${userId}/reject`, { reason });
    return res.data;
  },
};

// --- SUB ADMINS ---------------------------------------------------------------

export const subAdmins = {
  getAll: async () => {
    const res = await api.get<any>('/api/admin/sub-admins');
    if (res.data?.success && res.data?.subAdmins) {
      return { success: true, data: res.data.subAdmins };
    }
    return res.data;
  },

  create: async (data: {
    username: string;
    mobile: string;
    password: string;
    permissions?: any;
  }) => {
    const res = await api.post('/api/admin/sub-admins', data);
    return res.data;
  },

  updatePermissions: async (subAdminId: string, permissions: any) => {
    const res = await api.put(`/api/admin/sub-admins/${subAdminId}/permissions`, permissions);
    return res.data;
  },

  delete: async (subAdminId: string) => {
    const res = await api.delete(`/api/admin/sub-admins/${subAdminId}`);
    return res.data;
  },

  assignPhantomAccess: async (
    userId: string,
    access: 'NONE' | '30_MIN' | 'FULL_DAY' | 'BOTH'
  ) => {
    // Backend expects { accessLevel }
    const res = await api.post(`/api/admin/users/${userId}/phantom-access`, {
      accessLevel: access,
    });
    return res.data;
  },
};

// --- FINANCE ------------------------------------------------------------------

export const finance = {
  getTransactions: async (page = 1, limit = 50, type?: string, status?: string, startDate?: string, endDate?: string) => {
    const res = await api.get<any>('/api/admin/transactions', {
      params: { page, limit, type, status, startDate, endDate },
    });
    if (res.data?.success && res.data?.transactions) {
      return { success: true, data: res.data.transactions, pagination: res.data.pagination };
    }
    return res.data;
  },
};

// --- BRANDING -----------------------------------------------------------------

export const branding = {
  getCurrent: async () => {
    const res = await api.get<any>('/api/admin/branding');
    if (res.data?.success && res.data?.branding !== undefined) {
      return { success: true, data: res.data.branding };
    }
    return res.data;
  },

  update: async (data: Partial<Branding>) => {
    const res = await api.put('/api/admin/branding', data);
    return res.data;
  },

  uploadLogo: async (file: File) => {
    // Step 1: Get presigned URL from backend
    const urlRes = await api.post<any>('/api/admin/branding/upload-url', {
      fileName: file.name,
      contentType: file.type,
      fileSize: file.size,
      category: 'logo',
    });
    if (!urlRes.data?.success) throw new Error('Failed to get upload URL');
    const { uploadUrl, cdnUrl, key } = urlRes.data;

    // Step 2: Upload directly to S3 via presigned URL
    await fetch(uploadUrl, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': file.type },
    });

    // FE 4.2 FIX: was sending key+fileName, backend requires fileKey+title -> always 400 -> logo upload fails
    const confirmRes = await api.post<any>('/api/admin/branding/confirm-upload', {
      fileKey: key,         // renamed from key
      cdnUrl,
      category: 'logo',
      title: file.name,     // renamed from fileName
      fileSize: file.size,
    });
    return confirmRes.data;
  },
};

// --- CDN ----------------------------------------------------------------------
// AUDIT FIX: cdn.uploadImage previously sent multipart/form-data to
// POST /api/admin/branding/images, but that backend route expects JSON
// { url, category, title } — it has no multer middleware and cannot parse
// multipart bodies.  Result: req.body was always empty → url undefined → 400.
//
// Unified to the same 3-step S3 presigned-URL flow used by branding.uploadLogo:
//   1. POST /branding/upload-url  → get { uploadUrl, cdnUrl, key } from backend
//   2. PUT file → S3 via presigned uploadUrl
//   3. POST /branding/images      → register cdnUrl in CDNImage model (JSON)

export const cdn = {
  getImages: async (category?: string) => {
    const res = await api.get<any>('/api/admin/branding/images', { params: { category } });
    if (res.data?.success && res.data?.images) {
      return { success: true, data: res.data.images };
    }
    return res.data;
  },

  /**
   * Upload an image file to S3 via presigned URL, then register it in the
   * CDNImage library.  All three steps share the same CDNImage model so
   * images appear consistently in both CDNManager and BrandingSettings.
   */
  uploadImage: async (file: File, category: string, title: string, description?: string) => {
    // Step 1: Get S3 presigned upload URL from backend
    const urlRes = await api.post<any>('/api/admin/branding/upload-url', {
      fileName:    file.name,
      contentType: file.type,
      fileSize:    file.size,
      category,
    });
    if (!urlRes.data?.success) throw new Error(urlRes.data?.message || 'Failed to get upload URL');
    const { uploadUrl, cdnUrl, key } = urlRes.data;

    // Step 2: Upload directly to S3 (no backend bandwidth used)
    const s3Res = await fetch(uploadUrl, {
      method:  'PUT',
      body:    file,
      headers: { 'Content-Type': file.type },
    });
    if (!s3Res.ok) throw new Error(`S3 upload failed: ${s3Res.status}`);

    // Step 3: Register the CDN URL in the CDNImage model (JSON body)
    const confirmRes = await api.post<any>('/api/admin/branding/images', {
      url:         cdnUrl,
      fileKey:     key,
      category,
      title,
      description: description || '',
    });
    return confirmRes.data;
  },

  deleteImage: async (imageId: string) => {
    const res = await api.delete(`/api/admin/branding/images/${imageId}`);
    return res.data;
  },

  addUrl: async (data: { url: string; title: string; category: string; description?: string; tags?: string[] }) => {
    // Register an external URL directly (no file upload needed)
    const res = await api.post('/api/admin/branding/cdn-url', data);
    return res.data;
  },
};

// --- CONTENT ------------------------------------------------------------------

export const content = {
  getAllFAQs: async () => {
    const res = await api.get<any>('/api/admin/content/faq');
    if (res.data?.success && res.data?.faqs) {
      return { success: true, data: res.data.faqs };
    }
    return res.data;
  },

  createFAQ: async (data: Partial<FAQ>) => {
    const res = await api.post('/api/admin/content/faq', data);
    return res.data;
  },

  updateFAQ: async (faqId: string, data: Partial<FAQ>) => {
    const res = await api.put(`/api/admin/content/faq/${faqId}`, data);
    return res.data;
  },

  deleteFAQ: async (faqId: string) => {
    const res = await api.delete(`/api/admin/content/faq/${faqId}`);
    return res.data;
  },

  getSupportLinks: async () => {
    const res = await api.get<any>('/api/admin/content/support-links');
    if (res.data?.success && res.data?.supportLinks) {
      return { success: true, data: res.data.supportLinks };
    }
    return res.data;
  },

  updateSupportLinks: async (data: Partial<SupportLinks>) => {
    const res = await api.put('/api/admin/content/support-links', data);
    return res.data;
  },
};

// --- SYSTEM -------------------------------------------------------------------

export const system = {
  getConfig: async () => {
    const res = await api.get<any>('/api/admin/system/config');
    if (res.data?.success && res.data?.config) {
      return { success: true, data: res.data.config };
    }
    return res.data;
  },

  updateConfig: async (config: any) => {
    const res = await api.put('/api/admin/system/config', config);
    return res.data;
  },

  toggleMaintenance: async (enabled: boolean, message?: string) => {
    const res = await api.put('/api/admin/system/config', {
      maintenanceMode: enabled,
      maintenanceMessage: message || '',
    });
    return res.data;
  },

  getAuditLogs: async (page = 1, limit = 50) => {
    const res = await api.get<any>('/api/admin/audit-logs', { params: { page, limit } });
    if (res.data?.success && res.data?.logs) {
      return { success: true, data: res.data.logs, pagination: res.data.pagination };
    }
    return res.data;
  },
};


// ─── DISPUTES ──────────────────────────────────────────────────────────────
export const disputes = {
  getAll: async (status?: string) => {
    const res = await api.get<any>('/api/admin/disputes', { params: { status } });
    return res.data;
  },
  getOne: async (id: string) => {
    const res = await api.get<any>(`/api/admin/disputes/${id}`);
    return res.data;
  },
  resolve: async (id: string, data: { decision: string; resolution: string; refundAmount?: number; penaltyAmount?: number }) => {
    const res = await api.post(`/api/admin/disputes/${id}/resolve`, data);
    return res.data;
  },
  escalate: async (id: string, notes: string) => {
    const res = await api.post(`/api/admin/disputes/${id}/escalate`, { notes });
    return res.data;
  },
};

// ─── UTR MONITOR ───────────────────────────────────────────────────────────
export const utr = {
  getFlagged: async (type?: string, page = 1) => {
    const res = await api.get<any>('/api/admin/utr/flagged', { params: { type, page } });
    return res.data;
  },
  getStats: async () => {
    const res = await api.get<any>('/api/admin/utr/stats');
    return res.data;
  },
  resolve: async (orderId: string, resolution?: string) => {
    const res = await api.post(`/api/admin/utr/resolve/${orderId}`, { resolution });
    return res.data;
  },
  getUserHistory: async (userId: string) => {
    const res = await api.get<any>(`/api/admin/utr/user-history/${userId}`);
    return res.data;
  },
};

// ─── PHANTOM AGENTS ────────────────────────────────────────────────────────
export const phantomAgents = {
  getAll: async () => {
    const res = await api.get<any>('/api/admin/phantom-agents');
    return res.data;
  },
  setAccess: async (userId: string, accessLevel: 'NONE' | '30_MIN' | 'FULL_DAY' | 'BOTH') => {
    const res = await api.post(`/api/admin/users/${userId}/phantom-access`, { accessLevel });
    return res.data;
  },
};

// --- ERROR REPORTS --------------------------------------------------------

export const errorReports = {
  getAll: async () => {
    const res = await api.get<any>('/api/admin/error-reports');
    if (res.data?.success && res.data?.reports) {
      return { success: true, data: res.data.reports as Array<{
        _id: string; message: string; stack?: string; component?: string;
        url?: string; panel: string; ts: string;
      }>};
    }
    return res.data;
  },
  clearAll: async () => {
    const res = await api.delete<any>('/api/admin/error-reports');
    return res.data;
  },
};

// --- APP ASSETS ---------------------------------------------------------------

export const appAssets = {
  getAll: async () => {
    const res = await api.get<any>('/api/admin/app-assets');
    return res.data;
  },
  upload: async (slot: string, file: File): Promise<{ success: boolean; url?: string; message?: string }> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const res = await api.post<any>('/api/admin/app-assets/upload', { slot, data: reader.result as string });
          resolve(res.data);
        } catch (e: any) {
          resolve({ success: false, message: e?.response?.data?.message || 'Upload failed' });
        }
      };
      reader.onerror = () => resolve({ success: false, message: 'Failed to read file' });
      reader.readAsDataURL(file);
    });
  },
  delete: async (name: string) => {
    const res = await api.delete<any>(`/api/admin/app-assets/${name}`);
    return res.data;
  },
};

  // ── Payment Order Actions (approve / reject / force-complete / video-KYC) ──────

// Payment Order Actions — approve / reject / cancel / video-KYC
// FIX: was orphaned label-statement; esbuild rejected TS type annotations in label blocks
export const orderActions = {
  approve: async (orderId: string, reason: string) => {
      const res = await api.post(`/api/admin/p2p-orders/${orderId}/action`, { action: 'APPROVE', reason });
      return res.data;
    },
    reject: async (orderId: string, reason: string) => {
      const res = await api.post(`/api/admin/p2p-orders/${orderId}/action`, { action: 'REJECT', reason });
      return res.data;
    },
    cancel: async (orderId: string, reason: string) => {
      const res = await api.post(`/api/admin/p2p-orders/${orderId}/action`, { action: 'CANCEL', reason });
      return res.data;
    },
    requireVideoKYC: async (orderId: string) => {
      const res = await api.post(`/api/admin/p2p-orders/${orderId}/video-kyc`);
      return res.data;
    },
};

export default {
  auth,
  analytics,
  users,
  merchants,
  cycles,
  tokenRates,
  queueManager,
  kyc,
  subAdmins,
  finance,
  branding,
  cdn,
  content,
  system,
  disputes,
  utr,
  phantomAgents,
  errorReports,
  appAssets,
  orderActions,
  get: <T = any>(url: string, config?: any) => api.get<T>(url, config),
  post: <T = any>(url: string, data?: any, config?: any) => api.post<T>(url, data, config),
  put: <T = any>(url: string, data?: any, config?: any) => api.put<T>(url, data, config),
  delete: <T = any>(url: string, config?: any) => api.delete<T>(url, config),
};


