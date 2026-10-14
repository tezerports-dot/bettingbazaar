// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The Merchants screen after the team-routing change (PROJECT_STATUS §3.10, 2c).
 *
 * A merchant holds no tokens and is not ranked, capped or topped up from here:
 * their team's pool holds the tokens and routing picks the member. So:
 *
 *   - no wallet, scoring, limits, top-up/deduct or profit-engine control is
 *     offered (every route behind them is gone — a press would 404);
 *   - the assignment-pause RESUME is reachable. It used to sit on the list row
 *     and read `assignmentPausedAt`, which the list route never sends, so it
 *     could never appear. The profile route does send it;
 *   - the volume tab renders the four figures GET /merchants/:id/earnings
 *     actually sends, not the earnings fields it never sent.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const { merchants, put } = vi.hoisted(() => ({
  merchants: {
    getAll: vi.fn(), getProfile: vi.fn(), getEarnings: vi.fn(), getOrders: vi.fn(),
    resumeAssignment: vi.fn(), suspend: vi.fn(), activate: vi.fn(),
    approve: vi.fn(), reject: vi.fn(), create: vi.fn(),
    listMerchantAccounts: vi.fn(), makeMerchantAccount: vi.fn(), listMerchantFlags: vi.fn(),
  },
  put: vi.fn(),
}));
vi.mock('../../services/api', () => ({ default: { merchants, put, get: vi.fn(), post: vi.fn() } }));
vi.mock('../../services/sse', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { MerchantsList } from './MerchantsList';

// What GET /api/admin/merchants sends per row (merchant.admin.routes.js).
const ROW = {
  _id: 'MRC-1', merchantId: 'MRC-1', userId: 'u-1', name: 'ravi', mobile: '9876543210', email: '',
  status: 'ACTIVE', merchantApprovalStatus: 'APPROVED', isOnline: true,
  acceptsDeposits: true, acceptsWithdrawals: true, merchantType: 'INR', panelUrl: '',
  merchantStats: { dailyProcessed: 1500, monthlyProcessed: 9000, totalOrdersProcessed: 12 },
  createdAt: '2026-09-01T00:00:00Z',
};
// GET /merchants/:id/profile — toMerchant spread plus `statistics`.
const PROFILE = {
  ...ROW, acceptedCurrencies: ['INR'],
  assignmentPausedAt: '2026-10-01T10:00:00Z',
  assignmentPauseReason: 'Three buy orders in a row expired unpaid',
  statistics: { totalOrders: 14, completedOrders: 12, failedOrders: 2, successRate: 85.71 },
};

beforeEach(() => {
  vi.clearAllMocks();
  merchants.getAll.mockResolvedValue({ success: true, data: [ROW], pagination: { total: 1 } });
  merchants.getProfile.mockResolvedValue({ success: true, data: PROFILE });
  merchants.getEarnings.mockResolvedValue({
    success: true, earnings: { totalOrders: 14, completedOrders: 12, pendingOrders: 1, totalVolume: 23450 },
  });
  merchants.resumeAssignment.mockResolvedValue({ success: true, message: 'Assignment resumed for this merchant.' });
  merchants.listMerchantAccounts.mockResolvedValue({ success: true, merchantAccounts: [] });
  merchants.listMerchantFlags.mockResolvedValue({ success: true, flags: [] });
});

const openProfile = async () => {
  render(<MerchantsList />);
  fireEvent.click(await screen.findByTitle('Details'));
  await screen.findByText('Merchant Profile');
};

describe('Merchants after the team-routing change', () => {
  it('shows no merchant wallet, scoring or limits on the list', async () => {
    render(<MerchantsList />);
    expect(await screen.findByText('ravi')).toBeInTheDocument();
    expect(screen.queryByText(/Wallet|Scoring/)).not.toBeInTheDocument();
    expect(screen.queryByTitle('Limits')).not.toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('offers no top-up, deduct, limits or profit-engine tab on the profile', async () => {
    await openProfile();
    expect(screen.queryByText(/Edit Limits|Profit Engine|Top Up Wallet|Deduct From Wallet|Token Wallet/)).not.toBeInTheDocument();
    for (const name of ['Info & Stats', 'Payment Details', 'Order History', 'Order Volume']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('shows the pause reason and resumes after the admin confirms', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await openProfile();
    expect(screen.getByText('Three buy orders in a row expired unpaid')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume assignment' }));
    expect(confirm.mock.calls[0][0]).toMatch(/Three buy orders in a row expired unpaid/);
    await waitFor(() => expect(merchants.resumeAssignment).toHaveBeenCalledWith('MRC-1'));
  });

  it('does not resume when the admin cancels', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await openProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Resume assignment' }));
    expect(merchants.resumeAssignment).not.toHaveBeenCalled();
  });

  it('offers no resume for a merchant who is not paused', async () => {
    merchants.getProfile.mockResolvedValue({ success: true, data: { ...PROFILE, assignmentPausedAt: null } });
    await openProfile();
    expect(screen.queryByRole('button', { name: 'Resume assignment' })).not.toBeInTheDocument();
  });

  it('renders what the earnings route sends: counts and completed volume', async () => {
    await openProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Order Volume' }));
    await waitFor(() => expect(merchants.getEarnings).toHaveBeenCalledWith('MRC-1'));
    const volume = (await screen.findByText('Completed Volume')).closest('div')!;
    expect(within(volume).getByText(/23,450/)).toBeInTheDocument();
    expect(screen.getByText('In Progress').closest('div')).toHaveTextContent('1');
  });

  it('switches the payment details the merchant keeps through the capabilities route', async () => {
    put.mockResolvedValue({ data: { success: true } });
    await openProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Payment Details' }));
    fireEvent.click(screen.getByRole('button', { name: /USDT · wallet addresses/ }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/admin/merchants/MRC-1/capabilities', { merchantType: 'USDT' }));
  });
});

describe('merchants (merchant accounts), owner 2026-10-11', () => {
  const DIRECT = {
    teamId: 'TD-1', ownerMerchantId: 'MRC-9', ownerName: 'shop', ownerRef: 'M9', ownerStatus: 'ACTIVE', ownerOnline: true,
    name: 'Shop Direct', poolAvailablePaise: 250000, poolHeldPaise: 50000,
    commission: { paidPaise: 1000, owedPaise: 0, commissionPercent: 10 },
    accounts: [{ accountId: 'mpa_1', kind: 'UPI_QR', label: 'Counter', upiId: 'shop@okhdfc', bankName: 'HDFC', accountNo: '123456789012', acceptsDeposits: true, paysWithdrawals: false, status: 'ACTIVE' }],
    staff: [{ staffId: 'mst_1', name: 'Asha', mobile: '9876500000', roles: ['DEPOSITS', 'AUDIT'], status: 'ACTIVE' }],
    problemDays: [],
  };

  it('creates a Merchant when the kind says so', async () => {
    merchants.create.mockResolvedValue({ success: true });
    render(<MerchantsList />);
    fireEvent.click(await screen.findByRole('button', { name: /Create Merchant/ }));
    fireEvent.change(screen.getByLabelText('Username *'), { target: { value: 'shop' } });
    fireEvent.change(screen.getByLabelText('Mobile Number *'), { target: { value: '9123456780' } });
    // No password: a merchant signs in with Telegram (owner, 2026-10-14).
    expect(screen.queryByLabelText(/password/i)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Merchant' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Create Merchant' }).pop()!);
    await waitFor(() => expect(merchants.create).toHaveBeenCalledWith(expect.objectContaining({ username: 'shop', kind: 'DIRECT' })));
    expect(merchants.create.mock.calls[0][0]).not.toHaveProperty('password');
  });

  it('lists the merchants the server sends, never a sub-member\'s mobile, and the flags', async () => {
    merchants.listMerchantAccounts.mockResolvedValue({ success: true, merchantAccounts: [DIRECT] });
    merchants.listMerchantFlags.mockResolvedValue({ success: true, flags: [{ id: 1, merchantId: 'MRC-9', merchantName: 'shop', day: '2026-10-10', problemCount: 6, threshold: 5 }] });
    render(<MerchantsList />);
    const card = await screen.findByRole('article', { name: 'Shop Direct' });
    expect(card).toHaveTextContent('Pool: 2,500 tokens · 500 held');
    expect(card).toHaveTextContent('Asha · Deposits, Audit');
    expect(card).toHaveTextContent('Counter · UPI scanner');
    expect(screen.queryByText(/9876500000/)).toBeNull();
    expect(screen.getByRole('table', { name: 'Merchant flags' })).toHaveTextContent('6 / 5');
  });

  it('makes an existing agent a merchant from the profile, and says the refusal', async () => {
    merchants.makeMerchantAccount.mockRejectedValueOnce({ response: { data: { message: 'That merchant is in a team. Remove them from it first.' } } });
    await openProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Make merchant account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That merchant is in a team.');
    merchants.makeMerchantAccount.mockResolvedValueOnce({ success: true, teamId: 'TD-2' });
    fireEvent.click(screen.getByRole('button', { name: 'Make merchant account' }));
    await waitFor(() => expect(merchants.makeMerchantAccount).toHaveBeenLastCalledWith('MRC-1'));
    await waitFor(() => expect(merchants.listMerchantAccounts).toHaveBeenCalledTimes(2));
  });
});
