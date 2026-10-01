// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Users screen offers each control only to an account whose AREA admits it.
 *
 * The screen is the players area (canManageUsers). Add/Deduct are
 * canAdjustBalances and Phantom Access is canManagePhantomAgents — and a
 * sub-admin given the players area alone was shown all three, then refused on
 * press. Measured by opening the panel as that account
 * (BB_PROFILE=subadmin-players) and by sweeping every admin screen for calls
 * into another area.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  default: {
    users: {
      getAll: vi.fn().mockResolvedValue({
        success: true,
        data: [{ userId: 'u-1', username: 'player1', mobile: '9876543210', status: 'ACTIVE', kycStatus: 'APPROVED', accountType: 'PLAYER', depositBalance: 0, winningsBalance: 0, lockedBalance: 0 }],
        pagination: { total: 1 },
      }),
      deleteUser: vi.fn(),
    },
  },
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { UsersList } from './UsersList';
import api from '../../services/api';
import toast from 'react-hot-toast';
import { useAuthStore } from '../../services/auth';

const as = (admin: Record<string, unknown>) => useAuthStore.setState({
  isAuthenticated: true, token: 't', mustEnroll2FA: false, pendingChallenge: null,
  admin: { userId: 's-1', username: 'staff', ...admin } as any,
});

describe('Users screen controls, by area', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('shows a full admin Add Balance, Deduct and Phantom Access', async () => {
    as({ isAdmin: true });
    render(<UsersList />);
    await screen.findByText('player1');
    expect(screen.getByTitle('Add Balance')).toBeInTheDocument();
    expect(screen.getByTitle('Deduct')).toBeInTheDocument();
    expect(screen.getByTitle('Phantom Access')).toBeInTheDocument();
  });

  it('hides them from a sub-admin given the players area alone', async () => {
    as({ isAdmin: false, isSubAdmin: true, permissions: { canManageUsers: true } });
    render(<UsersList />);
    await screen.findByText('player1');
    expect(screen.queryByTitle('Add Balance')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Deduct')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Phantom Access')).not.toBeInTheDocument();
    // The players area's own controls stay.
    expect(screen.getByTitle('Details')).toBeInTheDocument();
  });

  it('shows Add/Deduct, and only them, to a sub-admin who also holds balances', async () => {
    as({ isAdmin: false, isSubAdmin: true, permissions: { canManageUsers: true, canAdjustBalances: true } });
    render(<UsersList />);
    await screen.findByText('player1');
    expect(screen.getByTitle('Add Balance')).toBeInTheDocument();
    expect(screen.queryByTitle('Phantom Access')).not.toBeInTheDocument();
  });

  // ── Delete Account: a feature with no button until 2026-10-01 ─────────────
  // `users.deleteUser` called a real route and no screen called it (route
  // coverage, "client methods no screen calls").
  it('offers Delete Account on a PLAYER row and never on a staff row', async () => {
    as({ isAdmin: true });
    const row = (userId: string, username: string, accountType: string) => ({ userId, username, mobile: '9876543210', status: 'ACTIVE', kycStatus: 'APPROVED', accountType, depositBalance: 0, winningsBalance: 0, lockedBalance: 0 });
    (api.users.getAll as any).mockResolvedValueOnce({
      success: true, data: [row('u-1', 'player1', 'PLAYER'), row('s-9', 'colleague', 'STAFF')], pagination: { total: 2 },
    });
    render(<UsersList />);
    await screen.findByText('player1');
    expect(screen.getAllByTitle('Delete Account')).toHaveLength(1);
    const staffRow = screen.getByText('colleague').closest('tr')!;
    expect(within(staffRow).queryByTitle('Delete Account')).not.toBeInTheDocument();
  });

  // A balance and phantom access are a PLAYER's; both routes refuse a staff or
  // merchant login (409), so the controls are not offered on those rows.
  it('offers Add Balance, Deduct and Phantom Access on a PLAYER row only', async () => {
    as({ isAdmin: true });
    const row = (userId: string, username: string, accountType: string) => ({ userId, username, mobile: '9876543210', status: 'ACTIVE', kycStatus: 'APPROVED', accountType, depositBalance: 0, winningsBalance: 0, lockedBalance: 0 });
    (api.users.getAll as any).mockResolvedValueOnce({
      success: true,
      data: [row('u-1', 'player1', 'PLAYER'), row('s-9', 'colleague', 'STAFF'), row('m-3', 'trader', 'MERCHANT')],
      pagination: { total: 3 },
    });
    render(<UsersList />);
    await screen.findByText('player1');
    const playerRow = screen.getByText('player1').closest('tr')!;
    for (const title of ['Add Balance', 'Deduct', 'Phantom Access']) {
      expect(within(playerRow).getByTitle(title)).toBeInTheDocument();
      for (const other of ['colleague', 'trader']) {
        expect(within(screen.getByText(other).closest('tr')!).queryByTitle(title)).not.toBeInTheDocument();
      }
    }
  });

  it('calls the route only after the confirmation, for that player', async () => {
    as({ isAdmin: true });
    (api.users.deleteUser as any).mockResolvedValue({ success: true });
    render(<UsersList />);
    await screen.findByText('player1');
    fireEvent.click(screen.getByTitle('Delete Account'));
    expect(api.users.deleteUser).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.users.deleteUser).toHaveBeenCalledWith('u-1'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Account closed'));
  });

  it("shows the server's refusal, which names what to resolve first", async () => {
    as({ isAdmin: true });
    (api.users.deleteUser as any).mockRejectedValue({ response: { status: 409, data: { message: 'Cannot delete: 1 order(s) still open. Resolve or cancel them first.' } } });
    render(<UsersList />);
    await screen.findByText('player1');
    fireEvent.click(screen.getByTitle('Delete Account'));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Cannot delete: 1 order(s) still open. Resolve or cancel them first.'));
  });
});
