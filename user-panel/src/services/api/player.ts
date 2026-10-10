// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/** The signed-in player's own settings and records. Never served stale. */
import apiClient from '../apiClient';

/** Which board-rules version this player has accepted, beside the current one. */
export const boardRulesAcceptance = (): Promise<any> =>
  apiClient.get('/api/user/board-rules');

export const acceptBoardRules = (version: number): Promise<any> =>
  apiClient.post('/api/user/board-rules/accept', { version });

/** Play profile (VIP/GENERAL) and the General balance with its turnover. */
export const generalSummary = (): Promise<any> =>
  apiClient.get('/api/user/general');

export const setPlayProfile = (profile: string): Promise<any> =>
  apiClient.put('/api/user/play-profile', { profile });

export const referrals = (): Promise<any> =>
  apiClient.get('/api/user/referrals');
