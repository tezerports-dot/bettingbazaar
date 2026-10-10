// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Token orders: buying, selling, and every move a player makes on an order
 * (backend `payment.routes.js`, `usdtDeposit.routes.js`). No read here is
 * served stale: an order's state is the server's alone (CLAUDE.md §9).
 *
 * POSTs are never retried by the client (apiClient `IDEMPOTENT`): a lost
 * response may already have created the order or recorded the payment.
 */
import apiClient from '../apiClient';

export const createBuy = (tokenAmount: number): Promise<any> =>
  apiClient.post('/api/payment/deposit/create', { tokenAmount });

export const createUsdtBuy = (usdtAmount: number, usdtChain: string): Promise<any> =>
  apiClient.post('/api/payment/usdt/deposit/create', { usdtAmount, usdtChain });

export const createSell = (tokenAmount: number): Promise<any> =>
  apiClient.post('/api/payment/withdrawal/create', { tokenAmount });

export const listOrders = (limit = 20): Promise<any> =>
  apiClient.get(`/api/payment/orders?limit=${limit}`);

export const orderStatus = (orderId: string): Promise<any> =>
  apiClient.get(`/api/payment/order/${orderId}/status`);

/** The Paid tap. A cash buy sends no reference here; the rest send theirs. */
export const markPaid = (orderId: string, utrNumber?: string): Promise<any> =>
  apiClient.post(`/api/payment/order/${orderId}/mark-paid`, utrNumber === undefined ? {} : { utrNumber });

/** A reference given after the Paid tap (a cash buy's UTR). */
export const submitPaymentReference = (orderId: string, utrNumber: string): Promise<any> =>
  apiClient.post(`/api/payment/order/${orderId}/payment-reference`, { utrNumber });

export const requestUtrGrace = (orderId: string): Promise<any> =>
  apiClient.post(`/api/payment/order/${orderId}/utr-grace`, {});

export const raiseDispute = (orderId: string, reason: string): Promise<any> =>
  apiClient.post(`/api/payment/order/${orderId}/dispute`, { reason });

export const cancelOrder = (orderId: string): Promise<any> =>
  apiClient.post('/api/payment/order/cancel', { orderId });

export const retryOrder = (orderId: string): Promise<any> =>
  apiClient.post(`/api/payment/order/${orderId}/retry`, {});
