// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The pool statement on Reports (owner, 2026-10-22): the presets ask the
 * server for the right IST days, the figures and rows are the server's, and
 * an agent (no balance) is shown no balance lines.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ getPoolStatement: vi.fn(), downloadPoolStatement: vi.fn() }));
vi.mock('../services/api', () => ({ api }));

import PoolStatement, { istToday, presetRange } from './PoolStatement';

const totals = {
  openingPaise: 10_000_000, closingPaise: 15_100_000, buysProcessed: 1, buysProcessedPaise: 500_000,
  sellsProcessed: 1, sellsProcessedPaise: 1_000_000, commissionPaise: 100_000, tokensBoughtPaise: 0, netProfitPaise: 100_000,
};
const row = (o: Record<string, unknown>) => ({
  ref: 'o-1', at: '2026-10-22T06:00:00Z', userId: 'u-1', utr: '123456789012', state: 'COMPLETED',
  tokensPaise: 500_000, poolChangePaise: -500_000, commissionPaise: 25_000, balanceAfterPaise: 9_525_000, team: 'Mine', ...o,
});

beforeEach(() => { api.getPoolStatement.mockReset(); });

describe('the pool statement', () => {
  it('works out today, this week (from Monday) and this month in IST', () => {
    // Wednesday 22 October 2026, 23:00 IST = 17:30 UTC.
    const now = Date.parse('2026-10-22T17:30:00Z');
    expect(istToday(now)).toBe('2026-10-22');
    // 19:00 UTC is already the next IST day.
    expect(istToday(Date.parse('2026-10-22T19:00:00Z'))).toBe('2026-10-23');
    expect(presetRange('TODAY', now)).toEqual({ from: '2026-10-22', to: '2026-10-22' });
    expect(presetRange('WEEK', now)).toEqual({ from: '2026-10-19', to: '2026-10-22' });
    expect(presetRange('MONTH', now)).toEqual({ from: '2026-10-01', to: '2026-10-22' });
  });

  it('shows the opening and closing balance and every order with its commission and pool change', async () => {
    api.getPoolStatement.mockResolvedValue({
      range: { from: '2026-10-22', to: '2026-10-22' }, pools: [], truncated: false, totals,
      rows: [row({}), row({ ref: 'o-2', kind: 'SELL', state: 'DISPUTED', poolChangePaise: 0, commissionPaise: 0 })].map((r, i) => ({ kind: i ? 'SELL' : 'BUY', ...r })),
    });
    render(<PoolStatement />);
    expect(await screen.findByText('Opening pool balance')).toBeInTheDocument();
    expect(screen.getByText('Closing pool balance')).toBeInTheDocument();
    expect(screen.getByText('Opening balance')).toBeInTheDocument();
    expect(screen.getByText('Closing balance')).toBeInTheDocument();
    expect(screen.getAllByText('123456789012', { selector: 'td' })).toHaveLength(2);
    expect(screen.getByText('Disputed')).toBeInTheDocument();
    expect(screen.getByText('+250 BB')).toBeInTheDocument();
    expect(screen.getByText('−5,000 BB')).toBeInTheDocument();
    expect(api.getPoolStatement).toHaveBeenCalledWith(istToday(), istToday());
  });

  it('draws no balance for an agent, and a custom range waits for its button', async () => {
    api.getPoolStatement.mockResolvedValue({
      range: { from: null, to: null }, pools: [], truncated: false, rows: [],
      totals: { ...totals, openingPaise: null, closingPaise: null },
    });
    render(<PoolStatement />);
    expect(await screen.findByText('Commission earned')).toBeInTheDocument();
    expect(screen.queryByText('Opening pool balance')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Custom range' }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-10' } });
    expect(api.getPoolStatement).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Show statement' }));
    await waitFor(() => expect(api.getPoolStatement).toHaveBeenLastCalledWith('2026-10-01', '2026-10-10'));
  });
});
