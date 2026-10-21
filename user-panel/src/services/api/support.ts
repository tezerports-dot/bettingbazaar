// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/** The player's support desk (CLAUDE.md §2, "Support desks") and the assistant. */
import apiClient from '../apiClient';

/** Topics, limits, and whether today's one ticket is used. */
export const desk = (): Promise<any> =>
  apiClient.get('/api/support/desk');

/** Own tickets from the last 7 days. */
export const tickets = (): Promise<any> =>
  apiClient.get('/api/support/tickets');

export const ticket = (ticketId: string): Promise<any> =>
  apiClient.get(`/api/support/tickets/${ticketId}`);

export const openTicket = (body: { topic: string; reference?: string; description: string }): Promise<any> =>
  apiClient.post('/api/support/tickets', body);

export const rate = (ticketId: string, rating: number): Promise<any> =>
  apiClient.post(`/api/support/tickets/${ticketId}/rate`, { rating });

/** The Dispute Manager's Telegram, on the player's own DISPUTED order. */
export const disputeContact = (orderId: string): Promise<any> =>
  apiClient.get(`/api/support/dispute-contact/${encodeURIComponent(orderId)}`);

/** Whether the assistant is worth asking. Unauthenticated, like its route. */
export const assistantStatus = (): Promise<any> =>
  apiClient.get('/api/support/status');

export const ask = (query: string): Promise<any> =>
  apiClient.post('/api/support/ask', { query });
