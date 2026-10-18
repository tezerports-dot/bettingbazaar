// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The stream sends `cycle_snapshot` once, when it opens, and in the browser it
 * lands before GameContext has attached its listener (measured 100–200 ms
 * early, 3 of 3 loads of a production build). With nothing replayed the board
 * had no round: dimmed cards, no timer, and "Bets just closed" on every tap
 * until the next round's re-broadcast. The bridge holds the opening state
 * (`realBackend.ts` `heldPayloads`) and the context applies it on subscribe.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

const held: Record<string, unknown[]> = vi.hoisted(() => ({}));
const bridge = vi.hoisted(() => Object.assign(new EventTarget(), {
  heldPayloads: (event: string) => held[event] ?? [],
  last: new Map<string, unknown>(),
}));
vi.mock('./backend.service', () => ({
  getBackend: () => ({ sseBridge: bridge, socket: null, getCycleHistory: async () => [] }),
  setCdnBaseUrl: () => {},
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ addToast: () => {} }) }));
vi.mock('./branding', () => ({ applyBranding: () => {} }));

const { GameProvider, useGame, useCricketSettings } = await import('./GameContext');

const snapshot = (audience: string, cycleId: string, startTime: number) => ({
  audience,
  cycles: { '30_MIN': { cycleId, type: '30_MIN', audience, status: 'OPEN', startTime, endTime: startTime + 1_800_000, totalDelhi: 0, totalBombay: 0 } },
});

const Probe = () => {
  const g = useGame();
  const c = g.cycles['30_MIN' as keyof typeof g.cycles];
  return <p>{`${g.audience} ${c?.id ?? 'none'}`}</p>;
};

describe('a snapshot that arrived before the board subscribed', () => {
  it('is applied when the board mounts, for its own audience', () => {
    held.cycle_snapshot = [snapshot('VIP', '30MIN_1', 1000), snapshot('GENERAL', '30MIN_G_1', 1000)];
    render(<GameProvider><Probe /></GameProvider>);
    expect(screen.getByText(/^VIP 30MIN_1$/)).toBeTruthy();
  });

  it('never moves a board back to an older round', () => {
    held.cycle_snapshot = [];
    render(<GameProvider><Probe /></GameProvider>);
    act(() => {
      bridge.dispatchEvent(Object.assign(new Event('new_cycle'),
        { data: { cycleId: '30MIN_2', type: '30_MIN', audience: 'VIP', startTime: 2000, endTime: 9000 } }));
    });
    expect(screen.getByText(/^VIP 30MIN_2$/)).toBeTruthy();
    act(() => {
      bridge.dispatchEvent(Object.assign(new Event('cycle_snapshot'), { data: snapshot('VIP', '30MIN_1', 1000) }));
    });
    expect(screen.getByText(/^VIP 30MIN_2$/)).toBeTruthy();
  });
});

// The system config is sent once at open as well (owner, 2026-10-18: a cold
// load showed Cricket as "coming soon" while it was switched on).
describe('a system config that arrived before the context subscribed', () => {
  it('is applied on mount, not left at the defaults', () => {
    bridge.last.set('system_config', { cricket: { enabled: true, comingSoon: false, minStake: 10, maxStake: 50000, inPlayDelaySec: 1, claimMarginPercent: 5, claimHoldSec: 2 } });
    const Cricket = () => { const c = useCricketSettings(); return <p>{`cricket ${c.enabled} ${c.inPlayDelaySec}`}</p>; };
    render(<GameProvider><Cricket /></GameProvider>);
    expect(screen.getByText('cricket true 1')).toBeTruthy();
    bridge.last.clear();
  });
});
