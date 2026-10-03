// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Queue Manager screen offers money decisions only to the disputes area.
 *
 * Approve / Reject / Cancel call POST /payment-orders/:id/action, which is
 * canResolveDisputes; a queue manager — the role this screen is for — holds no
 * areas, and was shown all three and refused on press. "Video KYC" called a
 * client stub that threw "not implemented on the server": a control for a
 * feature that does not exist (§32 S22), now gone. Measured by the cross-area
 * sweep of every admin screen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { order, assigned, queue, toastMock } = vi.hoisted(() => ({
  order: { _id: 'o-1', orderId: 'ORD-1', type: 'DEPOSIT', status: 'PENDING_QUEUE', amount: 1000, tokenAmount: 1000, fiatAmount: 1000, currency: 'INR', paymentMode: 'CASH_ATM', createdAt: new Date().toISOString() },
  assigned: { _id: 'o-2', orderId: 'ORD-2', type: 'WITHDRAWAL', status: 'ASSIGNED', amount: 2000, tokenAmount: 2000, fiatAmount: 2000, currency: 'INR', paymentMode: 'P2P_UPI', createdAt: new Date().toISOString() },
  queue: {
    getPendingOrders: vi.fn(),
    getGroupedQueue: vi.fn(),
    assignOrder: vi.fn(),
    reassignOrder: vi.fn(),
  },
  toastMock: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('../../services/api', () => ({
  default: {
    queueManager: queue,
    orderActions: { approve: vi.fn(), reject: vi.fn(), cancel: vi.fn() },
  },
}));
vi.mock('../../services/sse', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('react-hot-toast', () => ({ default: toastMock }));

import { QueueDashboard } from './QueueDashboard';
import { useAuthStore } from '../../services/auth';

beforeEach(() => {
  vi.clearAllMocks();
  queue.getPendingOrders.mockResolvedValue({ success: true, data: [order] });
  queue.getGroupedQueue.mockResolvedValue({
    success: true, grouped: { pending: [order], assigned: [assigned] }, stats: { total: 2, pending: 1, assigned: 1 },
  });
});

const as = (admin: Record<string, unknown>) => useAuthStore.setState({
  isAuthenticated: true, token: 't', mustEnroll2FA: false, pendingChallenge: null,
  admin: { userId: 's-1', username: 'staff', ...admin } as any,
});

describe('Queue Manager screen controls, by area', () => {
  it('a queue manager sees the order and can assign it, but is not offered Approve/Reject/Cancel', async () => {
    as({ isAdmin: false, isQueueManager: true });
    render(<QueueDashboard />);
    expect(await screen.findByText('ORD-1')).toBeInTheDocument();
    expect(screen.queryByText(/Approve/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Reject/)).not.toBeInTheDocument();
    expect(screen.queryByText(/🚫 Cancel/)).not.toBeInTheDocument();
  });

  it('a full admin is offered them (the opposite case), and nobody is offered Video KYC', async () => {
    as({ isAdmin: true });
    render(<QueueDashboard />);
    expect(await screen.findByText('ORD-1')).toBeInTheDocument();
    expect(screen.getByText(/Approve/)).toBeInTheDocument();
    expect(screen.getByText(/Reject/)).toBeInTheDocument();
    expect(screen.queryByText(/Video KYC/)).not.toBeInTheDocument();
  });
});

/**
 * Routing, not a merchant picker. The assign and reassign routes take NO body
 * (merchant.assignment.routes.js): the server picks the member. A refusal is a
 * 409 NO_MEMBER_FREE whose sentence is the only thing that says why, so it is
 * what the toast shows.
 */
describe('Queue Manager routes orders instead of hand-picking a merchant', () => {
  it('offers no merchant picker; a queued order gets "Offer to teams now", sent with no merchant', async () => {
    as({ isAdmin: false, isQueueManager: true });
    queue.assignOrder.mockResolvedValue({ success: true, message: 'Order assigned' });
    render(<QueueDashboard />);
    expect(await screen.findByText('ORD-1')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByText(/Merchant Pool/)).not.toBeInTheDocument();
    expect(screen.getByText('Cash (ATM)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Offer to teams now/ }));
    await waitFor(() => expect(queue.assignOrder).toHaveBeenCalledTimes(1));
    expect(queue.assignOrder.mock.calls[0]).toEqual(['o-1']);
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Order assigned'));
  });

  it('shows the server\'s NO_MEMBER_FREE sentence when nobody can take the order', async () => {
    as({ isAdmin: false, isQueueManager: true });
    const message = 'No member can take this order right now: every working team on its rail is at its cap, '
      + 'not ready, or short of pool tokens. It stays queued and is offered again automatically.';
    queue.assignOrder.mockRejectedValue({ response: { status: 409, data: { success: false, code: 'NO_MEMBER_FREE', message } } });
    render(<QueueDashboard />);
    fireEvent.click(await screen.findByRole('button', { name: /Offer to teams now/ }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(message));
  });

  it('an ASSIGNED order is offered Reassign (no merchant argument); other statuses are offered neither', async () => {
    as({ isAdmin: false, isQueueManager: true });
    queue.reassignOrder.mockResolvedValue({
      success: true, message: 'Order taken off its member. Nobody else is free yet; it stays queued and is offered again automatically.',
    });
    render(<QueueDashboard />);
    await screen.findByText('ORD-1');
    fireEvent.click(screen.getByRole('button', { name: /All Orders/ }));
    expect(await screen.findByText('ORD-2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Reassign/ }));
    await waitFor(() => expect(queue.reassignOrder).toHaveBeenCalledTimes(1));
    expect(queue.reassignOrder.mock.calls[0]).toEqual(['o-2']);
    expect(queue.assignOrder).not.toHaveBeenCalled();
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith(expect.stringMatching(/Nobody else is free yet/)));
  });
});
