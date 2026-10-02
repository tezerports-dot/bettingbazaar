// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Payment References screen — the `canManageUtr` area, which had no screen.
 *
 * Asserted against the CALLS the controls make, because the routes behind them
 * have their own suite through a real database (utrAdminRoutes.test.js). What
 * this file owns is that each control calls the route with what the route
 * REQUIRES (§32 S26: the old client's `resolve` sent a body its route refuses).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const entry = (over: Record<string, unknown> = {}) => ({
  utr: 'UTR123456789', orderId: 'ord-1', userId: 'u-1', amount: 500, status: 'ACTIVE',
  registeredAt: '2026-10-01T10:00:00Z', releasedAt: null, flaggedAt: null, flaggedBy: null, flagReason: null,
  duplicateAttempts: 2, lastContestedAt: '2026-10-01T11:00:00Z',
  user: { username: 'player1', mobile: '9876543210' },
  order: { orderId: 'ord-1', type: 'DEPOSIT', status: 'COMPLETED', tokenAmount: 500 },
  ...over,
});

vi.mock('../../services/api', () => ({
  default: {
    utr: {
      getStats: vi.fn(),
      getContested: vi.fn(),
      getRegistry: vi.fn(),
      lookup: vi.fn(),
      flag: vi.fn(),
      clear: vi.fn(),
      getUserHistory: vi.fn(),
    },
  },
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { UtrMonitor } from './UtrMonitor';
import api from '../../services/api';
import toast from 'react-hot-toast';

const u = api.utr as unknown as Record<string, ReturnType<typeof vi.fn>>;

describe('Payment References screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    u.getStats.mockResolvedValue({ success: true, stats: { total: 10, active: 7, released: 2, fraud: 1, contested: 3, duplicateAttempts: 5 } });
    u.getContested.mockResolvedValue({ success: true, contested: [entry()], pagination: { total: 1, page: 1, limit: 50 } });
    u.getRegistry.mockResolvedValue({ success: true, entries: [entry({ utr: 'REG1' })], pagination: { total: 1, page: 1, limit: 50 } });
    u.lookup.mockResolvedValue({ success: true, entry: entry() });
  });

  it('opens on the review queue, with the registry totals', async () => {
    render(<UtrMonitor />);
    expect(await screen.findByText('UTR123456789')).toBeInTheDocument();
    expect(u.getContested).toHaveBeenCalledWith(1, 50);
    expect(screen.getByText('Reuse attempts', { selector: 'div' }).nextSibling).toHaveTextContent('5');
  });

  it('switches to the full registry and filters by status', async () => {
    render(<UtrMonitor />);
    await screen.findByText('UTR123456789');
    fireEvent.click(screen.getByRole('tab', { name: 'All references' }));
    expect(await screen.findByText('REG1')).toBeInTheDocument();
    expect(u.getRegistry).toHaveBeenLastCalledWith(undefined, 1, 50);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'FRAUD' } });
    await waitFor(() => expect(u.getRegistry).toHaveBeenLastCalledWith('FRAUD', 1, 50));
  });

  it('looks a reference up and shows the player and the order', async () => {
    render(<UtrMonitor />);
    fireEvent.change(screen.getByLabelText('Payment reference'), { target: { value: ' utr123456789 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    await waitFor(() => expect(u.lookup).toHaveBeenCalledWith('utr123456789'));
    expect(await screen.findByText(/player1 · 9876543210/)).toBeInTheDocument();
    expect(screen.getByText('DEPOSIT · COMPLETED')).toBeInTheDocument();
  });

  it('says plainly when nobody has claimed a reference — a 404 is an answer', async () => {
    u.lookup.mockRejectedValue({ response: { status: 404, data: { message: 'UTR not found in registry' } } });
    render(<UtrMonitor />);
    fireEvent.change(screen.getByLabelText('Payment reference'), { target: { value: 'NOPE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Look up' }));
    expect(await screen.findByRole('status')).toHaveTextContent('No order has claimed "NOPE".');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('will not flag without a reason, and sends the reason the route requires', async () => {
    u.flag.mockResolvedValue({ success: true, entry: entry({ status: 'FRAUD', flagReason: 'same slip twice' }) });
    render(<UtrMonitor />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Open' }))[0]);
    const button = await screen.findByRole('button', { name: /Flag as fraud/ });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Reason for flagging/), { target: { value: '  same slip twice ' } });
    fireEvent.click(button);
    await waitFor(() => expect(u.flag).toHaveBeenCalledWith('UTR123456789', 'same slip twice'));
    expect(await screen.findByRole('button', { name: /Clear the flag/ })).toBeInTheDocument();
  });

  it('clears a flag on a FRAUD reference', async () => {
    u.lookup.mockResolvedValue({ success: true, entry: entry({ status: 'FRAUD', flaggedBy: 'admin-1', flagReason: 'x' }) });
    u.clear.mockResolvedValue({ success: true, entry: entry({ status: 'ACTIVE' }) });
    render(<UtrMonitor />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Open' }))[0]);
    fireEvent.click(await screen.findByRole('button', { name: /Clear the flag/ }));
    await waitFor(() => expect(u.clear).toHaveBeenCalledWith('UTR123456789'));
    expect(toast.success).toHaveBeenCalledWith('Flag cleared');
  });

  it("shows the server's refusal when a flag fails", async () => {
    u.flag.mockRejectedValue({ response: { status: 400, data: { message: 'A reason is required. It is what the player is shown if they appeal.' } } });
    render(<UtrMonitor />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Open' }))[0]);
    fireEvent.change(await screen.findByLabelText(/Reason for flagging/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /Flag as fraud/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('A reason is required. It is what the player is shown if they appeal.'));
  });

  it("lists the player's other references", async () => {
    u.getUserHistory.mockResolvedValue({ success: true, history: [entry({ utr: 'OTHER1', duplicateAttempts: 0 })] });
    render(<UtrMonitor />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Open' }))[0]);
    fireEvent.click(await screen.findByRole('button', { name: /This player's references/ }));
    await waitFor(() => expect(u.getUserHistory).toHaveBeenCalledWith('u-1'));
    expect(await screen.findByRole('button', { name: 'OTHER1' })).toBeInTheDocument();
  });
});
