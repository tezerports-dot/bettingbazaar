// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Dispute Manager asks the queue in the queue's own words.
 *
 * ── The defect this holds ─────────────────────────────────────────────────
 * The screen kept its own filter list ("all", "DISPUTED", "RESOLVED",
 * "ESCALATED") and opened on "all", which the server read as an order STATE:
 * the default view listed nothing, and "Resolved"/"Escalated" asked for states
 * no order is ever in. Only "Open" worked. Now the screen sends no filter on
 * arrival, shows the one the server applied, and offers exactly the list the
 * server returns (`DISPUTE_FILTERS`, orders.record.js; the route's own test is
 * backend/tests/routes/disputeQueuePg.test.js).
 *
 * Beside it, three things the screen got wrong about what the server sends:
 * a decided dispute's decision was shown only for status 'RESOLVED' (never
 * sent: a decided dispute is COMPLETED or CANCELLED); the merchant was read as
 * `merchantId.username` (the server sends `name`), so the line was blank; and
 * the queue's total and page count were ignored, so page one of many read as
 * all of them (§32 S47).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../services/api', () => ({ default: { get, post } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { DisputeManager } from './DisputeManager';

const FILTERS = [
  { key: 'OPEN', label: 'Open' },
  { key: 'ESCALATED', label: 'Open, escalated' },
  // A filter only the server knows about: the screen must offer it anyway.
  { key: 'SOMETHING_NEW', label: 'A filter the server added' },
];

const row = (over: Record<string, unknown> = {}) => ({
  _id: 'DEP_1', orderId: 'DEP_1', type: 'DEPOSIT', amount: 50000, fiatAmount: 50000, tokenAmount: 50000,
  status: 'DISPUTED', createdAt: '2026-10-07T10:00:00.000Z',
  userId: { userId: 'u-1', username: 'ravi', mobile: '9000000001' },
  merchantId: { merchantId: 'm-1', name: 'Asha Traders', mobile: '8000000001' },
  disputeReason: 'I paid and nothing was credited', disputeDecision: null, resolvedAt: null,
  suspendsIfToUser: 'MERCHANT', suspendsIfToMerchant: 'PLAYER',
  ...over,
});

const answer = (over: Record<string, unknown> = {}) => ({
  data: {
    success: true, disputes: [row()], total: 1, page: 1, limit: 50, pages: 1,
    filter: 'OPEN', filters: FILTERS, ...over,
  },
});

const lastParams = () => {
  const asked = get.mock.calls.filter(([url]) => url === '/api/admin/dispute-orders');
  return asked[asked.length - 1]?.[1]?.params;
};

beforeEach(() => {
  get.mockReset(); post.mockReset();
  get.mockResolvedValue(answer());
});

describe('DisputeManager', () => {
  it('asks with no filter on arrival, and lists what the server applied', async () => {
    render(<DisputeManager />);
    await waitFor(() => expect(screen.getByText('DEP_1')).toBeInTheDocument());
    expect(lastParams()).toEqual({ page: 1 });
    expect((screen.getByLabelText('Filter disputes by status') as HTMLSelectElement).value).toBe('OPEN');
  });

  it('offers exactly the filters the server sends, and none of its own', async () => {
    render(<DisputeManager />);
    const select = await screen.findByLabelText('Filter disputes by status');
    const offered = within(select).getAllByRole('option').map((o) => [(o as HTMLOptionElement).value, o.textContent]);
    expect(offered).toEqual(FILTERS.map((f) => [f.key, f.label]));
  });

  it('a filter chosen is asked for by its key, from the first page', async () => {
    render(<DisputeManager />);
    const select = await screen.findByLabelText('Filter disputes by status');
    get.mockResolvedValue(answer({ filter: 'SOMETHING_NEW', disputes: [] }));
    fireEvent.change(select, { target: { value: 'SOMETHING_NEW' } });
    await waitFor(() => expect(lastParams()).toEqual({ page: 1, filter: 'SOMETHING_NEW' }));
    expect(await screen.findByText('No disputes under "A filter the server added"')).toBeInTheDocument();
  });

  it('a decided dispute shows its decision', async () => {
    get.mockResolvedValue(answer({
      disputes: [row({ status: 'CANCELLED', disputeDecision: 'RELEASE_TO_MERCHANT', resolvedAt: '2026-10-07T11:00:00.000Z' })],
    }));
    render(<DisputeManager />);
    expect(await screen.findByText(/Decision: RELEASE TO MERCHANT/)).toBeInTheDocument();
    // A decided dispute is not offered for deciding again.
    expect(screen.queryByRole('button', { name: /View Chat \+ Resolve/ })).toBeNull();
  });

  it('names the merchant the server sends', async () => {
    render(<DisputeManager />);
    expect(await screen.findByText('Asha Traders')).toBeInTheDocument();
  });

  it('says how many there are, and pages through them', async () => {
    get.mockResolvedValue(answer({
      disputes: [row(), row({ _id: 'DEP_2', orderId: 'DEP_2' })], total: 120, pages: 3, limit: 50,
    }));
    render(<DisputeManager />);
    expect(await screen.findByRole('status')).toHaveTextContent('Showing 1–2 of 120 disputes · Open · page 1 of 3');
    expect(screen.getByRole('button', { name: 'Previous page of disputes' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next page of disputes' }));
    await waitFor(() => expect(lastParams()).toEqual({ page: 2 }));
  });
});
