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

/** How a player pays a UPI/bank buy (backend orderRails.js BUY_PAY_METHODS; owner, 2026-10-21). */
export type BuyPayMethod = 'UPI' | 'BANK';

export const createBuy = (tokenAmount: number, payMethod: BuyPayMethod | null = null): Promise<any> =>
  apiClient.post('/api/payment/deposit/create', payMethod ? { tokenAmount, payMethod } : { tokenAmount });

export const createUsdtBuy = (usdtAmount: number, usdtChain: string): Promise<any> =>
  apiClient.post('/api/payment/usdt/deposit/create', { usdtAmount, usdtChain });

export const createSell = (tokenAmount: number): Promise<any> =>
  apiClient.post('/api/payment/withdrawal/create', { tokenAmount });

export const listOrders = (limit = 20): Promise<any> =>
  apiClient.get(`/api/payment/orders?limit=${limit}`);

export const orderStatus = (orderId: string): Promise<any> =>
  apiClient.get(`/api/payment/order/${orderId}/status`);

/** The Paid tap, carrying the reference on every rail (owner, 2026-10-22). */
export const markPaid = (orderId: string, utrNumber: string): Promise<any> =>
  apiClient.post(`/api/payment/order/${orderId}/mark-paid`, { utrNumber });

export const requestUtrGrace = (orderId: string): Promise<any> =>
  apiClient.post(`/api/payment/order/${orderId}/utr-grace`, {});

export const raiseDispute = (orderId: string, reason: string): Promise<any> =>
  apiClient.post(`/api/payment/order/${orderId}/dispute`, { reason });

export const cancelOrder = (orderId: string): Promise<any> =>
  apiClient.post('/api/payment/order/cancel', { orderId });

export const retryOrder = (orderId: string): Promise<any> =>
  apiClient.post(`/api/payment/order/${orderId}/retry`, {});
