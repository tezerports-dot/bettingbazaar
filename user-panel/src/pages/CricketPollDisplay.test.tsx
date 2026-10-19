// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What a cricket poll says of itself (owner, 2026-10-19): every odds button
 * names what it is for; a player poll lists each team's favourites first with
 * "Any other player" last; a settled poll names its winner, or the players
 * sharing a dead heat, and a dead-heat win says it was paid on part of the stake.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

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

const { default: CricketPage, playerGroups, winnerLine, deadHeatNote } = await import('./CricketPage');

const o = (key: string, label: string, oddsX100: number) => ({ key, label, poolPaise: 10_000, oddsX100 });
const base = { matchId: 'M1', innings: 0, overNo: 0, seq: 0, spreadBp: 1000, seedPaise: 100, closesAt: null, voidReason: null };
const players = [
  o('P1', 'Asha (Alpha)', 900), o('P2', 'Arun (Alpha)', 300), o('P3', 'Ajay (Alpha, squad)', 2000),
  ...Array.from({ length: 6 }, (_, i) => o(`PA${i}`, `Extra ${i} (Alpha)`, 1000 + i)),
  o('P4', 'Bela (Bravo)', 450), o('OTHER', 'Any other player', 120),
];

describe('player polls', () => {
  it('group by team, favourites first, squad players marked, "Any other player" kept for last', () => {
    const { teams, other } = playerGroups(players);
    expect(teams.map(([t]) => t)).toEqual(['Alpha', 'Bravo']);
    expect(teams[0][1].map((p) => p.name).slice(0, 2)).toEqual(['Arun', 'Asha']);
    expect(teams[0][1].find((p) => p.name === 'Ajay')?.squad).toBe(true);
    expect(other?.key).toBe('OTHER');
  });

  it('draw each name with its price, six per team until "Show all", and "Any other player" after the teams', async () => {
    api.matches.mockResolvedValue({ matches: [{
      matchId: 'M1', seriesName: 'S', format: 'T20', teamA: { id: '1', name: 'Alpha', code: 'ALP', logo: null }, teamB: { id: '2', name: 'Bravo', code: 'BRV', logo: null },
      venue: null, startsAt: new Date().toISOString(), status: 'LIVE', toss: null, result: null, score: {},
      polls: [{ ...base, pollId: 'TB', kind: 'TOP_BATSMAN', title: 'Best batsman', status: 'OPEN', winningOptions: null, options: players }],
    }] });
    api.myBets.mockResolvedValue({ bets: [] });
    render(<CricketPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Alpha/ }));
    expect(await screen.findByRole('button', { name: 'Arun (Alpha) at 3.00' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ajay (Alpha, squad) at 20.00' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 9 Alpha players' }));
    expect(screen.getByRole('button', { name: 'Ajay (Alpha, squad) at 20.00' })).toBeTruthy();
    const all = screen.getAllByRole('button', { name: / at \d/ }).map((b) => b.getAttribute('aria-label'));
    expect(all[all.length - 1]).toBe('Any other player at 1.20');
    expect(within(screen.getByRole('button', { name: 'Arun (Alpha) at 3.00' })).getByText('3.00')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Open');
  });
});

describe('a settled poll', () => {
  const poll = (winningOptions: string[]) => ({ ...base, pollId: 'X', kind: 'TOP_BOWLER' as const, title: 'Best bowler', status: 'SETTLED' as const, winningOptions, options: players });
  it('names its winner, or the players sharing a dead heat', () => {
    expect(winnerLine(poll(['P2']))).toBe('Winner: Arun (Alpha)');
    expect(winnerLine(poll(['P2', 'P4']))).toBe('Dead heat: Arun (Alpha) / Bela (Bravo)');
    expect(winnerLine({ ...poll([]), status: 'OPEN', winningOptions: null })).toBeNull();
  });
  it('says a dead-heat win was paid on part of the stake', () => {
    expect(deadHeatNote({ status: 'WON', deadHeat: 2 })).toBe(' (dead heat, 1/2 stake)');
    expect(deadHeatNote({ status: 'WON', deadHeat: 1 })).toBe('');
    expect(deadHeatNote({ status: 'LOST', deadHeat: 1 })).toBe('');
  });
});
