// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Payments: one page, a switch between agents' teams and merchants (owner,
 * 2026-10-14). Each side shows its own kind of pool request, fulfilled on the
 * row pressed with the payment typed on THAT row (§23), the server's refusal
 * verbatim (§32 S14), and each part only to staff holding its area.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

const { teams, merchants, perms } = vi.hoisted(() => ({
  teams: {
    list: vi.fn(), poolRequests: vi.fn(),
    fulfilPoolRequest: vi.fn(), rejectPoolRequest: vi.fn(),
  },
  merchants: { listMerchantAccounts: vi.fn(), listMerchantFlags: vi.fn(), makeMerchantAccount: vi.fn() },
  perms: { fund: true, teams: true, merchants: true },
}));
vi.mock('../../services/api', () => ({ default: { teams, merchants } }));
vi.mock('../../hooks/usePermission', () => ({
  usePermissions: () => ({
    can: (k: string) => (k === 'canFundMerchants' ? perms.fund : k === 'canManageTeams' ? perms.teams : k === 'canManageMerchants' ? perms.merchants : false),
  }),
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { PaymentsPage } from './PaymentsPage';
import toast from 'react-hot-toast';

const request = (over: Record<string, unknown>) => ({
  supervisorId: 's-1', supervisorName: 'Sup One', status: 'PENDING', note: null,
  decidedBy: null, decidedAt: null, decisionNote: null, createdAt: '', teamKind: 'AGENT', ...over,
});
const REQUESTS = [
  request({ requestId: 'pr-1', teamId: 't-1', teamName: 'Alpha', direction: 'BUY', tokenAmountPaise: 150000 }),
  request({ requestId: 'pr-2', teamId: 't-2', teamName: 'Bravo', direction: 'SELL', tokenAmountPaise: 40000 }),
  request({ requestId: 'pr-3', teamId: 'TD-1', teamName: 'Shop Direct', direction: 'BUY', tokenAmountPaise: 90000, teamKind: 'DIRECT' }),
];
const TEAM = {
  teamId: 't-1', supervisorId: 's-1', supervisorName: 'Sup One', supervisorRef: 'MSUP1', name: 'Alpha',
  rail: 'UPI_BANK', approvedCount: 3, pendingCount: 0, size: 10, strength: 'WORKING', createdAt: '',
  poolAvailablePaise: 700_000, poolHeldPaise: 0, poolExposure: null,
  commission: { teamId: 't-1', buysPaise: 0, sellsPaise: 0, matchedPaise: 0, highPaise: 0, paidPaise: 12_000, owedPaise: 0, commissionPercent: 10, supervisorSharePercent: 16 },
};
const DIRECT = {
  teamId: 'TD-1', ownerMerchantId: 'MRC-9', ownerName: 'shop', ownerRef: 'M9', ownerStatus: 'ACTIVE', ownerOnline: true,
  name: 'Shop Direct', poolAvailablePaise: 250000, poolHeldPaise: 50000,
  commission: { paidPaise: 1000, owedPaise: 0, commissionPercent: 10 },
  accounts: [{ accountId: 'mpa_1', kind: 'UPI_QR', label: 'Counter', upiId: 'shop@okhdfc', bankName: 'HDFC', accountNo: '123456789012', acceptsDeposits: true, paysWithdrawals: false, status: 'ACTIVE' }],
  staff: [{ staffId: 'mst_1', name: 'Asha', mobile: '9876500000', roles: ['DEPOSITS', 'AUDIT'], status: 'ACTIVE' }],
  problemDays: [],
};

const renderAt = (path = '/payments') => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/payments" element={<PaymentsPage />} />
      <Route path="/merchants/:merchantId" element={<p>merchant page</p>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(perms, { fund: true, teams: true, merchants: true });
  teams.list.mockResolvedValue({ success: true, teams: [TEAM], supervisors: [], members: [] });
  teams.poolRequests.mockResolvedValue({ success: true, requests: REQUESTS });
  teams.fulfilPoolRequest.mockResolvedValue({ success: true, message: 'Sold' });
  teams.rejectPoolRequest.mockResolvedValue({ success: true });
  merchants.listMerchantAccounts.mockResolvedValue({ success: true, merchantAccounts: [DIRECT] });
  merchants.listMerchantFlags.mockResolvedValue({ success: true, flags: [{ id: 1, merchantId: 'MRC-9', merchantName: 'shop', day: '2026-10-10', problemCount: 6, threshold: 5 }] });
});

describe('Payments, agents\' teams side', () => {
  it('shows only agents\' teams\' requests, and each team\'s pool', async () => {
    renderAt();
    expect(await screen.findByRole('button', { name: /Sell 1,500 tokens to Alpha/ })).toBeInTheDocument();
    expect(screen.queryByText(/Shop Direct/)).toBeNull();
    expect(await screen.findByText('7,000 tokens')).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument(); // commission paid
  });

  it('fulfils the request on the row pressed, with the payment typed on THAT row', async () => {
    renderAt();
    fireEvent.change((await screen.findAllByLabelText('Platform received'))[0], { target: { value: '1500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sell 1,500 tokens to Alpha' }));
    await waitFor(() => expect(teams.fulfilPoolRequest).toHaveBeenCalledWith('pr-1', { settlementCurrency: 'INR', settlementAmount: 1500 }));
    expect(teams.fulfilPoolRequest).toHaveBeenCalledTimes(1);
    // The pools re-read after the request moved one.
    await waitFor(() => expect(teams.list).toHaveBeenCalledTimes(2));
  });

  it('cannot fulfil with no payment typed, and an old buyback can only be rejected', async () => {
    renderAt();
    expect(await screen.findByRole('button', { name: /Sell 1,500 tokens to Alpha/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /tokens back from Bravo/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Sell back \(no longer allowed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject request from Bravo' })).toBeEnabled();
  });

  it('shows the server\'s refusal verbatim', async () => {
    teams.fulfilPoolRequest.mockRejectedValueOnce({ response: { data: { message: 'The pool holds fewer tokens than that.' } } });
    renderAt();
    fireEvent.change(await screen.findByLabelText('Platform received'), { target: { value: '1500' } });
    fireEvent.click(screen.getByRole('button', { name: /Sell 1,500 tokens to Alpha/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The pool holds fewer tokens than that.'));
  });

  it('rejects with the reason typed on the row', async () => {
    renderAt();
    fireEvent.change((await screen.findAllByLabelText('Reason (if rejecting)'))[0], { target: { value: 'No payment seen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject request from Alpha' }));
    await waitFor(() => expect(teams.rejectPoolRequest).toHaveBeenCalledWith('pr-1', 'No payment seen'));
  });

  it('opens the supervisor from a team\'s pool row', async () => {
    renderAt();
    fireEvent.click((await screen.findByText('7,000 tokens')).closest('tr')!);
    expect(await screen.findByText('merchant page')).toBeInTheDocument();
  });

  it('staff without the money area never see, or load, the request queue', async () => {
    perms.fund = false;
    renderAt();
    expect(await screen.findByText('7,000 tokens')).toBeInTheDocument();
    expect(screen.queryByText('Pool token requests')).toBeNull();
    expect(teams.poolRequests).not.toHaveBeenCalled();
  });
});

describe('Payments, merchants side', () => {
  it('switches to merchants: their requests, pools, payment accounts and flags, never a sub-member\'s mobile', async () => {
    renderAt();
    await screen.findByRole('button', { name: /Sell 1,500 tokens to Alpha/ });
    fireEvent.click(screen.getByRole('button', { name: 'Merchants' }));

    expect(await screen.findByRole('button', { name: /Sell 900 tokens to Shop Direct/ })).toBeInTheDocument();
    expect(screen.queryByText(/to Alpha/)).toBeNull();
    const card = await screen.findByRole('article', { name: 'Shop Direct' });
    expect(card).toHaveTextContent('Pool: 2,500 tokens · 500 held');
    expect(card).toHaveTextContent('Asha · Deposits, Audit');
    expect(card).toHaveTextContent('Counter · UPI scanner');
    expect(screen.queryByText(/9876500000/)).toBeNull();
    expect(screen.getByRole('table', { name: 'Merchant flags' })).toHaveTextContent('6 / 5');
    expect(teams.list).toHaveBeenCalledTimes(1); // the agents' pools are not re-read on this side
  });

  it('opens on the merchants side from a link', async () => {
    renderAt('/payments?side=merchants');
    expect(await screen.findByRole('article', { name: 'Shop Direct' })).toBeInTheDocument();
    expect(teams.list).not.toHaveBeenCalled();
  });

  it('shows staff without the merchants area no merchant accounts', async () => {
    perms.merchants = false;
    renderAt('/payments?side=merchants');
    expect(await screen.findByRole('button', { name: /Sell 900 tokens to Shop Direct/ })).toBeInTheDocument();
    expect(merchants.listMerchantAccounts).not.toHaveBeenCalled();
  });
});
