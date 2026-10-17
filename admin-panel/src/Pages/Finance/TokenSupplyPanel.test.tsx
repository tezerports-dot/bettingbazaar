// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The token supply panel shows the 20 billion and who holds it, offers the
 * holder list only to the players area, and downloads the server's CSV.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { get, downloadCsv, can } = vi.hoisted(() => ({ get: vi.fn(), downloadCsv: vi.fn(), can: vi.fn() }));
vi.mock('../../services/api', () => ({
  default: { get },
  downloadCsv,
  cleanParams: (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null)),
}));
vi.mock('../../hooks/usePermission', () => ({ usePermissions: () => ({ can }) }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { TokenSupplyPanel } from './TokenSupplyPanel';

const SUPPLY = {
  success: true, supply: 20_000_000_000, accountedFor: true,
  kinds: [
    { kind: 'PLATFORM', holders: 1, tokens: 19_999_000_000, held: 0, sharePercent: 99.995 },
    { kind: 'PLAYER', holders: 2, tokens: 1_000_000, held: 500, sharePercent: 0.005 },
  ],
};
const HOLDERS = {
  success: true, total: 1,
  holders: [{ kind: 'PLAYER', holderId: 'u-1', name: 'asha', owner: null, tokens: 777, held: 0, members: null, sharePercent: 0 }],
};

beforeEach(() => {
  get.mockReset(); downloadCsv.mockReset(); can.mockReset();
  get.mockImplementation((url: string) => Promise.resolve({ data: url.includes('token-holders') ? HOLDERS : SUPPLY }));
});

describe('TokenSupplyPanel', () => {
  it('shows the supply and the split by holder kind', async () => {
    can.mockReturnValue(false);
    render(<TokenSupplyPanel />);
    expect(await screen.findByText('20,00,00,00,000 tokens')).toBeTruthy();
    expect(screen.getByText('Every token accounted for')).toBeTruthy();
    expect(screen.getByText('Players')).toBeTruthy();
    // Without the players area, no per-player list is asked for.
    expect(get.mock.calls.some(([u]) => String(u).includes('token-holders'))).toBe(false);
  });

  it('lists each holder and downloads the CSV for an account with the players area', async () => {
    can.mockReturnValue(true);
    render(<TokenSupplyPanel />);
    expect(await screen.findByText('asha')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Download CSV/ }));
    await waitFor(() => expect(downloadCsv).toHaveBeenCalledWith('/api/admin/analytics/token-holders.csv', {}, 'token-holders.csv'));
  });
});
