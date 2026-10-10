// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What the platform tells every viewer: boards, rules, announcements, winners,
 * the leaderboard. The display-only reads here ask for `staleOnError`, so a
 * dropped connection keeps the last good answer on screen (apiClient, window
 * FALLBACK_MAX_AGE_MS). The system config does not: the order sizes it carries
 * are what the wallet offers, and those are the server's to state.
 */
import apiClient from '../apiClient';

const DISPLAY = { staleOnError: true } as const;

export const boards = (): Promise<any> =>
  apiClient.get('/api/v1/boards', DISPLAY);

export const boardRules = (): Promise<any> =>
  apiClient.get('/api/v1/board-rules', DISPLAY);

export const systemConfig = (): Promise<any> =>
  apiClient.get('/api/v1/system/config');

export const announcements = (): Promise<any> =>
  apiClient.get('/api/announcements', DISPLAY);

export const winners = (period: string, limit = 10): Promise<any> =>
  apiClient.get(`/api/v1/winners?limit=${limit}&period=${period}`, DISPLAY);

export const leaderboard = (period: string): Promise<any> =>
  apiClient.get(`/api/leaderboard/${period}`, DISPLAY);

/** A crash in the UI, for the admin's error log. Best-effort: never throws. */
export const reportCrash = (report: Record<string, unknown>): void => {
  apiClient.post('/api/internal/error-report', report).catch(() => {});
};
