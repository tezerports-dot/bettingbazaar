// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The boards come from the server, in the admin's order (owner, 2026-10-08):
 * the first is the one shown, a board created since the list was read is
 * picked up when an event names it, and a snapshot of any board is applied.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

const bridge = vi.hoisted(() => new EventTarget());
const lists = vi.hoisted(() => ({ calls: 0, next: [] as any[] }));
vi.mock('./backend.service', () => ({
  getBackend: () => ({ sseBridge: bridge, socket: null, getCycleHistory: async () => [] }),
  setCdnBaseUrl: () => {},
}));
vi.mock('./apiClient', () => ({
  default: { get: async (path: string) => {
    if (path !== '/api/v1/boards') throw new Error(`unexpected ${path}`);
    lists.calls += 1;
    return { boards: lists.next };
  } },
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ addToast: () => {} }) }));
vi.mock('./branding', () => ({ applyBranding: () => {} }));

const { GameProvider, useGame } = await import('./GameContext');

const board = (key: string, name: string, homeOrder: number) => ({
  key, name, kind: 'INTERVAL', durationMin: 5, anchorHourIst: null, homeOrder, idPrefix: key.replace(/_/g, ''),
  phases: { mergeBeforeEndSec: 40, equalizerBeforeEndSec: 30, closeBeforeEndSec: 20, celebrateBeforeEndSec: 5 },
  minBet: 50, maxBet: 500,
});

const Probe = () => {
  const g = useGame();
  return <p>{`${g.boards.map((b) => b.key).join(',')} | ${g.cycleType} | ${g.currentBoard?.minBet ?? '-'} | ${g.currentCycle.id}`}</p>;
};

describe('the boards in the player app', () => {
  it('shows the admin\'s order, opens on the first board, and re-reads the list for a board it does not know', async () => {
    lists.next = [board('FIVE', 'Five', 0), board('30_MIN', '30 min', 1)];
    render(<GameProvider><Probe /></GameProvider>);
    await waitFor(() => expect(screen.getByText(/^FIVE,30_MIN \| FIVE \| 50 \| LOADING_FIVE$/)).toBeTruthy());

    act(() => {
      bridge.dispatchEvent(Object.assign(new Event('cycle_snapshot'), { data: {
        audience: 'VIP',
        cycles: { FIVE: { cycleId: 'FIVE_1', type: 'FIVE', status: 'OPEN', startTime: 1, endTime: 2 } },
      } }));
    });
    expect(screen.getByText(/\| FIVE_1$/)).toBeTruthy();

    // A board created after the list was read: its event is applied and the list re-read.
    const before = lists.calls;
    lists.next = [...lists.next, board('NEW_ONE', 'New one', 2)];
    act(() => {
      bridge.dispatchEvent(Object.assign(new Event('new_cycle'), { data: {
        cycleId: 'NEWONE_1', type: 'NEW_ONE', audience: 'VIP', startTime: 1, endTime: 2,
      } }));
    });
    await waitFor(() => expect(lists.calls).toBeGreaterThan(before));
    await waitFor(() => expect(screen.getByText(/^FIVE,30_MIN,NEW_ONE \| FIVE /)).toBeTruthy());
  });
});
