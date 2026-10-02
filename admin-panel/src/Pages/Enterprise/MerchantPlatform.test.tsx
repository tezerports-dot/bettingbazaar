// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The Merchant Platform console: the leaderboard, and one merchant opened
 * from it.
 *
 * A merchant holds no tokens (PROJECT_STATUS §3.10, 2c) — their team's pool
 * does — so this screen asks for no wallet ledger and shows no wallet, no admin
 * top-up and no commission engine. Those routes were removed; a call to any of
 * them would 404 into an empty state that reads like "no data".
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const { get, put, post } = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock('../../services/api', () => ({ default: { get, put, post } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { MerchantPlatform } from './MerchantPlatform';

beforeEach(() => {
  get.mockReset(); put.mockReset(); post.mockReset();
});

/**
 * One merchant, opened from the leaderboard.
 *
 * Three things are asserted because none shows in a screenshot of the happy
 * path: a USDT merchant's volume is labelled USDT (trap 15's display mouth),
 * one read failing does not blank the other, and nothing asks for the removed
 * wallet ledger or commission routes.
 */
describe('a merchant opened from the leaderboard', () => {
  // Exactly what stats.merchantLeaderboard and merchantAnalytics.service send.
  const ROW = { merchantId: 'MRC-1', username: 'ravi', completedOrders: 3, totalOrders: 4, completedVolume: 2200, isOnline: true };
  const STATS = {
    currency: 'INR',
    depositsCompleted: 2, depositVolume: 1500, withdrawalsCompleted: 1, withdrawalVolume: 700,
    matchedCycleVolume: 700,
    bonusesIssued: 0, bonusTotal: 0,
    successRate: 0.875, avgResponseMinutes: 4.25,
  };
  const HISTORY_ROWS = [
    { day: '2026-09-30', totalOrders: 0, totalVolume: 0, byType: [] },
    { day: '2026-10-01', totalOrders: 3, totalVolume: 2200, byType: [] },
  ];

  const routes = (over: Record<string, () => Promise<unknown>> = {}) => (url: string) => {
    for (const [frag, fn] of Object.entries(over)) if (url.includes(frag)) return fn();
    if (url.includes('merchant-platform/leaderboard')) return Promise.resolve({ data: { success: true, leaderboard: [ROW] } });
    if (url.includes('funding-stats')) return Promise.resolve({ data: { success: true, stats: STATS } });
    if (url.includes('performance-history')) return Promise.resolve({ data: { success: true, days: 30, history: HISTORY_ROWS } });
    return Promise.reject(new Error(`unexpected route ${url}`));
  };

  const open = async () => {
    render(<MerchantPlatform />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open ravi' }));
    return screen.findByLabelText('Merchant ravi');
  };

  it('ranks by completed volume in tokens, with no wallet column', async () => {
    get.mockImplementation(routes());
    render(<MerchantPlatform />);
    expect(await screen.findByText('2,200 BB')).toBeInTheDocument();
    expect(screen.getByText('3/4')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Wallet' })).not.toBeInTheDocument();
  });

  it('asks for the figures and the history for the selected period — and nothing removed', async () => {
    get.mockImplementation(routes());
    const panel = await open();
    await waitFor(() => {
      expect(get).toHaveBeenCalledWith('/api/admin/merchant-platform/MRC-1/funding-stats');
      expect(get).toHaveBeenCalledWith('/api/admin/merchant-platform/MRC-1/performance-history', { params: { days: 30 } });
    });
    const funding = await within(panel).findByLabelText('Funding');
    expect(funding).toHaveTextContent('2 · ₹1,500');
    expect(funding).toHaveTextContent('1 · ₹700');
    expect(funding).toHaveTextContent('Matched volume');
    expect(funding).toHaveTextContent('88%');
    expect(funding).not.toHaveTextContent(/Wallet|top-up|Commission/i);
    const days = within(panel).getByLabelText('Daily completed orders');
    expect(days).toHaveTextContent('2026-10-01');
    expect(days).toHaveTextContent('3 orders');
    // A day with nothing completed is not listed as a row of zeroes.
    expect(days).not.toHaveTextContent('2026-09-30');

    const asked = get.mock.calls.map(([u]) => String(u));
    expect(asked.some((u) => /wallet-ledger|commission/.test(u))).toBe(false);
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('labels a USDT merchant’s volume in USDT, never in rupees', async () => {
    get.mockImplementation(routes({
      'funding-stats': () => Promise.resolve({ data: { success: true, stats: { ...STATS, currency: 'USDT', depositVolume: 555.56, matchedCycleVolume: 555.56 } } }),
    }));
    const panel = await open();
    const funding = await within(panel).findByLabelText('Funding');
    await waitFor(() => expect(funding).toHaveTextContent('555.56 USDT'));
    expect(funding).not.toHaveTextContent('₹555.56');
  });

  it('says the figures failed to load, and still shows the history', async () => {
    get.mockImplementation(routes({ 'funding-stats': () => Promise.reject(new Error('down')) }));
    const panel = await open();
    expect(await within(panel).findByRole('alert')).toHaveTextContent("Could not load this merchant's figures.");
    expect(await within(panel).findByText('3 orders')).toBeInTheDocument();
  });
});
