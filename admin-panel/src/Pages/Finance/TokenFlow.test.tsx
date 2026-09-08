// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * Token Flow reaches all four endpoints, and keeps the three flows apart.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * These four endpoints were built, tested, merged and unreachable — no screen
 * called any of them. That is the failure this suite guards: not "does the
 * handler work" (a route test answers that) but "does anything ask it".
 *
 * The separation is the other half. deposit-dashboard counts ONLY player INR →
 * token buys; merchant-funding counts the operator's own float. Summing them
 * inflates player volume with the platform's own money — a number that
 * flatters and answers nothing. A test that only checked totals rendered would
 * pass on a page that added them together, so the assertion here is that the
 * merchant figure never appears inside the player section.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../services/api', () => ({ default: { get } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { TokenFlow } from './TokenFlow';

const DEPOSITS = {
  totalINRDeposited: 125000, totalTokensPurchased: 125000,
  numberOfBuyers: 42, transactionCount: 57,
  dailyBreakdown: [
    { date: '2026-01-01', tokens: 50000, count: 20 },
    { date: '2026-01-02', tokens: 75000, count: 37 },
  ],
};
const WITHDRAWALS = {
  totalTokensSold: 40000, totalINRWithdrawn: 40000,
  numberOfSellers: 11, transactionCount: 13,
  dailyBreakdown: [{ date: '2026-01-02', tokens: 40000, count: 13 }],
};
const FUNDING = {
  merchantTopup: 900000, merchantReserve: 300000,
  merchantLiquidity: 100000, activeMerchants: 6,
};
const TRENDS = {
  growth: {
    signups: [{ day: '2026-01-01', count: 9 }, { day: '2026-01-02', count: 14 }],
    firstTimeDepositors: [{ day: '2026-01-01', count: 3 }, { day: '2026-01-02', count: 5 }],
  },
};

beforeEach(() => {
  get.mockReset();
  get.mockImplementation((url: string) => {
    if (url.includes('deposit-dashboard'))    return Promise.resolve({ data: { success: true, data: DEPOSITS } });
    if (url.includes('withdrawal-dashboard')) return Promise.resolve({ data: { success: true, data: WITHDRAWALS } });
    if (url.includes('merchant-funding'))     return Promise.resolve({ data: { success: true, data: FUNDING } });
    if (url.includes('analytics/trends'))     return Promise.resolve({ data: { success: true, trends: TRENDS } });
    return Promise.resolve({ data: { success: true } });
  });
});

const called = (fragment: string) => get.mock.calls.some(([u]) => String(u).includes(fragment));

describe('Token Flow reaches every endpoint it exists for', () => {
  it('calls all four on mount', async () => {
    render(<TokenFlow />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(4));
    for (const fragment of [
      '/api/admin/analytics/deposit-dashboard',
      '/api/admin/analytics/withdrawal-dashboard',
      '/api/admin/analytics/merchant-funding',
      '/api/admin/analytics/trends',
    ]) {
      expect(called(fragment), `${fragment} must be called`).toBe(true);
    }
  });

  it('passes the trend window through as days', async () => {
    render(<TokenFlow />);
    await waitFor(() => expect(called('analytics/trends')).toBe(true));
    const call = get.mock.calls.find(([u]) => String(u).includes('analytics/trends'));
    expect(call?.[1]).toMatchObject({ params: { days: 30 } });
  });

  it('survives one endpoint failing without losing the others', async () => {
    // Promise.allSettled, not Promise.all: merchant funding going down must not
    // blank the player figures, which is what a rejected Promise.all would do.
    get.mockImplementation((url: string) => {
      if (url.includes('merchant-funding')) return Promise.reject(new Error('down'));
      if (url.includes('deposit-dashboard')) return Promise.resolve({ data: { success: true, data: DEPOSITS } });
      return Promise.resolve({ data: { success: true, data: WITHDRAWALS, trends: TRENDS } });
    });
    render(<TokenFlow />);
    expect(await screen.findByText('42')).toBeInTheDocument();   // buyers still rendered
  });
});

describe('the three flows stay apart', () => {
  it('never shows merchant float inside the player sections', async () => {
    render(<TokenFlow />);
    await screen.findByText('42');

    // Scoped to the TILE by its own label, and asserted as the EXACT figure.
    // Absence alone is too weak: adding the two produces a THIRD value
    // (₹10,25,000) matching neither input, so "the merchant number is not here"
    // passes on a page that summed them. Only pinning the number catches it.
    const inrTile = screen.getByText('INR received').closest('div')!;
    expect(within(inrTile).getByText('₹1,25,000')).toBeInTheDocument();

    // And it IS shown, in its own section.
    expect(screen.getByText('Merchant funding')).toBeInTheDocument();
    expect(screen.getByText('Active merchants')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
  });

  it('labels each section with what it excludes', async () => {
    render(<TokenFlow />);
    await screen.findByText('42');
    expect(screen.getByText(/Merchant funding is excluded/)).toBeInTheDocument();
    expect(screen.getByText(/Never part of player volume/)).toBeInTheDocument();
  });

  it('renders the daily breakdown, not just the totals', async () => {
    render(<TokenFlow />);
    // findAllByText, not findByText: the same day labels the deposit bars and
    // the growth series, so a single-match query fails on a correct page.
    expect((await screen.findAllByText('2026-01-01')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ord$/).length).toBeGreaterThan(0);
    // The per-day figure, not only the section total.
    expect(screen.getAllByText('₹50,000').length).toBeGreaterThan(0);
  });
});
