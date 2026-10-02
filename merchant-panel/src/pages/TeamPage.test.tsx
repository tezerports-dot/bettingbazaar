// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The merchant Team screen, for its three readers, and that the supervisor's
 * controls call the route with the TEAM they sit in (§23), showing the
 * server's refusal verbatim (§32 S14).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getMyTeam: vi.fn(),
  createTeam: vi.fn().mockResolvedValue({}),
  renameTeam: vi.fn().mockResolvedValue({}),
  deleteTeam: vi.fn().mockResolvedValue(undefined),
  addTeamMember: vi.fn().mockResolvedValue('Added.'),
  removeTeamMember: vi.fn().mockResolvedValue(undefined),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('../services/api', () => api);
vi.mock('react-hot-toast', () => ({ default: toast }));

import TeamPage from './TeamPage';

const team = (teamId: string, name: string, extra = {}) => ({
  teamId, supervisorId: 's-1', supervisorName: 'Sup', supervisorRef: 'MSUP', name, rail: 'UPI_BANK',
  approvedCount: 0, pendingCount: 0, size: 10, strength: 'STOPPED', shortSince: null, wasFull: false, createdAt: '', ...extra,
});

describe('merchant Team screen', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('a merchant in no team is shown the ID to hand to a supervisor', async () => {
    api.getMyTeam.mockResolvedValue({ role: 'NONE', publicRef: 'MABC123' });
    render(<TeamPage />);
    expect(await screen.findByText('MABC123')).toBeInTheDocument();
    expect(screen.getByText('You are not in a team')).toBeInTheDocument();
  });

  it('a pending member is told an admin still has to approve', async () => {
    api.getMyTeam.mockResolvedValue({ role: 'MEMBER', publicRef: 'M1', status: 'PENDING', team: team('t-1', 'Alpha') });
    render(<TeamPage />);
    expect(await screen.findByText('Waiting for an admin')).toBeInTheDocument();
  });

  it('a member of a team in its grace day is told it stops at midnight', async () => {
    api.getMyTeam.mockResolvedValue({ role: 'MEMBER', publicRef: 'M1', status: 'APPROVED', team: team('t-1', 'Alpha', { strength: 'GRACE', approvedCount: 9 }) });
    render(<TeamPage />);
    expect(await screen.findByText(/until midnight IST/)).toBeInTheDocument();
  });

  it('a supervisor adds a member to the team whose form they typed into — the second team, not the first', async () => {
    api.getMyTeam.mockResolvedValue({
      role: 'SUPERVISOR', rail: 'UPI_BANK', publicRef: 'MSUP',
      teams: [team('t-1', 'Alpha'), team('t-2', 'Bravo')], members: [],
    });
    render(<TeamPage />);
    const box = await screen.findByLabelText(/Add a member to Bravo/);
    fireEvent.change(box, { target: { value: ' MXYZ ' } });
    fireEvent.submit(box.closest('form')!);
    await waitFor(() => expect(api.addTeamMember).toHaveBeenCalledWith('t-2', 'MXYZ'));
  });

  it('a supervisor removes the member on the row pressed', async () => {
    api.getMyTeam.mockResolvedValue({
      role: 'SUPERVISOR', rail: 'UPI_BANK', publicRef: 'MSUP',
      teams: [team('t-1', 'Alpha', { approvedCount: 2 })],
      members: [
        { merchantId: 'm-1', teamId: 't-1', name: 'Asha', publicRef: 'MA', status: 'APPROVED', isOnline: false },
        { merchantId: 'm-2', teamId: 't-1', name: 'Bhanu', publicRef: 'MB', status: 'APPROVED', isOnline: false },
      ],
    });
    render(<TeamPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Bhanu' }));
    await waitFor(() => expect(api.removeTeamMember).toHaveBeenCalledWith('t-1', 'm-2'));
  });

  it('shows the server refusal verbatim', async () => {
    api.getMyTeam.mockResolvedValue({ role: 'SUPERVISOR', rail: 'CASH', publicRef: 'MSUP', teams: [], members: [] });
    api.createTeam.mockRejectedValueOnce(new Error('A supervisor can run at most 4 teams.'));
    render(<TeamPage />);
    const box = await screen.findByLabelText('New team name');
    fireEvent.change(box, { target: { value: 'Fifth' } });
    fireEvent.submit(box.closest('form')!);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A supervisor can run at most 4 teams.'));
  });
});
