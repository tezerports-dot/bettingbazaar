// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/** Support tickets and the assistant. */
import apiClient from '../apiClient';

export const tickets = (): Promise<any> =>
  apiClient.get('/api/support/tickets');

export const ticket = (ticketId: string): Promise<any> =>
  apiClient.get(`/api/support/tickets/${ticketId}`);

/** Whether the assistant is worth asking. Unauthenticated, like its route. */
export const assistantStatus = (): Promise<any> =>
  apiClient.get('/api/support/status');

export const openTicket = (subject: string, message: string): Promise<any> =>
  apiClient.post('/api/support/tickets', { subject, message });

export const reply = (ticketId: string, content: string): Promise<any> =>
  apiClient.post(`/api/support/tickets/${ticketId}/reply`, { content });

export const ask = (query: string): Promise<any> =>
  apiClient.post('/api/support/ask', { query });
