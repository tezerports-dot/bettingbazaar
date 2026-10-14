// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The merchants table (owner, 2026-10-14): the figures the server sends per
 * row (processed, orders, pool, commission today and this month), the role
 * tabs and sort keys the server names, and a row opening the merchant's page.
 * A merchant holds no tokens of their own: the pool is their team's.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

const { merchants } = vi.hoisted(() => ({
  merchants: {
    getAll: vi.fn(), create: vi.fn(),
    listMerchantAccounts: vi.fn(), makeMerchantAccount: vi.fn(), listMerchantFlags: vi.fn(),
  },
}));
vi.mock('../../services/api', () => ({ default: { merchants, put: vi.fn(), get: vi.fn(), post: vi.fn() } }));
vi.mock('../../services/sse', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { MerchantsList } from './MerchantsList';

// What GET /api/admin/merchants sends per row (adminDirectory.js toMerchantRow).
const ROW = {
  merchantId: 'MRC-1', userId: null, name: 'ravi', mobile: '9876543210', status: 'ACTIVE',
  merchantApprovalStatus: 'APPROVED', isOnline: true, role: 'SUPERVISOR', rail: 'UPI_BANK',
  acceptsDeposits: false, acceptsWithdrawals: false, routingPriority: 3, lostDisputes: 0, highRiskAt: null,
  assignmentPausedAt: null, createdAt: '2026-09-01T00:00:00Z', team: null,
  processedPaise: 2_345_000, completedOrders: 12,
  pool: { availablePaise: 700_000, heldPaise: 50_000, teams: 2 },
  commission: { todayPaise: 1_600, monthPaise: 9_900, totalPaise: 12_000 },
};

const renderList = () => render(
  <MemoryRouter initialEntries={['/merchants']}>
    <Routes>
      <Route path="/merchants" element={<MerchantsList />} />
      <Route path="/merchants/:merchantId" element={<p>merchant page</p>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  merchants.getAll.mockResolvedValue({
    success: true, data: [ROW], pagination: { total: 1 },
    sorts: ['joined', 'processed', 'orders', 'pool', 'commissionToday', 'commissionMonth', 'commissionTotal', 'name'],
    roles: ['MERCHANT', 'SUPERVISOR', 'AGENT', 'UNASSIGNED'],
  });
  merchants.listMerchantAccounts.mockResolvedValue({ success: true, merchantAccounts: [] });
  merchants.listMerchantFlags.mockResolvedValue({ success: true, flags: [] });
});

describe('merchants table', () => {
  it('shows processed volume, orders, pool and commission today and this month', async () => {
    renderList();
    await screen.findByText('ravi');
    expect(screen.getByText('₹23,450')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('₹7,000')).toBeInTheDocument();
    expect(screen.getByText('₹500 held')).toBeInTheDocument();
    expect(screen.getByText('₹16')).toBeInTheDocument();
    expect(screen.getByText('₹99')).toBeInTheDocument();
    expect(screen.getByText('2 teams')).toBeInTheDocument();
    expect(screen.queryByText(/Wallet|Scoring/)).not.toBeInTheDocument();
  });

  it('filters by the role tabs the server names', async () => {
    renderList();
    await screen.findByText('ravi');
    fireEvent.click(screen.getByRole('button', { name: 'Supervisors' }));
    await waitFor(() => expect(merchants.getAll).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'SUPERVISOR', page: 1 })));
    fireEvent.click(screen.getByLabelText('Waiting for approval only'));
    await waitFor(() => expect(merchants.getAll).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'PENDING' })));
  });

  it('sorts on the server by the header pressed', async () => {
    renderList();
    await screen.findByText('ravi');
    fireEvent.click(screen.getByRole('button', { name: /^Commission today/ }));
    await waitFor(() => expect(merchants.getAll).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'commissionToday', dir: 'desc' })));
  });

  it('opens the merchant\'s page from the row', async () => {
    renderList();
    fireEvent.click((await screen.findByText('ravi')).closest('tr')!);
    expect(await screen.findByText('merchant page')).toBeInTheDocument();
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
    renderList();
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
    renderList();
    const card = await screen.findByRole('article', { name: 'Shop Direct' });
    expect(card).toHaveTextContent('Pool: 2,500 tokens · 500 held');
    expect(card).toHaveTextContent('Asha · Deposits, Audit');
    expect(card).toHaveTextContent('Counter · UPI scanner');
    expect(screen.queryByText(/9876500000/)).toBeNull();
    expect(screen.getByRole('table', { name: 'Merchant flags' })).toHaveTextContent('6 / 5');
  });

});
