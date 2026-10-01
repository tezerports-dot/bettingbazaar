// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant whose new buy orders the platform paused is TOLD so.
 *
 * Three unpaid buys in a row pause a merchant's assignment (§2) — they keep
 * their balance and orders, and simply stop being sent players. Opening the
 * panel AS such a merchant (browser profile `merchant-paused`) showed
 * "Online · Accepting orders" and nothing else, while no order could reach
 * them. The profile never carried the pause, and the Dashboard had nowhere to
 * say it.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const auth = vi.hoisted(() => ({ merchant: null as Record<string, unknown> | null }));
vi.mock('../services/AuthContext', () => ({
  useAuth: () => ({ merchant: auth.merchant, refreshProfile: vi.fn() }),
}));
vi.mock('../services/api', () => ({
  api: {
    getStats: vi.fn().mockResolvedValue({}),
    getEarnings: vi.fn().mockResolvedValue({ earnings: null }),
    getWeeklyEarnings: vi.fn().mockResolvedValue({ weekly: [] }),
    toggleOnlineStatus: vi.fn(),
  },
}));
vi.mock('../hooks/useOrders', () => ({
  useOrders: () => ({ orders: [], state: 'ready', counts: {} }),
  needsAction: () => false,
}));
vi.mock('../components/SettlementRailBanner', () => ({ SettlementRailBanner: () => null }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import Dashboard from './Dashboard';

const show = (merchant: Record<string, unknown>) => {
  auth.merchant = { id: 'm-1', merchantId: 'm-1', isOnline: true, acceptedCurrencies: ['INR'], tokenBalance: 1000, ...merchant };
  return render(<MemoryRouter><Dashboard /></MemoryRouter>);
};

describe('the Dashboard and a paused assignment', () => {
  it('says new buy orders are paused, what it means, and what to do', async () => {
    show({ assignmentPausedAt: '2026-10-01T08:00:00Z' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/New buy orders are paused/i);
    expect(alert).toHaveTextContent(/not a suspension/i);
    expect(alert).toHaveTextContent(/contact support/i);
    expect(screen.getByText(/Online · New orders paused/)).toBeInTheDocument();
    expect(screen.queryByText(/Online · Accepting orders/)).not.toBeInTheDocument();
  });

  it('says nothing of the kind to a merchant who is not paused (the opposite case)', async () => {
    show({ assignmentPausedAt: null });
    expect(await screen.findByText(/Online · Accepting orders/)).toBeInTheDocument();
    expect(screen.queryByText(/New buy orders are paused/i)).not.toBeInTheDocument();
  });
});
