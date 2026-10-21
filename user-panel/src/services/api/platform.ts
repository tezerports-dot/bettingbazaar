// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What the platform tells every viewer: boards, rules, announcements, winners,
 * the leaderboard. The display-only reads here ask for `staleOnError`, so a
 * dropped connection keeps the last good answer on screen (apiClient, window
 * FALLBACK_MAX_AGE_MS). The system config does not: the order sizes it carries
 * are what the wallet offers, and those are the server's to state.
 */
import apiClient, { hasStoredSession, MAINTENANCE_EVENT } from '../apiClient';

export { hasStoredSession, MAINTENANCE_EVENT };

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

/** Whether an Android release is published to offer (`GET /api/app/android/available`). */
export const androidAppAvailable = (): Promise<{ success?: boolean; available?: boolean }> =>
  apiClient.get('/api/app/android/available');

/**
 * Whether this session may use the app during maintenance (owner,
 * 2026-10-20): the server answers 200 only to a maintenance tester (or to
 * anyone once maintenance is off), and 503 MAINTENANCE to everybody else.
 */
export const maintenancePass = async (): Promise<boolean> => {
  try {
    const res = await apiClient.get<{ success?: boolean }>('/api/user/maintenance-pass');
    return res?.success === true;
  } catch { return false; }
};

/** A crash in the UI, for the admin's error log. Best-effort: never throws. */
export const reportCrash = (report: Record<string, unknown>): void => {
  apiClient.post('/api/internal/error-report', report).catch(() => {});
};

/** The Telegram links (bot in use, then standbys) that always open the app's way in, or a 404 with no bot (telegramEntry.ts keeps them). */
export const telegramEntry = (): Promise<{ url?: string; urls?: string[] }> =>
  apiClient.get('/api/v1/client/telegram-entry');
