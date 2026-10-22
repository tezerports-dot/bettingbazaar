// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The owner dashboard reads the server's figures for the period picked, shows
 * the three ledgers, and offers the weekly settlement to a full admin only.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
const render = (ui: React.ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);

const { get, post, put, perms } = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(), perms: { isAdmin: false },
}));
vi.mock('../../services/api', () => ({
  default: { get, post, put },
  downloadFile: vi.fn(),
  cleanParams: (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null)),
}));
vi.mock('../../hooks/usePermission', () => ({ usePermissions: () => ({ can: () => false, isAdmin: perms.isAdmin }) }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { OwnerDashboard } from './OwnerDashboard';

const DASH = {
  success: true,
  stats: {
    buys: { count: 3, tokens: 3000 }, sells: { count: 1, tokens: 500 }, merchantCommission: 175,
    newPlayers: 2, registeredPlayers: 40, vipPlayers: 30, generalPlayers: 10,
    activePlayers: { vip: 5, general: 4 }, referralBonusGiven: 100, firstTimeDepositors: 1, depositors: 3, weeklyDepositors: 6,
  },
  vip: {
    revenue: { cycleSides: 9000, winningFees: 450, rounds: 12, casino: 0, cricket: 0, usdtCommissionKept: 50, total: 9500 },
    rtp: { setAside: 20, balanceNow: 300 },
    costs: { merchantCommission: 175, claimedGeneralBonuses: 25, total: 200 },
    netProfit: 9300, ownerWithdrawn: 0, rates: { depositPercent: 5, withdrawalPercent: 5 },
  },
  general: {
    granted: { referral: { amount: 100, count: 2 }, firstDeposit: { amount: 50, count: 1 }, total: 150 },
    playWonBack: { amount: 30, rounds: 8 }, claimed: 25, outstandingNow: 90, openGrantsNow: { count: 2, amount: 80 },
  },
  online: { now: 14, peak: { players: 20, at: '2026-10-22T05:00:00Z' }, allTimePeak: { players: 31, at: '2026-10-20T15:00:00Z' } },
};
const MERCHANTS = {
  success: true,
  merchants: [{ teamId: 't1', name: 'Raj Pay', kind: 'DIRECT', owner: null, tokensNow: 5000, heldNow: 0, buys: 3, buyTokens: 3000, sells: 1, sellTokens: 500, volume: 3500, commission: 175 }],
  totals: { buys: 3, buyTokens: 3000, sells: 1, sellTokens: 500, volume: 3500, commission: 175, tokensNow: 5000 },
  top: { name: 'Raj Pay', volume: 3500 },
};
const SETTLE = {
  success: true, schedule: { weekStartsAt: '2026-10-12T04:30:00Z' },
  weeks: [{ weekStart: '2026-10-19T04:30:00Z', weekEnd: '2026-10-26T04:30:00Z', complete: false, netProfit: 100, withdrawn: 0 }],
  currentWeek: { weekStart: '2026-10-19T04:30:00Z', weekEnd: '2026-10-26T04:30:00Z', netProfit: 100 },
  completedNetProfit: 9000, withdrawnTotal: 1000, rtpHeldBack: 300, claimable: 7700, settlements: [],
};

beforeEach(() => {
  get.mockReset(); post.mockReset(); put.mockReset();
  get.mockImplementation((url: string) => Promise.resolve({ data:
    url.includes('owner/dashboard') ? DASH
      : url.includes('merchant-ledger') ? MERCHANTS
        : url.includes('owner/settlements') ? SETTLE
          : { success: true, supply: 100, accountedFor: true, kinds: [] } }));
  post.mockResolvedValue({ data: { success: true } });
});

describe('OwnerDashboard', () => {
  it('shows the figures and the three ledgers, and no settlement to analytics staff', async () => {
    perms.isAdmin = false;
    render(<OwnerDashboard />);
    expect(await screen.findByText('VIP revenue ledger')).toBeTruthy();
    expect(screen.getByText('Merchant ledger')).toBeTruthy();
    expect(screen.getByText('General bonus ledger')).toBeTruthy();
    expect(screen.getByText('Commission kept on USDT orders')).toBeTruthy();
    expect(screen.getByText('Peak online (ever)')).toBeTruthy();
    expect(screen.queryByText('Weekly profit settlement')).toBeNull();
    expect(get.mock.calls.some(([u]) => String(u).includes('owner/settlements'))).toBe(false);
  });

  it('asks the server for the period picked', async () => {
    perms.isAdmin = false;
    render(<OwnerDashboard />);
    await screen.findByText('VIP revenue ledger');
    fireEvent.click(screen.getByRole('button', { name: 'All time' }));
    await waitFor(() => expect(get.mock.calls.some(([u, o]) =>
      String(u).includes('owner/dashboard') && Object.keys(o?.params ?? {}).length === 0)).toBe(true));
  });

  it('a full admin sees what is claimable and records a withdrawal', async () => {
    perms.isAdmin = true;
    render(<OwnerDashboard />);
    expect(await screen.findByText('Weekly profit settlement')).toBeTruthy();
    expect(screen.getByText('You can claim now')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Amount taken out (₹)'), { target: { value: '2500' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'week 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record withdrawal' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/admin/owner/settlements', { amount: 2500, note: 'week 1' }));
  });
});
