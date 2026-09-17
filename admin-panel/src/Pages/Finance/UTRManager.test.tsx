// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The UTR screen sends what the API requires.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `check:ui-coverage` compares PATHS. It passed this screen while the resolve
 * button was completely dead: the path was right and the BODY was wrong. It
 * posted `{ resolution }` where the handler requires
 * `{ action: 'approve' | 'reject', notes }`, so every review ended in a 400 —
 * "action must be approve or reject" — and the queue could not be cleared.
 *
 * A path gate cannot see that, and neither can a route test: the handler was
 * always correct. Only something that drives the component and inspects what it
 * actually sent can. That is what this file does.
 *
 * The stat cards had the same shape of bug in the other direction — they read
 * totalFlagged / duplicateUTR / fraudAlerts / resolvedToday from an endpoint
 * that returns total / active / released / fraud / contested /
 * duplicateAttempts, so four cards rendered `undefined`.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// vi.mock is hoisted above every const in this file, so the spies must be
// created inside vi.hoisted() or the factory closes over a temporal-dead-zone
// binding and the whole module fails to mock.
const { get, post, put } = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(),
}));

vi.mock('../../services/api', () => ({ default: { get, post, put } }));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import { UTRManager } from './UTRManager';

const STATS = {
  available: true, total: 12, active: 5, released: 4,
  fraud: 2, contested: 3, duplicateAttempts: 9,
};

const FLAGGED = {
  _id: 'ord-1', orderId: 'BB-1001', type: 'DEPOSIT', fiatAmount: 2500,
  utrNumber: '123456789012', utrWarning: 'DUPLICATE_UTR', status: 'PENDING',
  createdAt: '2026-01-01T00:00:00.000Z',
  userId: { username: 'ravi', mobile: '9000000000', kycStatus: 'VERIFIED' },
};

const REGISTRY_ENTRY = {
  utr: '999888777666', orderId: 'BB-2002', userId: 'u-7', amount: 500,
  status: 'ACTIVE', registeredAt: '2026-01-01T00:00:00.000Z',
  releasedAt: null, flaggedAt: null, flaggedBy: null, flagReason: null,
  duplicateAttempts: 2, lastContestedAt: '2026-01-02T00:00:00.000Z',
};

const route = (url: string) => {
  if (url.includes('/utr/stats')) return { data: { success: true, stats: STATS } };
  if (url.includes('/utr/flagged')) return { data: { success: true, flaggedOrders: [FLAGGED] } };
  if (url.includes('/utr/contested')) return { data: { success: true, contested: [REGISTRY_ENTRY] } };
  if (url.includes('/utr-registry')) return { data: { success: true, entries: [REGISTRY_ENTRY] } };
  return { data: { success: true } };
};

beforeEach(() => {
  get.mockReset(); post.mockReset(); put.mockReset();
  get.mockImplementation((url: string) => Promise.resolve(route(url)));
  post.mockResolvedValue({ data: { success: true } });
  put.mockResolvedValue({ data: { success: true } });
});

const openReview = async () => {
  render(<UTRManager />);
  await screen.findByText('BB-1001');
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  await screen.findByText(/Review Order/);
};

describe('resolving an order held for review', () => {
  it('sends action=approve, not the resolution field the API rejects', async () => {
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: /Approve & release/ }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('/api/admin/utr/resolve/ord-1');
    expect(body).toHaveProperty('action', 'approve');
    // The exact shape that produced a 400 on every single review.
    expect(body).not.toHaveProperty('resolution');
  });

  it('sends action=reject when the operator rejects', async () => {
    await openReview();
    fireEvent.change(screen.getByPlaceholderText(/approving or rejecting/), {
      target: { value: 'reference belongs to another order' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Reject & cancel/ }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1]).toMatchObject({
      action: 'reject', notes: 'reference belongs to another order',
    });
  });

  it('refuses to reject without a reason, without calling the API', async () => {
    // Reject CANCELS the order and releases a withdrawal's escrow. An
    // unexplained cancellation is one nobody can defend to the player.
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: /Reject & cancel/ }));
    await waitFor(() => expect(post).not.toHaveBeenCalled());
  });

  it('offers approve and reject as separate decisions', async () => {
    // One "Clear" button silently picked one of them for the operator.
    await openReview();
    expect(screen.getByRole('button', { name: /Approve & release/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reject & cancel/ })).toBeInTheDocument();
  });
});

describe('the stat cards', () => {
  it('render the numbers the API actually sends', async () => {
    render(<UTRManager />);
    // Every one of these was `undefined` while the cards read field names the
    // endpoint has never returned.
    expect(await screen.findByText('12')).toBeInTheDocument(); // total
    expect(screen.getByText('9')).toBeInTheDocument();         // duplicateAttempts
    expect(screen.getByText('Reuse Attempts')).toBeInTheDocument();
    expect(screen.queryByText('undefined')).not.toBeInTheDocument();
  });
});

describe('the registry and contested queue', () => {
  it('loads the registry when its tab is opened', async () => {
    render(<UTRManager />);
    await screen.findByText('BB-1001');
    fireEvent.click(screen.getByRole('button', { name: 'Registry' }));
    await waitFor(() =>
      expect(get.mock.calls.some(([u]) => String(u).includes('/api/admin/utr-registry'))).toBe(true));
    expect(await screen.findByText('999888777666')).toBeInTheDocument();
  });

  it('flags a reference with a reason, and will not without one', async () => {
    render(<UTRManager />);
    await screen.findByText('BB-1001');
    fireEvent.click(screen.getByRole('button', { name: 'Registry' }));
    fireEvent.click(await screen.findByRole('button', { name: /Flag fraud/ }));

    const confirm = await screen.findByRole('button', { name: 'Flag as fraud' });
    expect(confirm).toBeDisabled();          // a flag nobody signed is one nobody can defend

    fireEvent.change(screen.getByPlaceholderText(/fraudulent/), { target: { value: 'reused across two players' } });
    fireEvent.click(screen.getByRole('button', { name: 'Flag as fraud' }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    const [url, body] = put.mock.calls[0];
    expect(url).toContain('/api/admin/utr-registry/999888777666/flag');
    expect(body).toMatchObject({ reason: 'reused across two players' });
  });

  it('shows the contested queue', async () => {
    render(<UTRManager />);
    await screen.findByText('BB-1001');
    fireEvent.click(screen.getByRole('button', { name: /Contested/ }));
    await waitFor(() =>
      expect(get.mock.calls.some(([u]) => String(u).includes('/utr/contested'))).toBe(true));
    expect(await screen.findByText(/2 reuse attempts/)).toBeInTheDocument();
  });
});
