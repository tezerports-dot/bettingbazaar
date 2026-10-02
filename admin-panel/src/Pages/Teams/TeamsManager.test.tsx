// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The admin Teams screen calls the route each control names, with the id of
 * the ROW it sits on (§23), and shows the server's refusal verbatim (§32 S14).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const listing = {
  success: true,
  supervisors: [{ merchantId: 's-1', name: 'Sup One', publicRef: 'MSUP1', rail: 'UPI_BANK', isOnline: true }],
  teams: [{ teamId: 't-1', supervisorId: 's-1', supervisorName: 'Sup One', supervisorRef: 'MSUP1', name: 'Alpha',
    rail: 'UPI_BANK', approvedCount: 1, pendingCount: 2, size: 10, strength: 'STOPPED', shortSince: null, wasFull: false, createdAt: '' }],
  members: [
    { merchantId: 'm-1', teamId: 't-1', name: 'Asha', publicRef: 'MA', status: 'APPROVED', isOnline: false, addedBy: 's-1', addedAt: '', approvedBy: 'a', approvedAt: '' },
    { merchantId: 'm-2', teamId: 't-1', name: 'Bhanu', publicRef: 'MB', status: 'PENDING', isOnline: false, addedBy: 's-1', addedAt: '', approvedBy: null, approvedAt: null },
    { merchantId: 'm-3', teamId: 't-1', name: 'Chitra', publicRef: 'MC', status: 'PENDING', isOnline: false, addedBy: 's-1', addedAt: '', approvedBy: null, approvedAt: null },
  ],
};

vi.mock('../../services/api', () => ({
  default: {
    teams: {
      list: vi.fn(),
      setSupervisor: vi.fn().mockResolvedValue({ success: true }),
      approveMember: vi.fn().mockResolvedValue({ success: true }),
      rejectMember: vi.fn().mockResolvedValue({ success: true }),
      removeMember: vi.fn().mockResolvedValue({ success: true }),
    },
  },
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { TeamsManager } from './TeamsManager';
import api from '../../services/api';
import toast from 'react-hot-toast';

describe('admin Teams screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.teams.list as any).mockResolvedValue(listing);
  });

  it('approves the member on the row pressed — the second pending row, not the first', async () => {
    render(<TeamsManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve Chitra' }));
    await waitFor(() => expect(api.teams.approveMember).toHaveBeenCalledWith('m-3'));
    expect(api.teams.approveMember).toHaveBeenCalledTimes(1);
  });

  it('rejects and removes by the row\'s own id', async () => {
    render(<TeamsManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject Bhanu' }));
    await waitFor(() => expect(api.teams.rejectMember).toHaveBeenCalledWith('m-2'));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Asha' }));
    await waitFor(() => expect(api.teams.removeMember).toHaveBeenCalledWith('m-1'));
  });

  it('makes a supervisor with the rail chosen', async () => {
    render(<TeamsManager />);
    fireEvent.change(await screen.findByLabelText('Merchant ID'), { target: { value: ' m-9 ' } });
    fireEvent.change(screen.getByLabelText('Rail'), { target: { value: 'CASH' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make supervisor' }));
    await waitFor(() => expect(api.teams.setSupervisor).toHaveBeenCalledWith('m-9', 'CASH'));
  });

  it('shows the server refusal verbatim', async () => {
    (api.teams.approveMember as any).mockRejectedValueOnce({ response: { data: { message: 'That team already has 10 members.' } } });
    render(<TeamsManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve Bhanu' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('That team already has 10 members.'));
  });

  it('offers to remove the role only from a supervisor with no teams', async () => {
    render(<TeamsManager />);
    await screen.findByText('Sup One');
    expect(screen.queryByRole('button', { name: 'Remove supervisor role' })).not.toBeInTheDocument();
  });
});
