// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Betting and claiming happen inside each poll's card (owner, 2026-10-18):
 * pick an opinion, type a stake, see what it pays, place it; the poll's own
 * Claim quotes only that poll's open bets, beside the match's Claim all.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  matches: vi.fn(), myBets: vi.fn(), quoteClaim: vi.fn(), quoteBet: vi.fn(), placeBet: vi.fn(), claim: vi.fn(),
}));
vi.mock('../services/api', () => ({ cricket: api }));
vi.mock('react-router', async () => ({ ...(await vi.importActual<any>('react-router')), useNavigate: () => vi.fn() }));
vi.mock('../services/backend.service', () => ({ getBackend: () => ({ subscribeToCricket: () => () => {} }) }));
vi.mock('../services/GameContext', () => ({
  useCricketSettings: () => ({ enabled: true, comingSoon: false, claimHoldSec: 2, minStake: 10, maxStake: 50000, inPlayDelaySec: 5, claimMarginPercent: 5, winningsFeePercent: 1 }),
  useGame: () => ({ isAuthenticated: true }),
}));
vi.mock('../redesign/RedesignShell', () => ({ useShell: () => ({ openAuth: vi.fn() }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('../redesign/Screen', () => ({
  default: ({ children }: any) => <main>{children}</main>, card: {}, capLabel: {}, goldButton: {}, inputStyle: {},
}));

const opts = [{ key: 'A', label: 'Alpha win', poolPaise: 300_000, oddsX100: 180 }, { key: 'B', label: 'Bravo win', poolPaise: 300_000, oddsX100: 180 }];
const poll = (pollId: string, title: string, kind: string) => ({
  pollId, matchId: 'M1', kind, innings: 0, overNo: 0, seq: 0, title, status: 'OPEN', spreadBp: 1000, seedPaise: 100, closesAt: null,
  winningOption: null, voidReason: null, options: opts,
});
const bet = (betId: string, pollId: string, pollTitle: string) => ({
  betId, pollId, matchId: 'M1', optionKey: 'A', optionLabel: 'Alpha win', pollTitle, pollKind: 'X', pollStatus: 'OPEN',
  stakePaise: 10_000, oddsX100: 180, potentialPaise: 18_000, status: 'OPEN', paidPaise: 0, feePaise: 0, placedAt: '', matchName: '',
});

const { default: CricketPage } = await import('./CricketPage');

const match = () => ({ matches: [{
  matchId: 'M1', seriesName: 'S', format: 'T20', teamA: { id: '1', name: 'Alpha', code: null, logo: null }, teamB: { id: '2', name: 'Bravo', code: null, logo: null },
  venue: null, startsAt: new Date().toISOString(), status: 'LIVE', toss: null, result: null, score: {},
  polls: [poll('P1', 'Match result', 'MATCH_RESULT'), poll('P2', 'Best batsman', 'TOP_BATSMAN')],
}] });

describe('a poll card', () => {
  it('takes a bet in place: pick, stake, see the payout, place at the exact odds', async () => {
    api.matches.mockResolvedValue(match());
    api.myBets.mockResolvedValue({ bets: [] });
    // 3,000 + 3,000 in the pools, 10 % spread: a 100-token bet on A gets 0.9 × 6,100 / 3,100 = 1.77.
    api.quoteBet.mockResolvedValue({ oddsX100: 177, potentialPaise: 17_700, delaySec: 5 });
    api.placeBet.mockResolvedValue({ bet: { oddsX100: 177 } });
    render(<CricketPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Alpha/ }));
    const [resultPick] = await screen.findAllByRole('button', { name: 'Alpha win at 1.80' });
    fireEvent.click(resultPick);
    const [stake] = screen.getAllByLabelText('Stake (tokens)');
    fireEvent.change(stake, { target: { value: '100' } });
    expect(screen.getByText('1.77')).toBeTruthy();
    expect(screen.getByText('+77')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Place bet · 100' }));
    await waitFor(() => expect(api.placeBet).toHaveBeenCalledWith(expect.objectContaining({ pollId: 'P1', optionKey: 'A', stake: 100, minOdds: 177 })));
  });

  it('asks the player to confirm when the exact odds came back lower than shown', async () => {
    api.matches.mockResolvedValue(match());
    api.myBets.mockResolvedValue({ bets: [] });
    api.placeBet.mockClear();
    api.quoteBet.mockResolvedValue({ oddsX100: 150, potentialPaise: 15_000, delaySec: 5 });
    render(<CricketPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Alpha/ }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Alpha win at 1.80' }))[0]);
    fireEvent.change(screen.getAllByLabelText('Stake (tokens)')[0], { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Place bet · 100' }));
    expect(await screen.findByRole('button', { name: 'Confirm at 1.50' })).toBeTruthy();
    expect(api.placeBet).not.toHaveBeenCalled();
  });

  it("claims only that poll's bets", async () => {
    api.matches.mockResolvedValue(match());
    api.myBets.mockResolvedValue({ bets: [bet('b1', 'P1', 'Match result'), bet('b2', 'P2', 'Best batsman'), bet('b3', 'P1', 'Match result')] });
    api.quoteClaim.mockResolvedValue({ lines: [], totalNetPaise: 0, totalStakePaise: 0, delaySec: 5 });
    render(<CricketPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Alpha/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Claim Match result' }));
    await waitFor(() => expect(api.quoteClaim).toHaveBeenCalledWith({ betIds: ['b1', 'b3'] }));
    expect(screen.getByRole('button', { name: 'Claim Best batsman' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Players' })).toBeTruthy();
  });
});
