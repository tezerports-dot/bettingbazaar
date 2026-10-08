// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The board screen shows only its own audience's cycles (owner, 2026-10-08):
 * VIP and GENERAL players never share a cycle, and every realtime event names
 * its audience. A GENERAL event must never move a VIP screen, and a profile
 * switch shows the other audience's boards from the snapshot already held.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

const bridge = vi.hoisted(() => new EventTarget());
vi.mock('./backend.service', () => ({
  getBackend: () => ({ sseBridge: bridge, socket: null, getCycleHistory: async () => [] }),
  setCdnBaseUrl: () => {},
}));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ addToast: () => {} }) }));
vi.mock('./branding', () => ({ applyBranding: () => {} }));

const { GameProvider, useGame } = await import('./GameContext');

const send = (event: string, data: object) => act(() => {
  bridge.dispatchEvent(Object.assign(new Event(event), { data }));
});
const snapshot = (audience: string, cycleId: string) => ({
  audience,
  cycles: { '30_MIN': { cycleId, type: '30_MIN', audience, status: 'OPEN', startTime: 1, endTime: 2, totalDelhi: 0, totalBombay: 0 } },
});

const Probe = () => {
  const g = useGame();
  const c = g.cycles['30_MIN' as keyof typeof g.cycles];
  return (
    <>
      <p>{`${g.audience} ${c?.id} ${c?.status}`}</p>
      <button onClick={() => g.setAudience('GENERAL')}>General</button>
    </>
  );
};

describe('the board screen\'s audience', () => {
  it('applies only its own audience\'s cycles, and switches to the other\'s on a profile change', async () => {
    render(<GameProvider><Probe /></GameProvider>);
    send('cycle_snapshot', snapshot('VIP', '30MIN_1'));
    send('cycle_snapshot', snapshot('GENERAL', '30MIN_G_1'));
    expect(screen.getByText(/^VIP 30MIN_1 OPEN$/)).toBeTruthy();

    // The GENERAL board moving does not move the VIP screen.
    send('cycle_phase', { cycleId: '30MIN_G_1', type: '30_MIN', audience: 'GENERAL', phase: 'CLOSED' });
    send('new_cycle', { cycleId: '30MIN_G_2', type: '30_MIN', audience: 'GENERAL', startTime: 1, endTime: 2 });
    expect(screen.getByText(/^VIP 30MIN_1 OPEN$/)).toBeTruthy();

    act(() => { fireEvent.click(screen.getByRole('button', { name: 'General' })); });
    expect(screen.getByText(/^GENERAL 30MIN_G_1 /)).toBeTruthy();

    // And now a VIP event leaves the GENERAL screen alone.
    send('cycle_phase', { cycleId: '30MIN_1', type: '30_MIN', audience: 'VIP', phase: 'CLOSED' });
    expect(screen.getByText(/^GENERAL 30MIN_G_1 OPEN$/)).toBeTruthy();
  });
});
