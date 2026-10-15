// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * One player's page (owner, 2026-10-14): every control on the page, offered
 * only to an account whose AREA admits it and only on a PLAYER, and the one
 * that cannot be undone asked twice, in place.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

const { users, post } = vi.hoisted(() => ({
  users: { getProfile: vi.fn(), blockUser: vi.fn(), unblockUser: vi.fn(), deleteUser: vi.fn(), adjustBalance: vi.fn(), getTransactions: vi.fn() },
  post: vi.fn(),
}));
vi.mock('../../services/api', () => ({ default: { users, post, boards: { list: vi.fn().mockResolvedValue({ success: true, boards: [] }) } } }));
vi.mock('../../hooks/useBoards', () => ({ useBoards: () => ({ boards: [{ key: 'K1', name: 'Kolkata' }] }) }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { UserProfile } from './UserProfile';
import { useAuthStore } from '../../services/auth';
import toast from 'react-hot-toast';

const as = (admin: Record<string, unknown>) => useAuthStore.setState({
  isAuthenticated: true, token: 't', admin: { userId: 's-1', username: 'staff', ...admin } as any,
});

const PROFILE = (over: Record<string, unknown> = {}) => ({
  success: true,
  user: { userId: 'u-1', username: 'player1', mobile: '9876543210', status: 'ACTIVE', accountType: 'PLAYER', phantomAccess: 'NONE', joinedAt: '2026-10-01T00:00:00Z', ...over },
  summary: {
    userId: 'u-1', playProfile: 'VIP', lostDisputes: 0, highRiskAt: null,
    wallet: { vipPaise: 400_000, depositPaise: 300_000, winningsPaise: 100_000, generalPaise: 0, lockedPaise: 5_000 },
    totals: { depositsPaise: 500_000, withdrawalsPaise: 100_000, depositCount: 2, netPaise: -20_000 },
  },
  escrow: { inSellOrders: 1000, inDispute: 0 },
  recentBets: { bets: [] }, recentTransactions: [],
});

const renderPage = () => render(
  <MemoryRouter initialEntries={['/users/u-1']}>
    <Routes><Route path="/users/:userId" element={<UserProfile />} /></Routes>
  </MemoryRouter>,
);

beforeEach(() => { vi.clearAllMocks(); users.getProfile.mockResolvedValue(PROFILE()); });

describe('player page', () => {
  it('shows the wallets, escrow, deposits and net loss', async () => {
    as({ isAdmin: true });
    renderPage();
    await screen.findByRole('heading', { name: 'player1' });
    expect(screen.getByText('-₹200')).toBeInTheDocument();
    expect(screen.getByText('₹4,000')).toBeInTheDocument();
    expect(screen.getByText('Total deposits (2)')).toBeInTheDocument();
    expect(screen.getByText('In sell orders').parentElement).toHaveTextContent('₹1,000');
  });

  it('shows a full admin every control, on the page', async () => {
    as({ isAdmin: true });
    renderPage();
    await screen.findByRole('heading', { name: 'player1' });
    for (const name of ['Block player', 'Add', 'Deduct', 'Save']) expect(screen.getByRole('button', { name })).toBeInTheDocument();
  });

  it('hides balance and house-bettor controls from a sub-admin with the players area alone', async () => {
    as({ isAdmin: false, isSubAdmin: true, permissions: { canManageUsers: true } });
    renderPage();
    await screen.findByRole('heading', { name: 'player1' });
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(screen.queryByLabelText('House-bettor access level')).toBeNull();
    expect(screen.getByRole('button', { name: 'Block player' })).toBeInTheDocument();
  });

  it('offers no player control on a staff account', async () => {
    as({ isAdmin: true });
    users.getProfile.mockResolvedValue(PROFILE({ accountType: 'STAFF' }));
    renderPage();
    await screen.findByRole('heading', { name: 'player1' });
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(screen.queryByText(/Close this account/)).toBeNull();
  });

  it('asks for the block reason beside the button, then blocks with it', async () => {
    as({ isAdmin: true });
    users.blockUser.mockResolvedValue({ success: true });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Block player' }));
    expect(users.blockUser).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Reason for blocking'), { target: { value: 'chargeback' } });
    fireEvent.click(screen.getByRole('button', { name: 'Block player' }));
    await waitFor(() => expect(users.blockUser).toHaveBeenCalledWith('u-1', 'chargeback'));
  });

  it('adjusts a balance with the wallet, amount and reason typed on the page', async () => {
    as({ isAdmin: true });
    users.adjustBalance.mockResolvedValue({ success: true });
    renderPage();
    await screen.findByRole('heading', { name: 'player1' });
    fireEvent.change(screen.getByLabelText('Wallet'), { target: { value: 'winningsBalance' } });
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '150' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'refund' } });
    fireEvent.click(screen.getByRole('button', { name: 'Deduct' }));
    await waitFor(() => expect(users.adjustBalance).toHaveBeenCalledWith('u-1', -150, 'refund', 'winningsBalance'));
  });

  it('closes the account only after the second, in-place confirmation', async () => {
    as({ isAdmin: true });
    users.deleteUser.mockResolvedValue({ success: true });
    renderPage();
    fireEvent.click(await screen.findByText('Close this account…'));
    expect(users.deleteUser).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, close the account' }));
    await waitFor(() => expect(users.deleteUser).toHaveBeenCalledWith('u-1'));
  });

  it("shows the server's refusal, which names what to resolve first", async () => {
    as({ isAdmin: true });
    users.deleteUser.mockRejectedValue({ response: { status: 409, data: { message: 'Cannot delete: 1 order(s) still open.' } } });
    renderPage();
    fireEvent.click(await screen.findByText('Close this account…'));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, close the account' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Cannot delete: 1 order(s) still open.'));
  });

  it('sets house-bettor access from the page', async () => {
    as({ isAdmin: true });
    post.mockResolvedValue({ data: { success: true } });
    renderPage();
    await screen.findByRole('heading', { name: 'player1' });
    fireEvent.change(screen.getByLabelText('House-bettor access level'), { target: { value: 'K1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/admin/users/u-1/phantom-access', { accessLevel: 'K1' }));
  });
});
