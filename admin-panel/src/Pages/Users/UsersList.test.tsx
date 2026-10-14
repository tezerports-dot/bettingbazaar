// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The players table (owner, 2026-10-14): the figures the server sends, its
 * sort asked of the server, and a row opening the player's own page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

const { users } = vi.hoisted(() => ({ users: { getAll: vi.fn() } }));
vi.mock('../../services/api', () => ({ default: { users } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { UsersList } from './UsersList';

// What GET /api/admin/users sends per row (adminDirectory.js toPlayerRow).
const row = (userId: string, username: string, netPaise: number) => ({
  userId, username, mobile: '9876543210', status: 'ACTIVE', joinedAt: '2026-10-01T00:00:00Z', lastLogin: null,
  playProfile: 'VIP', phantomAccess: 'NONE', lostDisputes: 0, highRiskAt: null, paymentFlagged: false, blockReason: null,
  wallet: { vipPaise: 400_000, depositPaise: 300_000, winningsPaise: 100_000, generalPaise: 2_500, lockedPaise: 0 },
  totals: { depositsPaise: 500_000, withdrawalsPaise: 100_000, depositCount: 1, netPaise },
});

const renderList = () => render(
  <MemoryRouter initialEntries={['/users']}>
    <Routes>
      <Route path="/users" element={<UsersList />} />
      <Route path="/users/:userId" element={<p>profile page</p>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  users.getAll.mockResolvedValue({
    success: true, data: [row('u-1', 'winner', 35_000), row('u-2', 'loser', -20_000)],
    sorts: ['joined', 'deposits', 'withdrawals', 'net', 'vip', 'general', 'locked', 'name'], pagination: { total: 2 },
  });
});

describe('players table', () => {
  it('shows deposits, net win/loss with its sign, and both wallets', async () => {
    renderList();
    await screen.findByText('winner');
    expect(screen.getByText('+₹350')).toBeInTheDocument();
    expect(screen.getByText('-₹200')).toBeInTheDocument();
    expect(screen.getAllByText('₹5,000')).toHaveLength(2);   // total deposits
    expect(screen.getAllByText('₹4,000')).toHaveLength(2);   // VIP wallet
    expect(screen.getAllByText('₹25')).toHaveLength(2);      // General wallet
  });

  it('asks the server for the order a header names, largest first, then the other way', async () => {
    renderList();
    await screen.findByText('winner');
    fireEvent.click(screen.getByRole('button', { name: /Net win \/ loss/ }));
    await waitFor(() => expect(users.getAll).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'net', dir: 'desc', page: 1 })));
    fireEvent.click(screen.getByRole('button', { name: /Net win \/ loss/ }));
    await waitFor(() => expect(users.getAll).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'net', dir: 'asc' })));
    expect(screen.getByRole('button', { name: /biggest losers first/ })).toBeInTheDocument();
  });

  it('offers the server\'s sort keys in the Sort by list', async () => {
    renderList();
    await screen.findByText('winner');
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'deposits' } });
    await waitFor(() => expect(users.getAll).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'deposits' })));
  });

  it('opens the player\'s page from the row', async () => {
    renderList();
    fireEvent.click((await screen.findByText('loser')).closest('tr')!);
    expect(await screen.findByText('profile page')).toBeInTheDocument();
  });
});
