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
    rail: 'UPI_BANK', approvedCount: 1, pendingCount: 2, size: 10, strength: 'WORKING', createdAt: '',
    poolAvailablePaise: 0, poolHeldPaise: 0,
    commission: { teamId: 't-1', buysPaise: 0, sellsPaise: 0, matchedPaise: 0, highPaise: 0, paidPaise: 0, owedPaise: 0,
      commissionPercent: 10, supervisorSharePercent: 16 } }],
  members: [
    { merchantId: 'm-1', teamId: 't-1', name: 'Asha', publicRef: 'MA', status: 'APPROVED', isOnline: false, routingPriority: 3, addedBy: 's-1', addedAt: '', approvedBy: 'a', approvedAt: '' },
    { merchantId: 'm-2', teamId: 't-1', name: 'Bhanu', publicRef: 'MB', status: 'PENDING', isOnline: false, routingPriority: 3, addedBy: 's-1', addedAt: '', approvedBy: null, approvedAt: null },
    { merchantId: 'm-3', teamId: 't-1', name: 'Chitra', publicRef: 'MC', status: 'PENDING', isOnline: false, routingPriority: 3, addedBy: 's-1', addedAt: '', approvedBy: null, approvedAt: null },
  ],
  routingPriority: { MIN: 1, MAX: 5, DEFAULT: 3 },
};

vi.mock('../../services/api', () => ({
  default: {
    teams: {
      list: vi.fn(),
      setSupervisor: vi.fn().mockResolvedValue({ success: true }),
      approveMember: vi.fn().mockResolvedValue({ success: true }),
      rejectMember: vi.fn().mockResolvedValue({ success: true }),
      removeMember: vi.fn().mockResolvedValue({ success: true }),
      setPriority: vi.fn().mockResolvedValue({ success: true, priority: 5, message: 'Priority set to 5.' }),
      redFlags: vi.fn(),
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
    (api.teams.redFlags as any).mockResolvedValue({ success: true, flags: [] });
  });

  // ── Red flags (Step 2f) ──────────────────────────────────────────────────
  it('shows a low-activity flag with the member and the team average', async () => {
    (api.teams.redFlags as any).mockResolvedValue({ success: true, flags: [
      { flagId: '2', kind: 'LOW_ACTIVITY', flagDay: '2026-10-03', teamId: 't-1', teamName: 'Alpha', supervisorId: 's-1',
        merchantId: 'm-1', merchantName: 'Zoya', merchantRef: 'MZ', createdAt: '',
        details: { completedOrders: 0, onlineSeconds: 300, teamAverageOrders: 4.2, teamAverageOnlineSeconds: 7800, members: 10, percent: 25 } },
    ] });
    render(<TeamsManager />);
    expect(await screen.findByText('Low activity')).toBeInTheDocument();
    expect(screen.getByText(/0 orders, 5m online \(team average 4.2 orders, 2h 10m\)/)).toBeInTheDocument();
    expect(screen.getByText('Zoya')).toBeInTheDocument();
    await waitFor(() => expect(api.teams.redFlags).toHaveBeenCalledWith(30));
  });

  it('says so when there are no red flags', async () => {
    render(<TeamsManager />);
    expect(await screen.findByText('No red flags.')).toBeInTheDocument();
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

  // ── Routing priority (Phase A) ───────────────────────────────────────────
  it('sets the routing priority of the member on the row, from the server\'s range', async () => {
    render(<TeamsManager />);
    const picker = await screen.findByLabelText('Priority for Asha') as HTMLSelectElement;
    expect(picker.value).toBe('3');
    expect([...picker.options].map((o) => o.value)).toEqual(['1', '2', '3', '4', '5']);
    fireEvent.change(picker, { target: { value: '5' } });
    await waitFor(() => expect(api.teams.setPriority).toHaveBeenCalledWith('m-1', 5));
    expect(api.teams.setPriority).toHaveBeenCalledTimes(1);
    // The screen reloads what the server now says.
    await waitFor(() => expect(api.teams.list).toHaveBeenCalledTimes(2));
  });

  it('shows the priority refusal verbatim', async () => {
    (api.teams.setPriority as any).mockRejectedValueOnce({ response: { data: { message: 'Priority is a whole number from 1 to 5.' } } });
    render(<TeamsManager />);
    fireEvent.change(await screen.findByLabelText('Priority for Asha'), { target: { value: '1' } });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Priority is a whole number from 1 to 5.'));
  });

  it('a team with one approved member is shown as working', async () => {
    render(<TeamsManager />);
    expect(await screen.findByText('Working')).toBeInTheDocument();
    expect(screen.queryByText(/needs 10/)).toBeNull();
  });

  it('makes a supervisor with the rail chosen', async () => {
    render(<TeamsManager />);
    fireEvent.change(await screen.findByLabelText('Agent ID'), { target: { value: ' m-9 ' } });
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
