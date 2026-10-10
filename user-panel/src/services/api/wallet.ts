// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What the player holds and how it moved. Never served stale: a balance shown
 * from a cache is a claim the server did not make (CLAUDE.md §9).
 */
import apiClient from '../apiClient';

/** All four pockets and the stake ceiling, from the rule the bet route enforces. */
export const betLimits = (): Promise<any> =>
  apiClient.get('/api/user/bet-limits');

export const ledger = (page: number, limit = 25): Promise<any> =>
  apiClient.get(`/api/v1/wallet/ledger?page=${page}&limit=${limit}`);

export const bonuses = (page: number, limit = 25): Promise<any> =>
  apiClient.get(`/api/bonuses/my?page=${page}&limit=${limit}`);
