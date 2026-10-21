// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The staff table and one staff account's page (owner, 2026-10-14): the roles
 * and sort keys the server names, a row opening the account, and every control
 * on the page itself, each calling its route with THIS account's id (§23).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

const { subAdmins } = vi.hoisted(() => ({
  subAdmins: {
    listStaff: vi.fn(), getStaff: vi.fn(), permissionCatalog: vi.fn(), create: vi.fn(),
    updatePermissions: vi.fn(), resetAuthenticator: vi.fn(), delete: vi.fn(),
  },
}));
vi.mock('../../services/api', () => ({ default: { subAdmins } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { StaffList } from './StaffList';
import { StaffProfile } from './StaffProfile';

const CATALOG = {
  groups: [{ key: 'people', label: 'People' }],
  permissions: [
    { key: 'canManageUsers', group: 'people', label: 'Players', description: 'Players' },
    { key: 'canModerateChat', group: 'people', label: 'Chat', description: 'Chat' },
  ],
  adminOnly: [],
};
const SUB = {
  userId: 'stf-1', username: 'Meera', mobile: '9876543210', status: 'ACTIVE', isBlocked: false,
  joinedAt: '2026-10-01T00:00:00Z', lastLogin: null, roles: ['SUB_ADMIN'], areas: ['canModerateChat'], authenticatorEnrolled: true,
};

const renderAt = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/staff" element={<StaffList />} />
      <Route path="/staff/:userId" element={<StaffProfile />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  subAdmins.permissionCatalog.mockResolvedValue(CATALOG);
  subAdmins.listStaff.mockResolvedValue({
    success: true, staff: [SUB], sorts: ['joined', 'lastLogin', 'areas', 'name'],
    roles: ['ADMIN', 'SUB_ADMIN', 'MEDIATOR'], pagination: { total: 1, pages: 1 },
  });
  subAdmins.getStaff.mockResolvedValue({ success: true, staff: SUB, isSelf: false });
  for (const fn of ['updatePermissions', 'resetAuthenticator', 'delete'] as const) {
    subAdmins[fn].mockResolvedValue({ success: true });
  }
});

describe('staff table', () => {
  it('shows roles, areas by their catalogue names and the authenticator, with the server\'s role tabs', async () => {
    renderAt('/staff');
    const row = (await screen.findByText('Meera')).closest('tr')!;
    expect(within(row).getByText('Sub-admin')).toBeInTheDocument();
    expect(within(row).getByText('1: Chat')).toBeInTheDocument();
    expect(within(row).getByText('Set up')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mediator' }));
    await waitFor(() => expect(subAdmins.listStaff).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'MEDIATOR', page: 1 })));
    // There is no queue manager role (owner, 2026-10-21).
    expect(screen.queryByRole('button', { name: 'Queue manager' })).toBeNull();
  });

  it('sorts by a server key', async () => {
    renderAt('/staff');
    await screen.findByText('Meera');
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'lastLogin' } });
    await waitFor(() => expect(subAdmins.listStaff).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'lastLogin', dir: 'desc' })));
  });

  it('creates a sub-admin from the form on the page and opens their page', async () => {
    subAdmins.create.mockResolvedValue({ success: true, subAdmin: { userId: 'stf-1' } });
    renderAt('/staff');
    fireEvent.click(await screen.findByRole('button', { name: 'Create Sub-Admin' }));
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'Meera' } });
    fireEvent.change(screen.getByLabelText('Mobile'), { target: { value: '9876543210' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-enough-password-1' } });
    fireEvent.click(within(screen.getByRole('form', { name: 'Create a sub-admin' })).getByRole('button', { name: 'Create Sub-Admin' }));
    await waitFor(() => expect(subAdmins.create).toHaveBeenCalledWith(expect.objectContaining({ username: 'Meera', mobile: '9876543210' })));
    expect(await screen.findByRole('heading', { name: 'Meera' })).toBeInTheDocument();
  });

  it('says the server\'s refusal beside the form', async () => {
    subAdmins.create.mockRejectedValue({ response: { data: { message: 'That mobile number already has a staff account' } } });
    renderAt('/staff');
    fireEvent.click(await screen.findByRole('button', { name: 'Create Sub-Admin' }));
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText('Mobile'), { target: { value: '9876543210' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-long-enough-password-1' } });
    fireEvent.click(within(screen.getByRole('form', { name: 'Create a sub-admin' })).getByRole('button', { name: 'Create Sub-Admin' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That mobile number already has a staff account');
  });

  it('opens the account\'s page from the row', async () => {
    renderAt('/staff');
    fireEvent.click((await screen.findByText('Meera')).closest('tr')!);
    expect(await screen.findByRole('heading', { name: 'Meera' })).toBeInTheDocument();
    expect(subAdmins.getStaff).toHaveBeenCalledWith('stf-1');
  });
});

describe('staff profile', () => {
  it('saves the areas switched on the page, for this account', async () => {
    renderAt('/staff/stf-1');
    const save = await screen.findByRole('button', { name: 'Save areas' });
    expect(save).toBeDisabled();
    fireEvent.click(await screen.findByLabelText(/Players/));
    fireEvent.click(save);
    await waitFor(() => expect(subAdmins.updatePermissions).toHaveBeenCalledWith('stf-1',
      expect.objectContaining({ canManageUsers: true, canModerateChat: true })));
  });

  it('offers no queue-manager switch (the role is gone; owner, 2026-10-21)', async () => {
    renderAt('/staff/stf-1');
    await screen.findByRole('button', { name: 'Save areas' });
    expect(screen.queryByRole('switch', { name: /Queue-manager/i })).toBeNull();
  });

  it('resets the authenticator only on the second press', async () => {
    renderAt('/staff/stf-1');
    fireEvent.click(await screen.findByRole('button', { name: 'Reset authenticator' }));
    expect(subAdmins.resetAuthenticator).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, reset it' }));
    await waitFor(() => expect(subAdmins.resetAuthenticator).toHaveBeenCalledWith('stf-1'));
  });

  it('removes the sub-admin on the second press and returns to the table', async () => {
    renderAt('/staff/stf-1');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove sub-admin' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove' }));
    await waitFor(() => expect(subAdmins.delete).toHaveBeenCalledWith('stf-1'));
    // The profile's own heading also reads "Meera", so wait for the page to go
    // and the table's row to come, not for the name alone.
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Meera' })).toBeNull());
    expect(await screen.findByRole('row', { name: /Meera/ })).toBeInTheDocument();
  });

  it('shows the server\'s refusal where it was pressed', async () => {
    subAdmins.updatePermissions.mockRejectedValue({ response: { data: { message: 'A sub-admin needs at least one area.' } } });
    renderAt('/staff/stf-1');
    fireEvent.click(await screen.findByLabelText(/Players/));
    fireEvent.click(screen.getByRole('button', { name: 'Save areas' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A sub-admin needs at least one area.');
  });

  it('offers a full admin no toggles, and nobody their own authenticator reset', async () => {
    subAdmins.getStaff.mockResolvedValue({ success: true, staff: { ...SUB, roles: ['ADMIN'], areas: [] }, isSelf: true });
    renderAt('/staff/stf-1');
    expect(await screen.findByText('A full admin holds every area; there is nothing to switch.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save areas' })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset authenticator' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove sub-admin' })).toBeNull();
  });

  it('says plainly when the account is not staff', async () => {
    subAdmins.getStaff.mockRejectedValue({ response: { data: { message: 'Staff account not found.' } } });
    renderAt('/staff/nobody');
    expect(await screen.findByRole('alert')).toHaveTextContent('Staff account not found.');
  });
});
