// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Sub-admins screen, pressed (owner, 2026-10-01: create sub-admins and give
 * them permissions "by selecting from the entire list").
 *
 * The routes are proven against a real database in
 * backend/tests/routes/staffPermissionsPg. This proves the CONTROLS: that the
 * picker offers exactly what the server lists, and that what Save sends is the
 * shape the route reads (§32 S26) — it sent the grant AS the body, the route
 * found no `permissions` key, and every save revoked everything.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const subAdmins = vi.hoisted(() => ({
  getAll: vi.fn(), create: vi.fn(), updatePermissions: vi.fn(), permissionCatalog: vi.fn(),
  listQueueManagers: vi.fn(), setQueueManager: vi.fn(), delete: vi.fn(), assignPhantomAccess: vi.fn(),
  resetAuthenticator: vi.fn(),
}));
vi.mock('../../services/api', () => ({ default: { subAdmins } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { SubAdminsList } from './SubAdminsList';

const CATALOG = {
  success: true,
  groups: [{ key: 'players', label: 'Players' }, { key: 'merchants', label: 'Merchants' }],
  permissions: [
    { key: 'canManageUsers', group: 'players', label: 'Manage players', description: 'Player records.' },
    { key: 'canAdjustBalances', group: 'players', label: 'Adjust player balances', description: 'Credit or debit.', money: true },
    { key: 'canManageMerchants', group: 'merchants', label: 'Manage merchants', description: 'Merchant records.' },
  ],
  adminOnly: [{ area: 'Sub-admins', why: 'Granting authority.' }],
};
const SUB = { userId: 'u-1', username: 'Asha', mobile: '9000000001', phantomAccess: 'NONE', subAdminPermissions: { canManageUsers: true } };

beforeEach(() => {
  for (const f of Object.values(subAdmins)) f.mockReset();
  subAdmins.permissionCatalog.mockResolvedValue(CATALOG);
  subAdmins.getAll.mockResolvedValue({ success: true, data: [SUB] });
  subAdmins.listQueueManagers.mockResolvedValue({ success: true, managers: [] });
  subAdmins.updatePermissions.mockResolvedValue({ success: true });
  subAdmins.create.mockResolvedValue({ success: true });
});

describe('Sub-admins', () => {
  it('Edit Permissions offers the SERVER\'s whole list, grouped, and sends exactly the ticked grant', async () => {
    render(<SubAdminsList />);
    await userEvent.click(await screen.findByTitle('Edit Permissions'));
    const dialog = await screen.findByRole('dialog');
    // Every area the server lists, under its group, with the money marker.
    expect(within(dialog).getByText('Players')).toBeTruthy();
    expect(within(dialog).getByLabelText(/Adjust player balances/)).toBeTruthy();
    expect(within(dialog).getByText('moves money')).toBeTruthy();
    expect(within(dialog).getByText(/cannot be granted/)).toBeTruthy();
    // The grant they hold is shown ticked.
    expect((within(dialog).getByLabelText(/Manage players/) as HTMLInputElement).checked).toBe(true);

    await userEvent.click(within(dialog).getByLabelText(/Manage merchants/));
    await userEvent.click(within(dialog).getByRole('button', { name: /Save Permissions/ }));
    await waitFor(() => expect(subAdmins.updatePermissions).toHaveBeenCalled());
    const [id, grant] = subAdmins.updatePermissions.mock.calls[0];
    expect(id).toBe('u-1');
    expect(grant).toMatchObject({ canManageUsers: true, canManageMerchants: true, canAdjustBalances: false });
  });

  it('Grant group ticks every area in that group and no other', async () => {
    render(<SubAdminsList />);
    await userEvent.click(await screen.findByTitle('Edit Permissions'));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Grant every permission in Merchants' }));
    expect((within(dialog).getByLabelText(/Manage merchants/) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByLabelText(/Adjust player balances/) as HTMLInputElement).checked).toBe(false);
  });

  it('says so, and offers to retry, when the permission list cannot be loaded', async () => {
    subAdmins.permissionCatalog.mockRejectedValueOnce({ response: { data: { message: 'Server unavailable.' } } });
    render(<SubAdminsList />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Server unavailable\. Sub-admins cannot be created or edited/);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('shows whether each has an authenticator', async () => {
    subAdmins.getAll.mockResolvedValue({ success: true, data: [
      { ...SUB, authenticatorEnrolled: true },
      { ...SUB, userId: 'u-2', username: 'Ravi', authenticatorEnrolled: false },
    ] });
    render(<SubAdminsList />);
    expect(await screen.findByText('Set up')).toBeTruthy();
    expect(screen.getByText('Not set up')).toBeTruthy();
  });

  it('Reset Authenticator asks first, then resets that account and reloads the list', async () => {
    subAdmins.getAll.mockResolvedValue({ success: true, data: [{ ...SUB, authenticatorEnrolled: true }] });
    subAdmins.resetAuthenticator.mockResolvedValue({ success: true, hadAuthenticator: true, message: 'Authenticator reset.' });
    render(<SubAdminsList />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reset authenticator for Asha' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reset Authenticator' });
    expect(within(dialog).getByText(/signed out everywhere/)).toBeTruthy();
    expect(subAdmins.resetAuthenticator, 'reset before the admin confirmed').not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(subAdmins.resetAuthenticator).toHaveBeenCalledWith('u-1'));
    await waitFor(() => expect(subAdmins.getAll).toHaveBeenCalledTimes(2));
  });

  it('Cancel on the reset dialog resets nothing (the opposite case)', async () => {
    render(<SubAdminsList />);
    await userEvent.click(await screen.findByRole('button', { name: 'Reset authenticator for Asha' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reset Authenticator' });
    await userEvent.click(within(dialog).getByRole('button', { name: /Cancel/ }));
    expect(subAdmins.resetAuthenticator).not.toHaveBeenCalled();
  });
});
