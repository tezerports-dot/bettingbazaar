// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The server sends each stream ONE `bet_placed` per tick carrying every live
 * cycle whose pools moved (`cycleSnapshotPublisher.js`), not one message per
 * cycle per server worker. Every board in the batch must move.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

const bridge = vi.hoisted(() => Object.assign(new EventTarget(), { heldPayloads: () => [] }));
vi.mock('./backend.service', () => ({
  getBackend: () => ({ sseBridge: bridge, socket: null, getCycleHistory: async () => [] }),
  setCdnBaseUrl: () => {},
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ addToast: () => {} }) }));
vi.mock('./branding', () => ({ applyBranding: () => {} }));

const { GameProvider, useGame } = await import('./GameContext');

const cycle = (type: string, cycleId: string) =>
  ({ cycleId, type, audience: 'VIP', status: 'OPEN', startTime: 1000, endTime: Date.now() + 600_000, totalDelhi: 0, totalBombay: 0 });

const Probe = () => {
  const g = useGame();
  const pool = (t: string) => g.cycles[t as keyof typeof g.cycles]?.totalPool ?? 'none';
  return <p>{`30=${pool('30_MIN')} FD=${pool('FULL_DAY')}`}</p>;
};

const send = (event: string, data: unknown) =>
  act(() => { bridge.dispatchEvent(Object.assign(new Event(event), { data })); });

describe('a batched bet_placed', () => {
  it('moves every board it carries, and ignores a cycle that is not on the board', async () => {
    render(<GameProvider><Probe /></GameProvider>);
    send('cycle_snapshot', { audience: 'VIP', cycles: { '30_MIN': cycle('30_MIN', '30MIN_1'), FULL_DAY: cycle('FULL_DAY', 'FD_1') } });
    expect(screen.getByText('30=0 FD=0')).toBeTruthy();

    send('bet_placed', { pools: [
      { cycleId: '30MIN_1', cycleType: '30_MIN', newTotalDelhi: 100, newTotalBombay: 50 },
      { cycleId: 'FD_1', cycleType: 'FULL_DAY', poolsHidden: true, totalPool: 900 },
      { cycleId: '30MIN_0', cycleType: '30_MIN', newTotalDelhi: 9999, newTotalBombay: 0 },
    ] });
    await waitFor(() => expect(screen.getByText('30=150 FD=900')).toBeTruthy());
  });
});
