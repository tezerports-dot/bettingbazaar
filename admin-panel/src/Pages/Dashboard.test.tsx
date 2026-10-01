// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The dashboard's KPI row shows TODAY, as its captions say.
 *
 * Measured 2026-10-01 while comparing the analytics screens with the rows
 * behind them: "Bets Today" showed the ALL-TIME bet count — including the
 * house's phantom bets — and "Net Revenue" and "Total Payouts", both captioned
 * "today", showed all-time totals. The route already sent today's figures
 * (`finance.today`, the chart's last IST bucket); the panel's type did not
 * declare them, so nothing read them.
 *
 * The fixture gives today and all-time DIFFERENT values on purpose: a test
 * whose two windows agree cannot tell which one a tile is reading.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', () => ({
  default: {
    analytics: {
      getDashboard: vi.fn().mockResolvedValue({
        success: true,
        data: {
          users: { total: 10, active: 9, blocked: 1, kycPending: 0 },
          merchants: { total: 3, active: 2, pending: 0, online: 2 },
          finance: {
            totalDeposits: 500000, totalWithdrawals: 100000,
            totalBets: 987654, totalPayouts: 555555, netProfit: 432099,
            today: { bets: 7000, betCount: 7, payouts: 3000, deposits: 2000, netProfit: 4000 },
          },
          cycles: { activeCount: 3, todayCount: 40, totalBets: 9999 },
          queue: { pendingOrders: 0, avgWaitTime: 0 },
          dailyReport: [],
        },
      }),
    },
    cycles: { getActive: vi.fn().mockResolvedValue({ success: true, data: [] }) },
    system: { getAuditLogs: vi.fn().mockResolvedValue({ success: true, data: [] }) },
  },
}));

import { Dashboard } from './Dashboard';

/** The value printed under a KPI label — the KPI row is the first place each label appears. */
const tile = async (label: string) => {
  const [name] = await screen.findAllByText(label);
  return name.parentElement?.parentElement?.textContent ?? '';
};

describe('the dashboard KPI row', () => {
  it('shows today\'s player bets, not the all-time count with phantom bets in it', async () => {
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    const bets = await tile('Bets Today');
    expect(bets).toContain('7');
    expect(bets).not.toContain('9,999');
  });

  it('shows today\'s net and payouts under their "today" captions', async () => {
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    // `inr` abbreviates: 4,000 is ₹4.0k, 4,32,099 is ₹4.32L.
    const net = await tile('Net Revenue');
    expect(net).toContain('₹4.0k');
    expect(net).not.toContain('₹4.32L');
    const payouts = await tile('Total Payouts');
    expect(payouts).toContain('₹3.0k');
    expect(payouts).not.toContain('₹5.56L');
  });

  it('keeps the all-time figures, labelled all time, in the Financial Overview', async () => {
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    expect(await screen.findByText(/Net Revenue = Total Bets − Payouts · all time/)).toBeInTheDocument();
    expect(screen.getAllByText('₹9.88L').length).toBeGreaterThan(0);
  });
});
