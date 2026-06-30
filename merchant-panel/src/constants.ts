/**
 * BB TOKEN MERCHANT PANEL - CONSTANTS & CONFIGURATION (FIXED)
 *
 * FIX: Production URL was falling back to window.location.origin
 * which is the merchant panel's own Caddy domain, not the backend.
 * Now uses VITE_API_URL env var which is set in Railway to the backend URL.
 */

// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
const getAPIBaseURL = (): string => {
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return import.meta.env.VITE_API_URL || 'http://localhost:8080';
  }
  // Production: use VITE_API_URL env var (set in Railway to backend URL)
  // Fallback to empty string at build time; the runtime guard in sse.ts catches missing env at runtime
  return (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';
};

export const API_BASE_URL = getAPIBaseURL();

export const ENDPOINTS = {
  AUTH: {
    // FIX 2: Point to merchant-specific endpoints that enforce merchant status checks
    LOGIN: '/api/merchant/auth/login',
    SIGNUP: '/api/merchant/auth/signup',
    PROFILE: '/api/merchant/profile',
    STATUS: '/api/merchant/online-status',
    PREFERENCES: '/api/merchant/preferences',
  },
  ORDERS: {
    LIST: '/api/merchant/orders',
    ACCEPT: (id: string) => `/api/merchant/accept/${id}`,
    CONFIRM: (id: string) => `/api/merchant/confirm/${id}`,
    REJECT: (id: string) => `/api/merchant/reject/${id}`,
    CHAT: (id: string) => `/api/merchant/chat/${id}`,
    GET_CHAT: (id: string) => `/api/merchant/chat/${id}`,
  },
  EARNINGS: {
    GET:    '/api/merchant/earnings',
    WEEKLY: '/api/merchant/earnings/weekly',
    STATS:  '/api/merchant/stats',
  },
  PROFILE: {
    UPDATE: '/api/merchant/profile',
  },
  BULK_PAYOUTS: {
    LIST:      '/api/merchant/bulk-payouts',
    EXPORT:    '/api/merchant/bulk-payouts/export',
    MARK_PAID: '/api/merchant/bulk-payouts/mark-paid',
  },
  ORDERS_EXTRA: {
    RED_FLAG: (id: string) => `/api/merchant/orders/${id}/red-flag`,
  },
};

export const APP_CONFIG = {
  NAME: 'BB Token Merchant Panel',
  VERSION: import.meta.env.VITE_APP_VERSION || '—',  // L-03 fix: from package.json via Vite
  CURRENCY_SYMBOL: 'Rs.',
  DEFAULT_CURRENCY: 'INR',
  ORDER_EXPIRY_MINUTES: 30,
  CHAT_MAX_LENGTH: 500,
  FILE_MAX_SIZE: 5 * 1024 * 1024,
  AUTO_REFRESH_INTERVAL: 60000,
  WEBSOCKET_RECONNECT_DELAY: 3000,
};

export const FEATURES = {
  ENABLE_MOCK_MODE: false,
  ENABLE_ANALYTICS: true,
  ENABLE_NOTIFICATIONS: true,
  ENABLE_CHAT: true,
  ENABLE_VIDEO_KYC: true,
  ENABLE_DISPUTE_RESOLUTION: true,
  ENABLE_REAL_TIME_UPDATES: true,
};

export const SOCKET_EVENTS = {
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  NEW_ORDER: 'newOrder',
  ORDER_UPDATE: 'order_update',  // H-02 fix: must match backend snake_case emit name
  ORDER_CANCELLED: 'orderCancelled',
  NEW_MESSAGE: 'newMessage',
  NOTIFICATION: 'notification',
  PAYMENT_CONFIRMED: 'paymentConfirmed',
  DISPUTE_OPENED: 'disputeOpened',
};

export const STORAGE_KEYS = {
  TOKEN: 'merchantToken',
  USER: 'merchantData',
  THEME: 'merchant_theme',
  PREFERENCES: 'merchant_preferences',
};

export const STATUS_COLORS: { [key: string]: string } = {
  PENDING_QUEUE: '#FFA500',
  ASSIGNED: '#3498db',
  PROCESSING: '#f39c12',
  COMPLETED: '#27ae60',
  PAID: '#2ecc71',
  CANCELLED: '#e74c3c',
  REJECTED: '#e74c3c',
  DISPUTED: '#e67e22',
  FAILED: '#c0392b',
};

export const STATUS_ICONS: { [key: string]: string } = {
  PENDING_QUEUE: '[wait]',
  ASSIGNED: '[list]',
  PROCESSING: '?',
  COMPLETED: '[OK]',
  PAID: '[money]',
  CANCELLED: '[X]',
  REJECTED: '[block]',
  DISPUTED: '[!]',
  FAILED: '?',
};

export const STATUS_LABELS: { [key: string]: string } = {
  PENDING_QUEUE: 'Waiting in Queue',
  ASSIGNED: 'Assigned to You',
  PROCESSING: 'Payment Processing',
  PAID: 'Payment Confirmed',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  REJECTED: 'Rejected',
  DISPUTED: 'Under Dispute',
  FAILED: 'Failed',
};

export const ESCROW_COLORS: { [key: string]: string } = {
  NONE: '#95a5a6',
  LOCKED: '#e67e22',
  RELEASED: '#27ae60',
  REFUNDED: '#3498db',
};

export const PAGINATION = {
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
  ORDERS_PER_PAGE: 20,
  HISTORY_PER_PAGE: 50,
};

export const TIMEOUTS = {
  API_TIMEOUT: 30000,
  TOAST_DURATION: 3000,
  AUTO_REFRESH: 60000,
  ORDER_COUNTDOWN_UPDATE: 1000,
};

export const ROUTES = {
  LOGIN: '/',
  DASHBOARD: '/dashboard',
  ORDERS: '/orders',
  HISTORY: '/history',
  PROFILE: '/profile',
};

export const ORDER_TYPE_LABELS = {
  DEPOSIT: 'Deposit (User -> Merchant)',
  WITHDRAWAL: 'Withdrawal (Merchant -> User)',
};

export const PAYMENT_METHOD_LABELS: { [key: string]: string } = {
  UPI: 'UPI',
  IMPS: 'IMPS',
  NEFT: 'NEFT',
  RTGS: 'RTGS',
  BANK_TRANSFER: 'Bank Transfer',
};

export const KYC_STATUS_LABELS: { [key: string]: string } = {
  PENDING_SUBMISSION: 'Not Submitted',
  PENDING_APPROVAL: 'Pending Verification',
  APPROVED: 'Verified',
  REJECTED: 'Rejected',
};

export const CHART_COLORS = {
  PRIMARY: '#3b82f6',
  SUCCESS: '#10b981',
  WARNING: '#f59e0b',
  DANGER: '#ef4444',
  INFO: '#06b6d4',
  DEPOSITS: '#10b981',
  WITHDRAWALS: '#ef4444',
  PROFIT: '#3b82f6',
  VOLUME: '#8b5cf6',
};

export const DATE_FORMATS = {
  SHORT: 'DD/MM/YYYY',
  LONG: 'DD MMM YYYY, HH:mm',
  TIME: 'HH:mm:ss',
  FULL: 'DD MMMM YYYY, HH:mm:ss',
};

export const ERROR_MESSAGES = {
  NETWORK_ERROR: 'Network error. Please check your connection.',
  SESSION_EXPIRED: 'Session expired. Please login again.',
  ORDER_NOT_FOUND: 'Order not found.',
  UNAUTHORIZED: 'You are not authorized to perform this action.',
  UNKNOWN_ERROR: 'An unexpected error occurred.',
};

export const SUCCESS_MESSAGES = {
  ORDER_ACCEPTED: 'Order accepted successfully',
  ORDER_REJECTED: 'Order rejected',
  PAYMENT_CONFIRMED: 'Payment confirmed successfully',
  PROFILE_UPDATED: 'Profile updated successfully',
  STATUS_UPDATED: 'Status updated successfully',
  MESSAGE_SENT: 'Message sent',
};

if (import.meta.env.DEV) {
  console.log('? Configuration loaded:', {
    apiBaseUrl: API_BASE_URL,
    version: APP_CONFIG.VERSION,
    features: FEATURES,
    environment: window.location.hostname.includes('localhost') ? 'development' : 'production',
  });
}

