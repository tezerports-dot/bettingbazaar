// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The merchant Team screen, for its three readers, and that the supervisor's
 * controls call the route with the TEAM they sit in (§23), showing the
 * server's refusal verbatim (§32 S14).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getMyTeam: vi.fn(),
  createTeam: vi.fn().mockResolvedValue({}),
  renameTeam: vi.fn().mockResolvedValue({}),
  deleteTeam: vi.fn().mockResolvedValue(undefined),
  addTeamMember: vi.fn().mockResolvedValue('Added.'),
  removeTeamMember: vi.fn().mockResolvedValue(undefined),
  getTeamPool: vi.fn(),
  requestTeamPool: vi.fn().mockResolvedValue('Requested.'),
  cancelTeamPoolRequest: vi.fn().mockResolvedValue(undefined),
  getMemberLog: vi.fn(),
  getTeamDisputes: vi.fn().mockResolvedValue([]),
  getDisputeThread: vi.fn(),
  postDisputeMessage: vi.fn().mockResolvedValue({}),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../services/api', () => api);
vi.mock('react-hot-toast', () => ({ default: toast }));

import TeamPage from './TeamPage';

const team = (teamId: string, name: string, extra = {}) => ({
  teamId, supervisorId: 's-1', supervisorName: 'Sup', supervisorRef: 'MSUP', name, rail: 'UPI_BANK',
  approvedCount: 0, pendingCount: 0, size: 10, strength: 'STOPPED', shortSince: null, wasFull: false, createdAt: '',
  poolAvailablePaise: 0, poolHeldPaise: 0,
  commission: { teamId, buysPaise: 0, sellsPaise: 0, matchedPaise: 0, highPaise: 0, paidPaise: 0, owedPaise: 0,
    commissionPercent: 10, supervisorSharePercent: 16 },
  ...extra,
});

describe('merchant Team screen', () => {
  beforeEach(() => { vi.clearAllMocks(); api.getTeamDisputes.mockResolvedValue([]); });

  it('a merchant in no team is shown the ID to hand to a supervisor', async () => {
    api.getMyTeam.mockResolvedValue({ role: 'NONE', publicRef: 'MABC123' });
    render(<TeamPage />);
    expect(await screen.findByText('MABC123')).toBeInTheDocument();
    expect(screen.getByText('You are not in a team')).toBeInTheDocument();
  });

  it('a pending member is told an admin still has to approve', async () => {
    api.getMyTeam.mockResolvedValue({ role: 'MEMBER', commissions: [], myCommissionPaise: 0, publicRef: 'M1', status: 'PENDING', team: team('t-1', 'Alpha') });
    render(<TeamPage />);
    expect(await screen.findByText('Waiting for an admin')).toBeInTheDocument();
  });

  it('a member of a team in its grace day is told it stops at midnight', async () => {
    api.getMyTeam.mockResolvedValue({ role: 'MEMBER', commissions: [], myCommissionPaise: 0, publicRef: 'M1', status: 'APPROVED', team: team('t-1', 'Alpha', { strength: 'GRACE', approvedCount: 9 }) });
    render(<TeamPage />);
    expect(await screen.findByText(/until midnight IST/)).toBeInTheDocument();
  });

  it('a supervisor adds a member to the team whose form they typed into — the second team, not the first', async () => {
    api.getMyTeam.mockResolvedValue({
      role: 'SUPERVISOR', commissions: [], myCommissionPaise: 0, rail: 'UPI_BANK', publicRef: 'MSUP',
      teams: [team('t-1', 'Alpha'), team('t-2', 'Bravo')], members: [],
    });
    render(<TeamPage />);
    const box = await screen.findByLabelText(/Add a member to Bravo/);
    fireEvent.change(box, { target: { value: ' MXYZ ' } });
    fireEvent.submit(box.closest('form')!);
    await waitFor(() => expect(api.addTeamMember).toHaveBeenCalledWith('t-2', 'MXYZ'));
  });

  it('a supervisor removes the member on the row pressed', async () => {
    api.getMyTeam.mockResolvedValue({
      role: 'SUPERVISOR', commissions: [], myCommissionPaise: 0, rail: 'UPI_BANK', publicRef: 'MSUP',
      teams: [team('t-1', 'Alpha', { approvedCount: 2 })],
      members: [
        { merchantId: 'm-1', teamId: 't-1', name: 'Asha', publicRef: 'MA', status: 'APPROVED', isOnline: false },
        { merchantId: 'm-2', teamId: 't-1', name: 'Bhanu', publicRef: 'MB', status: 'APPROVED', isOnline: false },
      ],
    });
    render(<TeamPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Bhanu' }));
    await waitFor(() => expect(api.removeTeamMember).toHaveBeenCalledWith('t-1', 'm-2'));
  });

  it('shows the server refusal verbatim', async () => {
    api.getMyTeam.mockResolvedValue({ role: 'SUPERVISOR', commissions: [], myCommissionPaise: 0, rail: 'CASH', publicRef: 'MSUP', teams: [], members: [] });
    api.createTeam.mockRejectedValueOnce(new Error('A supervisor can run at most 4 teams.'));
    render(<TeamPage />);
    const box = await screen.findByLabelText('New team name');
    fireEvent.change(box, { target: { value: 'Fifth' } });
    fireEvent.submit(box.closest('form')!);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A supervisor can run at most 4 teams.'));
  });

  // ── Team token pools (Step 2b) ───────────────────────────────────────────
  const supervisorWith = (poolRequests: unknown[] = []) => api.getMyTeam.mockResolvedValue({
    role: 'SUPERVISOR', commissions: [], myCommissionPaise: 0, rail: 'UPI_BANK', publicRef: 'MSUP',
    teams: [team('t-1', 'Alpha', { poolAvailablePaise: 250000 }), team('t-2', 'Bravo')], members: [], poolRequests,
  });

  it('shows each team its own pool balance', async () => {
    supervisorWith();
    render(<TeamPage />);
    expect(await screen.findByText(/2,500 tokens/)).toBeInTheDocument();
  });

  it('asks to buy for the team whose form was used, in whole tokens', async () => {
    supervisorWith();
    render(<TeamPage />);
    const box = await screen.findByLabelText('Tokens for Bravo');
    fireEvent.change(box, { target: { value: '5,000' } });
    expect((box as HTMLInputElement).value).toBe('5000');
    fireEvent.click(screen.getByRole('button', { name: 'Send Bravo request' }));
    await waitFor(() => expect(api.requestTeamPool).toHaveBeenCalledWith('t-2', 'BUY', 5000, ''));
  });

  it('asks to sell back when that is chosen, and shows the server refusal verbatim', async () => {
    supervisorWith();
    api.requestTeamPool.mockRejectedValueOnce(new Error('The pool holds 2,500 tokens. Ask for that or less.'));
    render(<TeamPage />);
    fireEvent.change(await screen.findByLabelText('Request for Alpha'), { target: { value: 'SELL' } });
    fireEvent.change(screen.getByLabelText('Tokens for Alpha'), { target: { value: '9000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send Alpha request' }));
    await waitFor(() => expect(api.requestTeamPool).toHaveBeenCalledWith('t-1', 'SELL', 9000, ''));
    expect(toast.error).toHaveBeenCalledWith('The pool holds 2,500 tokens. Ask for that or less.');
  });

  it('cancels the pending request shown, and shows a rejection with its reason', async () => {
    supervisorWith([
      { requestId: 'pr-1', teamId: 't-2', direction: 'BUY', tokenAmountPaise: 100000, status: 'PENDING', note: null, decisionNote: null, decidedAt: null, createdAt: '' },
      { requestId: 'pr-0', teamId: 't-2', direction: 'BUY', tokenAmountPaise: 50000, status: 'REJECTED', note: null, decisionNote: 'No payment seen', decidedAt: '', createdAt: '' },
    ]);
    render(<TeamPage />);
    expect(await screen.findByText(/No payment seen/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel this request' }));
    await waitFor(() => expect(api.cancelTeamPoolRequest).toHaveBeenCalledWith('pr-1'));
  });

  // ── Team commission (Step 2e) ────────────────────────────────────────────
  it('a member sees their own commission, their share of each payment, and what is waiting', async () => {
    api.getMyTeam.mockResolvedValue({
      role: 'MEMBER', publicRef: 'M1', status: 'APPROVED',
      team: team('t-1', 'Alpha', {
        strength: 'WORKING', approvedCount: 10,
        commission: { teamId: 't-1', buysPaise: 15000000, sellsPaise: 10000000, matchedPaise: 10000000, highPaise: 5000000,
          paidPaise: 500000, owedPaise: 500000, commissionPercent: 10, supervisorSharePercent: 16 },
      }),
      commissions: [{ commissionId: 'c-1', teamId: 't-1', fromHighPaise: 0, toHighPaise: 5000000, commissionPaise: 500000,
        mySharePaise: 42000, createdAt: '2026-10-03T10:00:00Z' }],
      myCommissionPaise: 42000,
    });
    render(<TeamPage />);
    expect(await screen.findByText('420 tokens')).toBeInTheDocument();
    expect(screen.getByText('your share 420')).toBeInTheDocument();
    expect(screen.getByText(/5,000 tokens earned and waiting/)).toBeInTheDocument();
    expect(screen.getByText(/10% of the rise is paid into the pool/)).toBeInTheDocument();
  });

  it('a supervisor sees each team its own commission and their total', async () => {
    api.getMyTeam.mockResolvedValue({
      role: 'SUPERVISOR', rail: 'UPI_BANK', publicRef: 'MSUP', members: [], poolRequests: [],
      teams: [team('t-1', 'Alpha', { commission: { teamId: 't-1', buysPaise: 0, sellsPaise: 0, matchedPaise: 0, highPaise: 0,
        paidPaise: 300000, owedPaise: 0, commissionPercent: 10, supervisorSharePercent: 16 } }), team('t-2', 'Bravo')],
      commissions: [{ commissionId: 'c-1', teamId: 't-1', fromHighPaise: 0, toHighPaise: 3000000, commissionPaise: 300000,
        mySharePaise: 48000, createdAt: '2026-10-03T10:00:00Z' }],
      myCommissionPaise: 48000,
    });
    render(<TeamPage />);
    expect(await screen.findByText('Your commission 480 tokens')).toBeInTheDocument();
    expect(screen.getByText('3,000 tokens paid')).toBeInTheDocument();
    expect(screen.getByText('0 tokens paid')).toBeInTheDocument();
    // The payment is listed under Alpha only.
    expect(screen.getAllByText('your share 480')).toHaveLength(1);
  });

  it('labels every pool movement, a commission included', async () => {
    supervisorWith();
    api.getTeamPool.mockResolvedValue({ pool: {}, entries: [
      { id: 2, kind: 'COMMISSION', availableDeltaPaise: 500000, heldDeltaPaise: 0, availableAfterPaise: 750000, heldAfterPaise: 0, createdAt: '2026-10-03T10:00:00Z' },
      { id: 1, kind: 'BUY_PAID', availableDeltaPaise: 0, heldDeltaPaise: -5000000, availableAfterPaise: 250000, heldAfterPaise: 0, createdAt: '2026-10-03T09:00:00Z' },
    ] });
    render(<TeamPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show Alpha pool history' }));
    expect(await screen.findByText(/^Team commission ·/)).toBeInTheDocument();
    expect(screen.getByText(/^Paid to a player \(buy\) ·/)).toBeInTheDocument();
  });

  it('loads the pool history of the team pressed', async () => {
    supervisorWith();
    api.getTeamPool.mockResolvedValue({ pool: {}, entries: [
      { id: 1, kind: 'ADMIN_SALE', availableDeltaPaise: 250000, heldDeltaPaise: 0, availableAfterPaise: 250000, heldAfterPaise: 0, createdAt: '2026-10-02T10:00:00Z' },
    ] });
    render(<TeamPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show Alpha pool history' }));
    await waitFor(() => expect(api.getTeamPool).toHaveBeenCalledWith('t-1'));
    expect(await screen.findByText(/Bought from the platform/)).toBeInTheDocument();
  });
  // ── Oversight (Step 2f) ──────────────────────────────────────────────────
  const activity = (merchantId: string, name: string, completedOrders: number, onlineSeconds: number) => ({
    teamId: 't-1', merchantId, name, publicRef: `R${merchantId}`, isOnline: false, completedOrders, completedTokens: completedOrders * 500, onlineSeconds,
  });
  const supervisorOverseeing = () => api.getMyTeam.mockResolvedValue({
    role: 'SUPERVISOR', rail: 'CASH', publicRef: 'MSUP', poolRequests: [], commissions: [], myCommissionPaise: 0,
    teams: [team('t-1', 'Alpha', { approvedCount: 2 })],
    members: [
      { merchantId: 'm-1', teamId: 't-1', name: 'Asha', publicRef: 'MA', status: 'APPROVED', isOnline: false },
      { merchantId: 'm-2', teamId: 't-1', name: 'Bhanu', publicRef: 'MB', status: 'APPROVED', isOnline: false },
    ],
    activity: { today: [activity('m-1', 'Asha', 3, 7200), activity('m-2', 'Bhanu', 0, 0)], week: [activity('m-1', 'Asha', 12, 36000), activity('m-2', 'Bhanu', 1, 600)] },
    redFlags: [{ flagId: 'f-1', kind: 'LOW_ACTIVITY', flagDay: '2026-10-03', teamId: 't-1', teamName: 'Alpha', merchantId: 'm-2', merchantName: 'Bhanu', merchantRef: 'MB',
      details: { completedOrders: 0, onlineSeconds: 300, teamAverageOrders: 4.5, teamAverageOnlineSeconds: 9000, members: 2, percent: 25 } }],
  });

  it('a supervisor sees each member\'s orders and online time, and the red flag on the member it names', async () => {
    supervisorOverseeing();
    render(<TeamPage />);
    expect(await screen.findByText('Today 3 orders, 2h 00m · 7 days 12 orders, 10h 00m')).toBeInTheDocument();
    const flag = screen.getByText(/Red flag, 2026-10-03/);
    expect(flag.textContent).toMatch(/0 orders and 5m online, against a team average of 4.5 orders and 2h 30m/);
    // Only Bhanu is flagged.
    expect(screen.getAllByText(/Red flag,/)).toHaveLength(1);
  });

  it('opens the log of the member pressed', async () => {
    supervisorOverseeing();
    api.getMemberLog.mockResolvedValue({
      member: { merchantId: 'm-2', teamId: 't-1', teamName: 'Alpha', name: 'Bhanu', publicRef: 'MB', status: 'APPROVED', isOnline: false },
      orders: [{ orderId: 'o-1', merchantId: 'm-2', type: 'WITHDRAWAL', status: 'COMPLETED', currency: 'INR', tokenAmount: 5000, paymentMode: 'CASH_ATM',
        disputeRaisedAt: null, disputeRaisedBy: null, disputeReason: null, disputeResolvedAt: null, disputeDecision: null, rejectedReason: null,
        createdAt: '2026-10-03T10:00:00Z', updatedAt: '2026-10-03T10:00:00Z' }],
      sessions: [{ startedAt: '2026-10-03T09:00:00Z', endedAt: '2026-10-03T09:10:00Z', seconds: 600 }],
    });
    render(<TeamPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Log of Bhanu' }));
    await waitFor(() => expect(api.getMemberLog).toHaveBeenCalledWith('m-2'));
    expect(await screen.findByText(/^Sell · 5,000 tokens ·/)).toBeInTheDocument();
    expect(screen.getByText(/· 10m$/)).toBeInTheDocument();
  });

  it('a supervisor reads an open dispute\'s thread and speaks for the member; the server\'s refusal is shown as worded', async () => {
    supervisorOverseeing();
    const dispute = { orderId: 'o-9', merchantId: 'm-1', type: 'WITHDRAWAL', status: 'DISPUTED', currency: 'INR', tokenAmount: 1000, paymentMode: 'CASH_ATM',
      disputeRaisedAt: '2026-10-03T10:00:00Z', disputeRaisedBy: 'user', disputeReason: 'Nothing reached my bank', disputeResolvedAt: null, disputeDecision: null,
      rejectedReason: null, createdAt: '2026-10-03T09:00:00Z', updatedAt: '2026-10-03T10:00:00Z' };
    api.getTeamDisputes.mockResolvedValue([dispute]);
    api.getDisputeThread.mockResolvedValue({ order: dispute, messages: [
      { id: '1', senderType: 'ADMIN', senderName: 'Admin', message: 'Please send the bank statement.', isSystem: false, createdAt: '2026-10-03T10:05:00Z' },
    ] });
    render(<TeamPage />);
    expect(await screen.findByText('Reason given: Nothing reached my bank')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open the thread for Asha' }));
    await waitFor(() => expect(api.getDisputeThread).toHaveBeenCalledWith('o-9'));
    expect(await screen.findByText('Please send the bank statement.')).toBeInTheDocument();
    const box = screen.getByLabelText('Message the dispute manager for your member');
    fireEvent.change(box, { target: { value: ' Paid at 14:02; UTR on the order. ' } });
    fireEvent.submit(box.closest('form')!);
    await waitFor(() => expect(api.postDisputeMessage).toHaveBeenCalledWith('o-9', 'Paid at 14:02; UTR on the order.'));

    api.postDisputeMessage.mockRejectedValueOnce(new Error('Take the mobile number out of your message.'));
    fireEvent.change(box, { target: { value: 'call 98765 43210' } });
    fireEvent.submit(box.closest('form')!);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Take the mobile number out of your message.'));
  });

  it('a decided dispute shows no reply box', async () => {
    supervisorOverseeing();
    const decided = { orderId: 'o-8', merchantId: 'm-1', type: 'DEPOSIT', status: 'COMPLETED', currency: 'INR', tokenAmount: 500, paymentMode: 'CASH_ATM',
      disputeRaisedAt: '2026-10-03T10:00:00Z', disputeRaisedBy: 'user', disputeReason: null, disputeResolvedAt: '2026-10-03T11:00:00Z',
      disputeDecision: 'RELEASE_TO_USER', rejectedReason: null, createdAt: '2026-10-03T09:00:00Z', updatedAt: '2026-10-03T11:00:00Z' };
    api.getTeamDisputes.mockResolvedValue([decided]);
    api.getDisputeThread.mockResolvedValue({ order: decided, messages: [] });
    render(<TeamPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open the thread for Asha' }));
    expect(await screen.findByText('Decided: RELEASE_TO_USER. The thread is closed.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Message the dispute manager for your member')).toBeNull();
  });

  it('a member sees the team\'s totals and their own figures', async () => {
    api.getMyTeam.mockResolvedValue({
      role: 'MEMBER', commissions: [], myCommissionPaise: 0, publicRef: 'M1', status: 'APPROVED', team: team('t-1', 'Alpha', { strength: 'WORKING', approvedCount: 10 }),
      performance: { days: 7, from: '', members: 10, team: { completedOrders: 40, completedTokens: 200000, averageOrders: 4, averageOnlineSeconds: 5400 },
        me: { completedOrders: 6, completedTokens: 30000, onlineSeconds: 7260 } },
    });
    render(<TeamPage />);
    expect(await screen.findByText('Team performance, last 7 days')).toBeInTheDocument();
    expect(screen.getByText('The team completed 40 orders (2,00,000 tokens).')).toBeInTheDocument();
    expect(screen.getByText('An average member: 4 orders, online 1h 30m.')).toBeInTheDocument();
    expect(screen.getByText('You: 6 orders, online 2h 01m.')).toBeInTheDocument();
  });

  it('a member of a team of two sees their own figures and no team totals, which would be their teammate\'s', async () => {
    api.getMyTeam.mockResolvedValue({
      role: 'MEMBER', commissions: [], myCommissionPaise: 0, publicRef: 'M1', status: 'APPROVED', team: team('t-1', 'Alpha', { approvedCount: 2 }),
      performance: { days: 7, from: '', members: 2, team: null, me: { completedOrders: 1, completedTokens: 500, onlineSeconds: 60 } },
    });
    render(<TeamPage />);
    expect(await screen.findByText('The team\'s figures show once it has three approved members.')).toBeInTheDocument();
    expect(screen.getByText('You: 1 orders, online 1m.')).toBeInTheDocument();
    expect(screen.queryByText(/The team completed/)).toBeNull();
  });
});
