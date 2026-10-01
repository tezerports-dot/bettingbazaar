// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A chat ban can be seen, and lifted, from the screen that places it.
 *
 * `DELETE /api/admin/chat/ban/:userId`, its audit row, and `api.chat.unbanUser`
 * all existed; the screen loaded the ban list only to COUNT it. A moderator who
 * banned the wrong person had no way to undo it. Found by the route-coverage
 * report's "client methods no screen calls".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { chat } = vi.hoisted(() => ({
  chat: {
    getTickets: vi.fn(), getMessages: vi.fn(), getBans: vi.fn(), getTicket: vi.fn(),
    deleteMessage: vi.fn(), banUser: vi.fn(), unbanUser: vi.fn(), reply: vi.fn(),
  },
}));
vi.mock('../../services/api', () => ({ default: { chat } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { ChatSupport } from './ChatSupport';

describe('chat bans on the moderation screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chat.getTickets.mockResolvedValue({ success: true, tickets: [], openCount: 0 });
    chat.getMessages.mockResolvedValue({ success: true, messages: [] });
  });

  it('lists each ban with its reason and term, and lifts the one pressed', async () => {
    chat.getBans
      .mockResolvedValueOnce({ success: true, bans: [
        { userId: 'u-spam', reason: 'flooding the room', banUntil: '2026-10-02T08:00:00Z', active: true },
        { userId: 'u-abuse', reason: 'abuse', banUntil: null, active: true },
      ] })
      .mockResolvedValue({ success: true, bans: [
        { userId: 'u-abuse', reason: 'abuse', banUntil: null, active: true },
      ] });
    chat.unbanUser.mockResolvedValue({ success: true });

    render(<ChatSupport />);
    expect(await screen.findByText('u-spam')).toBeInTheDocument();
    expect(screen.getByText(/flooding the room · until/)).toBeInTheDocument();
    expect(screen.getByText(/abuse · permanent/)).toBeInTheDocument();

    const row = screen.getByText('u-spam').closest('li')!;
    fireEvent.click(row.querySelector('button')!);
    await waitFor(() => expect(chat.unbanUser).toHaveBeenCalledWith('u-spam'));
    // Only the one pressed — the other ban stays (the bystander).
    expect(chat.unbanUser).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText('u-spam')).not.toBeInTheDocument());
    expect(screen.getByText('u-abuse')).toBeInTheDocument();
  });

  it('says nobody is banned when nobody is (the opposite case)', async () => {
    chat.getBans.mockResolvedValue({ success: true, bans: [] });
    render(<ChatSupport />);
    expect(await screen.findByText('Nobody is banned from public chat.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Lift ban' })).not.toBeInTheDocument();
  });
});
