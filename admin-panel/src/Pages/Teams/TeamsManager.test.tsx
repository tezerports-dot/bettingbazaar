// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The admin Teams screen calls the route each control names, with the id of
 * the ROW it sits on (§23), and shows the server's refusal verbatim (§32 S14).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const listing = {
  success: true,
  supervisors: [{ merchantId: 's-1', name: 'Sup One', publicRef: 'MSUP1', rail: 'UPI_BANK', isOnline: true }],
  teams: [{ teamId: 't-1', supervisorId: 's-1', supervisorName: 'Sup One', supervisorRef: 'MSUP1', name: 'Alpha',
    rail: 'UPI_BANK', approvedCount: 1, pendingCount: 2, size: 10, strength: 'STOPPED', shortSince: null, wasFull: false, createdAt: '',
    poolAvailablePaise: 0, poolHeldPaise: 0,
    commission: { teamId: 't-1', buysPaise: 0, sellsPaise: 0, matchedPaise: 0, highPaise: 0, paidPaise: 0, owedPaise: 0,
      commissionPercent: 10, supervisorSharePercent: 16 } }],
  members: [
    { merchantId: 'm-1', teamId: 't-1', name: 'Asha', publicRef: 'MA', status: 'APPROVED', isOnline: false, addedBy: 's-1', addedAt: '', approvedBy: 'a', approvedAt: '' },
    { merchantId: 'm-2', teamId: 't-1', name: 'Bhanu', publicRef: 'MB', status: 'PENDING', isOnline: false, addedBy: 's-1', addedAt: '', approvedBy: null, approvedAt: null },
    { merchantId: 'm-3', teamId: 't-1', name: 'Chitra', publicRef: 'MC', status: 'PENDING', isOnline: false, addedBy: 's-1', addedAt: '', approvedBy: null, approvedAt: null },
  ],
};

const poolRequests = [
  { requestId: 'pr-1', teamId: 't-1', teamName: 'Alpha', supervisorId: 's-1', supervisorName: 'Sup One', direction: 'BUY',
    tokenAmountPaise: 150000, status: 'PENDING', note: null, decidedBy: null, decidedAt: null, decisionNote: null, createdAt: '' },
  { requestId: 'pr-2', teamId: 't-2', teamName: 'Bravo', supervisorId: 's-1', supervisorName: 'Sup One', direction: 'SELL',
    tokenAmountPaise: 40000, status: 'PENDING', note: null, decidedBy: null, decidedAt: null, decisionNote: null, createdAt: '' },
];

vi.mock('../../services/api', () => ({
  default: {
    teams: {
      list: vi.fn(),
      setSupervisor: vi.fn().mockResolvedValue({ success: true }),
      approveMember: vi.fn().mockResolvedValue({ success: true }),
      rejectMember: vi.fn().mockResolvedValue({ success: true }),
      removeMember: vi.fn().mockResolvedValue({ success: true }),
      poolRequests: vi.fn(),
      fulfilPoolRequest: vi.fn().mockResolvedValue({ success: true, message: 'Sold' }),
      rejectPoolRequest: vi.fn().mockResolvedValue({ success: true }),
      redFlags: vi.fn(),
    },
  },
}));
const perms = { fund: true };
vi.mock('../../hooks/usePermission', () => ({
  usePermissions: () => ({ can: (k: string) => (k === 'canFundMerchants' ? perms.fund : true) }),
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { TeamsManager } from './TeamsManager';
import api from '../../services/api';
import toast from 'react-hot-toast';

describe('admin Teams screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.teams.list as any).mockResolvedValue(listing);
    (api.teams.poolRequests as any).mockResolvedValue({ success: true, requests: poolRequests });
    (api.teams.redFlags as any).mockResolvedValue({ success: true, flags: [] });
    perms.fund = true;
  });

  // ── Red flags (Step 2f) ──────────────────────────────────────────────────
  it('shows a farming flag with its player pairs, and a low-activity flag with the member and the average', async () => {
    (api.teams.redFlags as any).mockResolvedValue({ success: true, flags: [
      { flagId: '1', kind: 'COMMISSION_FARMING', flagDay: '2026-10-03', teamId: 't-1', teamName: 'Alpha', supervisorId: 's-1',
        merchantId: null, merchantName: null, merchantRef: null, createdAt: '',
        details: { pairCount: 2, hedgedPaise: 4800000, buysPaise: 20000000, sellsPaise: 20000000, commissionPaise: 2000000, minRounds: 3, hedgePercent: 80,
          pairs: [{ playerA: 'u-1', playerB: 'u-2', sameAccount: false, rounds: 3, hedgedPaise: 3000000, stakedPaise: 3000000 },
            { playerA: 'u-7', playerB: 'u-7', sameAccount: true, rounds: 3, hedgedPaise: 1800000, stakedPaise: 1800000 }] } },
      { flagId: '2', kind: 'LOW_ACTIVITY', flagDay: '2026-10-03', teamId: 't-1', teamName: 'Alpha', supervisorId: 's-1',
        merchantId: 'm-1', merchantName: 'Asha', merchantRef: 'MA', createdAt: '',
        details: { completedOrders: 0, onlineSeconds: 300, teamAverageOrders: 4.2, teamAverageOnlineSeconds: 7800, members: 10, percent: 25 } },
    ] });
    render(<TeamsManager />);
    expect(await screen.findByText('Possible commission farming')).toBeInTheDocument();
    expect(screen.getByText(/Players u-1 and u-2: 3 rounds, 30,000 of 30,000 tokens staked against each other/)).toBeInTheDocument();
    expect(screen.getByText(/Player u-7 on both sides: 3 rounds/)).toBeInTheDocument();
    expect(screen.getByText(/0 orders, 5m online \(team average 4.2 orders, 2h 10m\)/)).toBeInTheDocument();
    await waitFor(() => expect(api.teams.redFlags).toHaveBeenCalledWith(30));
  });

  it('says so when there are no red flags', async () => {
    render(<TeamsManager />);
    expect(await screen.findByText('No red flags.')).toBeInTheDocument();
  });

  // ── Team token pools (Step 2b) ───────────────────────────────────────────
  it('fulfils the request on the row pressed, with the payment typed on THAT row', async () => {
    render(<TeamsManager />);
    const amount = await screen.findByLabelText('Platform paid');
    fireEvent.change(amount, { target: { value: '390' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buy 400 tokens back from Bravo' }));
    await waitFor(() => expect(api.teams.fulfilPoolRequest).toHaveBeenCalledWith('pr-2', { settlementCurrency: 'INR', settlementAmount: 390 }));
    expect(api.teams.fulfilPoolRequest).toHaveBeenCalledTimes(1);
  });

  it('cannot fulfil with no payment typed, and a buyback offers rupees only', async () => {
    render(<TeamsManager />);
    expect(await screen.findByRole('button', { name: /Sell 1,500 tokens to Alpha/ })).toBeDisabled();
    const sellCurrency = screen.getAllByLabelText('Currency')[1] as HTMLSelectElement;
    expect([...sellCurrency.options].map((o) => o.value)).toEqual(['INR']);
  });

  it('shows the server\'s refusal verbatim', async () => {
    (api.teams.fulfilPoolRequest as any).mockRejectedValueOnce({ response: { data: { message: 'The pool holds fewer tokens than that.' } } });
    render(<TeamsManager />);
    fireEvent.change(await screen.findByLabelText('Platform received'), { target: { value: '1500' } });
    fireEvent.click(screen.getByRole('button', { name: /Sell 1,500 tokens to Alpha/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The pool holds fewer tokens than that.'));
  });

  it('rejects with the reason typed on the row', async () => {
    render(<TeamsManager />);
    fireEvent.change((await screen.findAllByLabelText('Reason (if rejecting)'))[0], { target: { value: 'No payment seen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject request from Alpha' }));
    await waitFor(() => expect(api.teams.rejectPoolRequest).toHaveBeenCalledWith('pr-1', 'No payment seen'));
  });

  it('staff without the money area never see, or load, the pool queue', async () => {
    perms.fund = false;
    render(<TeamsManager />);
    await screen.findByRole('button', { name: 'Approve Chitra' });
    expect(screen.queryByText('Team token requests')).toBeNull();
    expect(api.teams.poolRequests).not.toHaveBeenCalled();
  });

  it('approves the member on the row pressed — the second pending row, not the first', async () => {
    render(<TeamsManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve Chitra' }));
    await waitFor(() => expect(api.teams.approveMember).toHaveBeenCalledWith('m-3'));
    expect(api.teams.approveMember).toHaveBeenCalledTimes(1);
  });

  it('rejects and removes by the row\'s own id', async () => {
    render(<TeamsManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject Bhanu' }));
    await waitFor(() => expect(api.teams.rejectMember).toHaveBeenCalledWith('m-2'));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Asha' }));
    await waitFor(() => expect(api.teams.removeMember).toHaveBeenCalledWith('m-1'));
  });

  it('makes a supervisor with the rail chosen', async () => {
    render(<TeamsManager />);
    fireEvent.change(await screen.findByLabelText('Merchant ID'), { target: { value: ' m-9 ' } });
    fireEvent.change(screen.getByLabelText('Rail'), { target: { value: 'CASH' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make supervisor' }));
    await waitFor(() => expect(api.teams.setSupervisor).toHaveBeenCalledWith('m-9', 'CASH'));
  });

  it('shows the server refusal verbatim', async () => {
    (api.teams.approveMember as any).mockRejectedValueOnce({ response: { data: { message: 'That team already has 10 members.' } } });
    render(<TeamsManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve Bhanu' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('That team already has 10 members.'));
  });

  it('offers to remove the role only from a supervisor with no teams', async () => {
    render(<TeamsManager />);
    await screen.findByText('Sup One');
    expect(screen.queryByRole('button', { name: 'Remove supervisor role' })).not.toBeInTheDocument();
  });
});
