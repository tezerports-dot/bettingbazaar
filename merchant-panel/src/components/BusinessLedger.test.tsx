// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The business ledger (owner, 2026-10-21): the server's totals block, one
 * labelled table per kind with the transaction ID last, the range asked of
 * the server, the Excel download, and a refusal said in the server's words.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import BusinessLedger from './BusinessLedger';

vi.mock('../services/api', () => ({
  api: { getBusinessLedger: vi.fn(), downloadBusinessLedger: vi.fn() },
}));
import { api } from '../services/api';
const mocked = api as unknown as { getBusinessLedger: ReturnType<typeof vi.fn>; downloadBusinessLedger: ReturnType<typeof vi.fn> };


const LEDGER = {
  success: true, range: { from: null, to: null }, truncated: false,
  buys: [{ orderId: 'DEP_1', at: '2026-10-05T10:00:00Z', tokensPaise: 5_000_000, state: 'COMPLETED', rail: 'UPI / bank', account: 'Shop HDFC' }],
  sells: [{ orderId: 'WD_1', at: '2026-10-05T11:00:00Z', tokensPaise: 1_000_000, state: 'PAID', rail: 'UPI / bank', account: null }],
  commission: [{ commissionId: 'tc_1', at: '2026-10-05T12:00:00Z', role: 'MEMBER', team: 'Alpha', sharePaise: 42_000 }],
  pool: [{ requestId: 'tpr_1', at: '2026-10-04T09:00:00Z', direction: 'BUY', team: 'Alpha', tokensPaise: 10_000_000, currency: 'INR', amountMinor: 10_000_000, inrPaise: 10_000_000 }],
  disputes: [{ orderId: 'WD_9', at: '2026-10-05T13:00:00Z', type: 'SELL', tokensPaise: 500_000, state: 'COMPLETED', decision: 'FAVOR_USER', lostBy: 'MERCHANT', compensationPaise: 25_000 }],
  totals: {
    boughtPaise: 10_000_000, paidToAdminPaise: 10_000_000, returnedPaise: 0, receivedFromAdminPaise: 0, netWithAdminPaise: 10_000_000,
    userBuys: 1, userBuysPaise: 5_000_000, userSells: 1, userSellsPaise: 1_000_000, netUserPaise: 4_000_000,
    commissionPaise: 42_000, compensationPaise: 25_000, netCommissionPaise: 17_000, netProfitPaise: 17_000,
    pools: 1, poolAvailablePaise: 4_000_000, poolHeldPaise: 1_000_000,
  },
};

beforeEach(() => { mocked.getBusinessLedger.mockReset(); mocked.downloadBusinessLedger.mockReset(); });

describe('BusinessLedger', () => {
  it("shows the server's totals and each kind in its own table, the transaction ID last", async () => {
    mocked.getBusinessLedger.mockResolvedValue(LEDGER);
    render(<BusinessLedger />);
    const totals = await screen.findByRole('region', { name: 'Totals' });
    expect(within(totals).getByText('Net profit')).toBeInTheDocument();
    expect(within(totals).getByText('Net commission')).toBeInTheDocument();
    expect(within(totals).getByText('Pool tokens now')).toBeInTheDocument();
    for (const name of ['Player buys', 'Player sells', 'Commission', 'Pool tokens bought from and returned to the platform', 'Disputes']) {
      const table = screen.getByRole('table', { name });
      const headers = within(table).getAllByRole('columnheader');
      expect(headers[headers.length - 1]).toHaveTextContent('Transaction ID');
    }
    expect(within(screen.getByRole('table', { name: 'Player buys' })).getByText('DEP_1')).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'Player sells' })).getByText('Paid, in hold window')).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'Disputes' })).getByText('Merchant')).toBeInTheDocument();
    expect(mocked.getBusinessLedger).toHaveBeenCalledWith('', '');
  });

  it('asks the server for the range typed, and downloads that range', async () => {
    mocked.getBusinessLedger.mockResolvedValue(LEDGER);
    mocked.downloadBusinessLedger.mockResolvedValue(undefined);
    render(<BusinessLedger />);
    await screen.findByRole('region', { name: 'Totals' });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-07' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show ledger' }));
    await waitFor(() => expect(mocked.getBusinessLedger).toHaveBeenLastCalledWith('2026-10-01', '2026-10-07'));
    fireEvent.click(screen.getByRole('button', { name: /Download ledger/ }));
    await waitFor(() => expect(mocked.downloadBusinessLedger).toHaveBeenCalledWith('2026-10-01', '2026-10-07'));
  });

  it("says a refusal in the server's words", async () => {
    mocked.getBusinessLedger.mockRejectedValue(new Error('Reports need the AUDIT role.'));
    render(<BusinessLedger />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Reports need the AUDIT role.');
  });
});
