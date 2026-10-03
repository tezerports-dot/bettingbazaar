// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Balance Adjust works with ITS OWN area alone (canAdjustBalances).
 *
 * It found players through `GET /api/admin/users` (the Users area) and read its
 * ceiling from `GET /api/admin/system/config` (System Settings), so a sub-admin
 * given balance adjustment alone could not find anybody and had no bound on the
 * input. Found by check:staff-permissions' cross-area rule (5). The users read
 * also carries no balances, so every result read "Dep: ₹0".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const get = vi.fn();
vi.mock('../../services/api', () => ({ default: { get: (...a: unknown[]) => get(...a), post: vi.fn() } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { BalanceAdjustment } from './BalanceAdjustment';

describe('Balance Adjust — its own area only', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation(async (url: string, cfg?: { params?: { search?: string } }) => {
      if (url === '/api/admin/balance-adjustments') return { data: { success: true, adjustments: [] } };
      if (url === '/api/admin/balance-adjust/players') {
        return cfg?.params?.search
          ? { data: { success: true, maxBalanceAdjustment: 50000, players: [{ userId: 'u-1', username: 'player1', mobile: '9876543210', depositBalance: 1200, winningsBalance: 300 }] } }
          : { data: { success: true, maxBalanceAdjustment: 50000, players: [] } };
      }
      throw new Error(`unexpected request ${url}`);
    });
  });

  it('never asks another area for anything', async () => {
    render(<BalanceAdjustment />);
    fireEvent.change(screen.getByLabelText('Search User'), { target: { value: 'play' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search players' }));
    await screen.findByText(/player1/);
    const urls = get.mock.calls.map((c) => c[0]);
    expect(urls).not.toContain('/api/admin/system/config');
    expect(urls.some((u: string) => u.startsWith('/api/admin/users'))).toBe(false);
  });

  it("finds a player with their real balances, through the area's own lookup", async () => {
    render(<BalanceAdjustment />);
    fireEvent.change(screen.getByLabelText('Search User'), { target: { value: 'play' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search players' }));
    expect(await screen.findByText(/Dep: ₹1200 · Win: ₹300/)).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledWith('/api/admin/balance-adjust/players', { params: { search: 'play', limit: 10 } }));
  });
});
