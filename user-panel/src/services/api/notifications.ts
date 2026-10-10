// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/** The player's notification inbox (`notify()` rows). */
import apiClient from '../apiClient';

export const unreadCount = (): Promise<any> =>
  apiClient.get('/api/user/notifications/unread-count');

export const list = (): Promise<any> =>
  apiClient.get('/api/user/notifications');

export const markAllRead = (): Promise<any> =>
  apiClient.post('/api/user/notifications/read', {});
