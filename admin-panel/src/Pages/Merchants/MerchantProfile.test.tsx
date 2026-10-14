// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * One merchant's page (owner, 2026-10-14): every control on the page, the
 * choices it offers from the server, and the server's refusal shown where the
 * admin pressed.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

const { merchants, teams, put } = vi.hoisted(() => ({
  merchants: {
    getProfile: vi.fn(), getEarnings: vi.fn(), getOrders: vi.fn(), resumeAssignment: vi.fn(),
    suspend: vi.fn(), activate: vi.fn(), approve: vi.fn(), reject: vi.fn(), makeMerchantAccount: vi.fn(),
  },
  teams: { setSupervisor: vi.fn(), setPriority: vi.fn() },
  put: vi.fn(),
}));
vi.mock('../../services/api', () => ({ default: { merchants, teams, put } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { MerchantProfile } from './MerchantProfile';
import { useAuthStore } from '../../services/auth';

const as = (admin: Record<string, unknown>) => useAuthStore.setState({
  isAuthenticated: true, token: 't', admin: { userId: 's-1', username: 'staff', ...admin } as any,
});

// GET /merchants/:id/profile — toMerchant spread plus `statistics`, `summary`, `choices`.
const MERCHANT = {
  _id: 'MRC-1', merchantId: 'MRC-1', name: 'ravi', mobile: '9876543210', status: 'ACTIVE',
  merchantApprovalStatus: 'APPROVED', isOnline: false, merchantType: 'INR', acceptedCurrencies: ['INR'],
  createdAt: '2026-09-01T00:00:00Z', assignmentPausedAt: '2026-10-01T10:00:00Z',
  assignmentPauseReason: 'Three buy orders in a row expired unpaid',
  statistics: { totalOrders: 14, completedOrders: 12, failedOrders: 2, successRate: 85.71 },
};
const SUMMARY = (role: string, extra: Record<string, unknown> = {}) => ({
  merchantId: 'MRC-1', role, rail: 'INR', routingPriority: 3, team: role === 'AGENT' ? { teamId: 'T1', name: 'North', memberStatus: 'APPROVED' } : null,
  processedPaise: 2_345_000, completedOrders: 12, pool: { availablePaise: 700_000, heldPaise: 0, teams: 1 },
  commission: { todayPaise: 1_600, monthPaise: 9_900, totalPaise: 12_000 }, ...extra,
});
const CHOICES = { routingPriority: { MIN: 1, MAX: 5, DEFAULT: 3 }, supervisorRails: ['CASH', 'UPI_BANK', 'USDT'] };

const profile = (role = 'AGENT', merchant: Record<string, unknown> = {}) =>
  merchants.getProfile.mockResolvedValue({ success: true, data: { ...MERCHANT, ...merchant }, summary: SUMMARY(role), choices: CHOICES });

const renderPage = () => render(
  <MemoryRouter initialEntries={['/merchants/MRC-1']}>
    <Routes><Route path="/merchants/:merchantId" element={<MerchantProfile />} /></Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  as({ isAdmin: true });
  profile();
  merchants.getOrders.mockResolvedValue({ success: true, data: [] });
  merchants.getEarnings.mockResolvedValue({ success: true, earnings: { totalOrders: 14, completedOrders: 12, pendingOrders: 1, totalVolume: 23450 } });
});

describe('merchant page', () => {
  it('shows the figures and no merchant wallet, top-up or limits', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'ravi' });
    expect(screen.getByText('Commission this month').parentElement).toHaveTextContent('₹99');
    expect(screen.getByText('Volume processed').parentElement).toHaveTextContent('₹23,450');
    expect(await screen.findByText('23,450 tokens')).toBeInTheDocument();
    expect(screen.queryByText(/Edit Limits|Profit Engine|Top Up Wallet|Token Wallet/)).toBeNull();
  });

  it('resumes assignment only once the admin ticks that they checked', async () => {
    merchants.resumeAssignment.mockResolvedValue({ success: true, message: 'Assignment resumed.' });
    renderPage();
    expect(await screen.findByText('Three buy orders in a row expired unpaid')).toBeInTheDocument();
    const resume = screen.getByRole('button', { name: 'Resume assignment' });
    expect(resume).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/checked with them/));
    fireEvent.click(resume);
    await waitFor(() => expect(merchants.resumeAssignment).toHaveBeenCalledWith('MRC-1'));
  });

  it('offers no resume for a merchant who is not paused', async () => {
    profile('AGENT', { assignmentPausedAt: null });
    renderPage();
    await screen.findByRole('heading', { name: 'ravi' });
    expect(screen.queryByRole('button', { name: 'Resume assignment' })).toBeNull();
  });

  it('switches the payment details through the capabilities route', async () => {
    put.mockResolvedValue({ data: { success: true } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /USDT · wallet addresses/ }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/admin/merchants/MRC-1/capabilities', { merchantType: 'USDT' }));
  });

  it('suspends with the reason typed beside the button', async () => {
    merchants.suspend.mockResolvedValue({ success: true });
    renderPage();
    fireEvent.change(await screen.findByLabelText('Reason for suspending'), { target: { value: 'fraud report' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suspend' }));
    await waitFor(() => expect(merchants.suspend).toHaveBeenCalledWith('MRC-1', 'fraud report'));
  });

  it('sets an agent\'s routing priority from the server\'s range', async () => {
    teams.setPriority.mockResolvedValue({ success: true, priority: 5, message: 'Priority 5' });
    renderPage();
    const group = await screen.findByRole('group', { name: 'Routing priority' });
    expect(group.querySelectorAll('button')).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: '5' }));
    await waitFor(() => expect(teams.setPriority).toHaveBeenCalledWith('MRC-1', 5));
  });

  it('makes an agent with no team a supervisor on a rail, and hides it from an account without the teams area', async () => {
    profile('UNASSIGNED');
    teams.setSupervisor.mockResolvedValue({ success: true });
    renderPage();
    fireEvent.change(await screen.findByLabelText('Supervisor rail'), { target: { value: 'CASH' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make supervisor' }));
    await waitFor(() => expect(teams.setSupervisor).toHaveBeenCalledWith('MRC-1', 'CASH'));
  });

  it('hides team controls from a sub-admin without the teams area', async () => {
    as({ isAdmin: false, isSubAdmin: true, permissions: { canManageMerchants: true } });
    renderPage();
    await screen.findByRole('heading', { name: 'ravi' });
    expect(screen.queryByRole('group', { name: 'Routing priority' })).toBeNull();
  });

  it('makes an agent a merchant account, and says the refusal where it was pressed', async () => {
    merchants.makeMerchantAccount.mockRejectedValueOnce({ response: { data: { message: 'That merchant is in a team. Remove them from it first.' } } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Make merchant account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That merchant is in a team.');
    expect(merchants.makeMerchantAccount).toHaveBeenCalledWith('MRC-1');
  });
});
