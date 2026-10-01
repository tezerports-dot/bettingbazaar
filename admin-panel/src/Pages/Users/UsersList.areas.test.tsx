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
import { render, screen } from '@testing-library/react';

vi.mock('../../services/api', () => ({
  default: {
    users: {
      getAll: vi.fn().mockResolvedValue({
        success: true,
        data: [{ userId: 'u-1', username: 'player1', mobile: '9876543210', status: 'ACTIVE', kycStatus: 'APPROVED', depositBalance: 0, winningsBalance: 0, lockedBalance: 0 }],
        pagination: { total: 1 },
      }),
    },
  },
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { UsersList } from './UsersList';
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
});
