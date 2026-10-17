// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The screen where a player's account gets closed — or does not.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `check:ui-coverage` compares PATHS, so it passes any screen whose URLs are
 * right. It cannot see a screen that fetches correctly and then renders the
 * wrong thing, and on this screen the wrong thing is an admin blocking a player
 * without the evidence in front of them.
 *
 * The fact that matters here is a rendering fact: the merchant's reason and
 * the order it is about are on screen before either button is usable. A
 * rejection carries a reason only (owner, 2026-10-17), so no image is shown.
 *
 * A route test cannot assert either.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const { getFlagged, blockUser, clearFlag } = vi.hoisted(() => ({
  getFlagged: vi.fn(), blockUser: vi.fn(), clearFlag: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  default: { users: { getFlagged, blockUser, clearFlag } },
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { FlaggedPlayers } from './FlaggedPlayers';

const FIRST = {
  userId: 'u-1', username: 'ravi', mobile: '9000000001',
  warningCount: 4, paymentFlagCount: 4, paymentFlagReason: 'No credit',
  paymentFlaggedAt: '2026-09-01T00:00:00.000Z', isBlocked: false,
  overWarningThreshold: true,
  lastRejection: {
    orderId: 'BB-1001', reason: 'No credit against UTR 999888777666',
    rejectedAt: '2026-09-01T00:00:00.000Z', merchantId: 'mrc-1', amountPaise: 50000,
  },
};

const SECOND = {
  ...FIRST, userId: 'u-2', username: 'sunil', mobile: '9000000002',
  warningCount: 1, overWarningThreshold: false,
  lastRejection: {
    ...FIRST.lastRejection, orderId: 'BB-1002',
    reason: 'Wrong amount credited, short by 200',
  },
};

beforeEach(() => {
  getFlagged.mockReset(); blockUser.mockReset(); clearFlag.mockReset();
  getFlagged.mockResolvedValue({
    success: true, warningThreshold: 3, players: [FIRST, SECOND],
  });
  blockUser.mockResolvedValue({ success: true });
  clearFlag.mockResolvedValue({ success: true });
});

describe('FlaggedPlayers', () => {
  it("shows the merchant's reason and the order it is about, and no image", async () => {
    render(<FlaggedPlayers />);
    await waitFor(() => expect(screen.getByText('ravi')).toBeInTheDocument());
    expect(screen.getByText(/No credit against UTR 999888777666/)).toBeInTheDocument();
    expect(screen.getByText(/Order BB-1001/)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /proof/i })).toBeNull();
  });

  it('will not submit a block without a reason of real length', async () => {
    // `users_blocked_has_reason` refuses a blocked row with no reason, so an
    // empty box is a 400 the admin cannot act on. It is caught here, where they
    // can still type one.
    render(<FlaggedPlayers />);
    await waitFor(() => expect(screen.getByText('ravi')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText(/Block player/)[0]);
    // Scoped to the modal: the card behind it carries a button of the same name.
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: /^Block player$/ });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/Third unverified payment claim/), {
      target: { value: 'Third unverified claim; proof shows no credit.' },
    });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => expect(blockUser).toHaveBeenCalledWith(
      'u-1', 'Third unverified claim; proof shows no credit.',
    ));
  });

  it('clears a flag without resetting warnings unless asked', async () => {
    // The default matters: clearing one wrong complaint must not erase the
    // record of every earlier one.
    render(<FlaggedPlayers />);
    await waitFor(() => expect(screen.getByText('ravi')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText(/Clear flag/)[0]);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Clear flag$/ }));

    await waitFor(() => expect(clearFlag).toHaveBeenCalledWith('u-1', false));
  });

  it('resets warnings when the admin ticks the box', async () => {
    render(<FlaggedPlayers />);
    await waitFor(() => expect(screen.getByText('ravi')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText(/Clear flag/)[0]);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: /^Clear flag$/ }));

    await waitFor(() => expect(clearFlag).toHaveBeenCalledWith('u-1', true));
  });

  it('reports the threshold it was given rather than assuming one', async () => {
    // The number comes from the admin's own risk rules. Hard-coding 3 here
    // would show an operator who changed it a figure the server disagrees with.
    getFlagged.mockResolvedValue({ success: true, warningThreshold: 7, players: [FIRST] });
    render(<FlaggedPlayers />);
    await waitFor(() => expect(screen.getByText('7')).toBeInTheDocument());
    expect(screen.getByText('4 / 7')).toBeInTheDocument();
  });

  it('does not offer to block a player who is already blocked', async () => {
    getFlagged.mockResolvedValue({
      success: true, warningThreshold: 3,
      players: [{ ...FIRST, isBlocked: true }],
    });
    render(<FlaggedPlayers />);
    const btn = await screen.findByText(/Already blocked/);
    expect(btn.closest('button')).toBeDisabled();
  });

  it('renders an explicit all-clear rather than a blank screen', async () => {
    getFlagged.mockResolvedValue({ success: true, warningThreshold: 3, players: [] });
    render(<FlaggedPlayers />);
    await waitFor(() => expect(screen.getByText(/No flagged players/)).toBeInTheDocument());
  });
});
