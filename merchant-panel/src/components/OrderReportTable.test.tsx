// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The order report table (owner, 2026-10-16): a row per order with
 * transaction ID, user, UTR, amount, time and ✓/✗ with who pressed it; the
 * totals are the server's (every row of the range, not the page); paging,
 * the direction filter and the CSV each ask the server; a refusal is said.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OrderReportTable from './OrderReportTable';

vi.mock('../services/api', () => ({
  api: { getOrderReport: vi.fn(), downloadOrderReportCsv: vi.fn() },
}));
import { api } from '../services/api';
const mocked = api as unknown as { getOrderReport: ReturnType<typeof vi.fn>; downloadOrderReportCsv: ReturnType<typeof vi.fn> };

const row = (over: Record<string, unknown>) => ({
  orderId: 'DEP_1', type: 'DEPOSIT', userId: 'u_1', utr: '612345678901', tokenAmount: 50000,
  state: 'COMPLETED', result: 'CONFIRMED', actedBy: { kind: 'MERCHANT', name: 'You' }, at: '2026-10-05T10:00:00Z', ...over,
});
const page = (rows: unknown[], total = rows.length) => ({
  success: true, range: { from: null, to: null }, rows,
  totals: { orders: total, confirmed: 70, rejected: 3, confirmedBuyPaise: 1_234_500, confirmedSellPaise: 0 },
  pagination: { total, limit: 50, skip: 0 },
});

beforeEach(() => { mocked.getOrderReport.mockReset(); mocked.downloadOrderReportCsv.mockReset(); });

describe('OrderReportTable', () => {
  it('draws each order with ✓/✗ and who pressed it, and the server\'s totals', async () => {
    mocked.getOrderReport.mockResolvedValue(page([
      row({}),
      row({ orderId: 'DEP_2', result: 'REJECTED', state: 'REJECTED', actedBy: { kind: 'STAFF', name: 'Desk 2' } }),
      row({ orderId: 'WD_3', type: 'WITHDRAWAL', utr: null, result: 'NONE', state: 'CANCELLED', actedBy: null }),
    ], 120));
    render(<OrderReportTable />);
    expect(await screen.findByText('DEP_1')).toBeInTheDocument();
    for (const h of ['Transaction ID', 'User', 'UTR', 'Amount', 'Time', '✓ / ✗']) {
      expect(screen.getByRole('columnheader', { name: h })).toBeInTheDocument();
    }
    expect(screen.getByLabelText('Confirmed')).toHaveTextContent('✓');
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByLabelText('Rejected')).toHaveTextContent('✗');
    expect(screen.getByText('Desk 2')).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    // Totals are the server's, over all 120 rows, not the three drawn.
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('120 orders');
    expect(status).toHaveTextContent('✓ 70');
    expect(status).toHaveTextContent('✗ 3');
  });

  it('pages and filters through the server', async () => {
    mocked.getOrderReport.mockResolvedValue(page([row({})], 120));
    render(<OrderReportTable from="2026-10-01" to="2026-10-07" />);
    await screen.findByText('DEP_1');
    expect(mocked.getOrderReport).toHaveBeenLastCalledWith({ from: '2026-10-01', to: '2026-10-07', type: '' }, { limit: 50, skip: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(mocked.getOrderReport).toHaveBeenLastCalledWith(
      { from: '2026-10-01', to: '2026-10-07', type: '' }, { limit: 50, skip: 50 }));
    fireEvent.click(screen.getByRole('button', { name: 'Sells' }));
    await waitFor(() => expect(mocked.getOrderReport).toHaveBeenLastCalledWith(
      { from: '2026-10-01', to: '2026-10-07', type: 'WITHDRAWAL' }, { limit: 50, skip: 0 }));
  });

  it('downloads the CSV from the server and says a refusal', async () => {
    mocked.getOrderReport.mockResolvedValue(page([row({})]));
    mocked.downloadOrderReportCsv.mockRejectedValue(new Error('A report covers at most 366 days.'));
    render(<OrderReportTable />);
    await screen.findByText('DEP_1');
    fireEvent.click(screen.getByRole('button', { name: /Download CSV/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A report covers at most 366 days.');
    expect(mocked.downloadOrderReportCsv).toHaveBeenCalledWith({ from: '', to: '', type: '' });
  });
});
