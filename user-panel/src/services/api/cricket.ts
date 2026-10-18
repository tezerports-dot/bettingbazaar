// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Cricket opinion polls (owner, 2026-10-18): backend/domains/cricket/cricket.routes.js.
 * The odds on screen are a live reference; `quoteBet` / `quoteClaim` ask the
 * server for the figure now, and `placeBet` / `claim` send back what the
 * player confirmed as their minimum. Shapes mirror the repository's
 * (`database/repositories/cricket.js`: toPoll, toBet, summarise).
 */
import apiClient from '../apiClient';

export interface CricketTeam { id: string; name: string; code: string | null; logo: string | null }
export interface CricketOption { key: string; label: string; poolPaise: number; oddsX100: number }
export interface CricketPoll {
  pollId: string; matchId: string; kind: 'TOSS' | 'MATCH_RESULT' | 'MOM' | 'OVER' | 'BALL';
  innings: number; overNo: number; seq: number; title: string;
  status: 'OPEN' | 'CLOSED' | 'SETTLED' | 'VOID';
  spreadBp: number; seedPaise: number; closesAt: string | null;
  winningOption: string | null; voidReason: string | null; options: CricketOption[];
}
export interface CricketScore { innings?: { innings: number; team: 'A' | 'B' | null; runs: number; wickets: number; overs: number }[]; note?: string | null }
export interface CricketMatch {
  matchId: string; seriesName: string | null; format: string; teamA: CricketTeam; teamB: CricketTeam;
  venue: string | null; startsAt: string; status: string; toss: { winner: 'A' | 'B'; elected: 'BAT' | 'BOWL' } | null;
  result: string | null; score: CricketScore; polls: CricketPoll[];
}
export interface CricketBet {
  betId: string; pollId: string; matchId: string; optionKey: string; optionLabel: string; pollTitle: string;
  pollKind: string; pollStatus: string; stakePaise: number; oddsX100: number; potentialPaise: number;
  status: 'OPEN' | 'CLAIMED' | 'WON' | 'LOST' | 'VOID'; paidPaise: number; feePaise: number; placedAt: string; matchName: string;
}
export interface ClaimQuote {
  lines: { betId: string; pollId: string; optionKey: string; stakePaise: number; grossPaise: number; feePaise: number; netPaise: number }[];
  totalNetPaise: number; totalStakePaise: number; delaySec: number;
}

const DISPLAY = { staleOnError: true } as const;

export const matches = (): Promise<{ success: boolean; matches: CricketMatch[] }> =>
  apiClient.get('/api/v1/cricket/matches', DISPLAY);

export const myBets = (matchId?: string): Promise<{ success: boolean; bets: CricketBet[] }> =>
  apiClient.get(`/api/v1/cricket/me/bets?matchId=${encodeURIComponent(matchId ?? '')}`);

export const quoteBet = (pollId: string, optionKey: string, stake: number): Promise<{ oddsX100: number; potentialPaise: number; delaySec: number }> =>
  apiClient.post('/api/v1/cricket/quote/bet', { pollId, optionKey, stake });

/** `idempotencyKey`: one per bet the player confirms; the same key on a retry answers the same bet. */
export const placeBet = (body: { pollId: string; optionKey: string; stake: number; minOdds: number; idempotencyKey: string }): Promise<{ bet: CricketBet }> =>
  apiClient.post('/api/v1/cricket/bets', body);

export const quoteClaim = (target: { matchId: string } | { betIds: string[] }): Promise<ClaimQuote> =>
  apiClient.post('/api/v1/cricket/quote/claim', target);

export const claim = (target: ({ matchId: string } | { betIds: string[] }) & { minTotalPaise: number }): Promise<{ totalNetPaise: number }> =>
  apiClient.post('/api/v1/cricket/claims', target);
