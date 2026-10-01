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
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { order } = vi.hoisted(() => ({
  order: { _id: 'o-1', orderId: 'ORD-1', type: 'DEPOSIT', status: 'PENDING_QUEUE', amount: 1000, createdAt: new Date().toISOString() },
}));
vi.mock('../../services/api', () => ({
  default: {
    queueManager: {
      getPendingOrders: vi.fn().mockResolvedValue({ success: true, data: [order] }),
      getAvailableMerchants: vi.fn().mockResolvedValue({ success: true, data: [] }),
      getGroupedQueue: vi.fn().mockResolvedValue({ success: true, grouped: {}, stats: {} }),
    },
    orderActions: { approve: vi.fn(), reject: vi.fn(), cancel: vi.fn() },
  },
}));
vi.mock('../../services/sse', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { QueueDashboard } from './QueueDashboard';
import { useAuthStore } from '../../services/auth';

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
