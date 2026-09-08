// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * The parts of a split withdrawal, and which of them a player may take back.
 *
 * ── What is actually at stake ──────────────────────────────────────────────
 * A part still waiting for a merchant can be cancelled and those tokens come
 * back. A part already with a merchant cannot: they are on their way to a
 * machine, and cancelling under them would be a player recalling money a
 * merchant is about to hand over. A part that is paid is money the player has.
 *
 * The SERVER decides which is which and says so per part. This screen must not
 * re-derive it from the status string, because two places deciding the same
 * thing drift — and the direction this one would drift is offering a Cancel
 * button that 409s, or worse, hiding one that would have worked.
 *
 * The other assertion is the empty state. This codebase has repeatedly shipped
 * a failed request rendering as "nothing here", which is indistinguishable from
 * a real empty list and is how five dead admin buttons stayed live. A read that
 * fails must say so.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const client = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../services/apiClient', () => ({ default: { get: client.get, post: client.post } }));

import SplitWithdrawalLegs from './SplitWithdrawalLegs';

const legs = [
  { orderId: 'WD_a_L1', legIndex: 1, amount: 40000, status: 'COMPLETED',     cancellable: false },
  { orderId: 'WD_a_L2', legIndex: 2, amount: 40000, status: 'PROCESSING',    cancellable: false },
  { orderId: 'WD_a_L3', legIndex: 3, amount: 10000, status: 'PENDING_QUEUE', cancellable: true },
  { orderId: 'WD_a_L4', legIndex: 4, amount: 10000, status: 'PENDING_QUEUE', cancellable: true },
];

beforeEach(() => {
  client.get.mockReset();
  client.post.mockReset();
});

describe('SplitWithdrawalLegs', () => {
  it('shows every part with its own amount and where it has got to', async () => {
    client.get.mockResolvedValue({ success: true, isSplitParent: true, legs });
    render(<SplitWithdrawalLegs orderId="WD_a" />);

    await waitFor(() => expect(screen.getByText(/Part 1 · ₹40,000/)).toBeTruthy());
    expect(screen.getByText(/Part 4 · ₹10,000/)).toBeTruthy();
    // The header is the thing a player actually reads first: how much of their
    // withdrawal has happened.
    expect(screen.getByText('Paid in 4 parts · 1 done')).toBeTruthy();
    expect(screen.getByText('Merchant is at a machine')).toBeTruthy();
  });

  it('offers Cancel on exactly the parts the SERVER said are cancellable', async () => {
    client.get.mockResolvedValue({ success: true, isSplitParent: true, legs });
    render(<SplitWithdrawalLegs orderId="WD_a" />);

    await waitFor(() => expect(screen.getByText(/Part 1/)).toBeTruthy());
    // Two, not four: the paid part and the one a merchant is working are not a
    // player's to recall.
    expect(screen.getAllByRole('button', { name: 'Cancel part' })).toHaveLength(2);
  });

  it('does not invent a Cancel button from the status when the server says no', async () => {
    // The contradiction on purpose: a part that LOOKS cancellable by its status
    // but which the server has said is not. Re-deriving the rule here would
    // render a button that 409s.
    client.get.mockResolvedValue({
      success: true, isSplitParent: true,
      legs: [{ orderId: 'WD_b_L1', legIndex: 1, amount: 5000, status: 'PENDING_QUEUE', cancellable: false }],
    });
    render(<SplitWithdrawalLegs orderId="WD_b" />);

    await waitFor(() => expect(screen.getByText(/Part 1/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Cancel part' })).toBeNull();
  });

  it('cancels the LEG, not the withdrawal', async () => {
    client.get.mockResolvedValue({ success: true, isSplitParent: true, legs });
    client.post.mockResolvedValue({ success: true });
    const onChanged = vi.fn();
    render(<SplitWithdrawalLegs orderId="WD_a" onChanged={onChanged} />);

    await waitFor(() => expect(screen.getByText(/Part 3/)).toBeTruthy());
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel part' })[0]);

    // The leg's own id. Sending the parent's would cancel every waiting part of
    // the withdrawal when the player asked to drop one.
    await waitFor(() => expect(client.post).toHaveBeenCalledWith(
      '/api/payment/order/cancel', { orderId: 'WD_a_L3' },
    ));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('says a read failed instead of rendering as though there are no parts', async () => {
    client.get.mockRejectedValue(new Error('Network down'));
    render(<SplitWithdrawalLegs orderId="WD_a" />);

    // An empty list here would be indistinguishable from a withdrawal that
    // genuinely has no parts — the empty-state-as-success failure this
    // repository has shipped five times.
    await waitFor(() => expect(screen.getByText('Network down')).toBeTruthy());
  });

  it('renders nothing at all for an ordinary withdrawal', async () => {
    client.get.mockResolvedValue({ success: true, isSplitParent: false, legs: [] });
    const { container } = render(<SplitWithdrawalLegs orderId="WD_plain" />);
    await waitFor(() => expect(container.textContent).not.toContain('Loading'));
    expect(container.textContent).toBe('');
  });
});
