// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * The screen where a player's account gets closed — or does not.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `check:ui-coverage` compares PATHS, so it passes any screen whose URLs are
 * right. It cannot see a screen that fetches correctly and then renders the
 * wrong thing, and on this screen the wrong thing is an admin blocking a player
 * without the evidence in front of them.
 *
 * The two facts that actually matter here are both rendering facts:
 *   1. the merchant's proof image is on screen before either button is usable;
 *   2. a rejection with NO proof says so, loudly, instead of looking identical
 *      to one that has evidence.
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

const WITH_PROOF = {
  userId: 'u-1', username: 'ravi', mobile: '9000000001',
  warningCount: 4, paymentFlagCount: 4, paymentFlagReason: 'No credit',
  paymentFlaggedAt: '2026-09-01T00:00:00.000Z', isBlocked: false,
  overWarningThreshold: true,
  lastRejection: {
    orderId: 'BB-1001', reason: 'No credit against UTR 999888777666',
    proofUrl: 'https://cdn.test/statement.jpg',
    rejectedAt: '2026-09-01T00:00:00.000Z', merchantId: 'mrc-1', amountPaise: 50000,
  },
};

const WITHOUT_PROOF = {
  ...WITH_PROOF, userId: 'u-2', username: 'sunil', mobile: '9000000002',
  warningCount: 1, overWarningThreshold: false,
  lastRejection: {
    ...WITH_PROOF.lastRejection, orderId: 'BB-1002', proofUrl: null,
    reason: 'Wrong amount credited, short by 200',
  },
};

beforeEach(() => {
  getFlagged.mockReset(); blockUser.mockReset(); clearFlag.mockReset();
  getFlagged.mockResolvedValue({
    success: true, warningThreshold: 3, players: [WITH_PROOF, WITHOUT_PROOF],
  });
  blockUser.mockResolvedValue({ success: true });
  clearFlag.mockResolvedValue({ success: true });
});

describe('FlaggedPlayers', () => {
  it("shows the merchant's reason and the proof image", async () => {
    render(<FlaggedPlayers />);
    await waitFor(() => expect(screen.getByText('ravi')).toBeInTheDocument());

    expect(screen.getByText(/No credit against UTR 999888777666/)).toBeInTheDocument();
    const proof = screen.getByAltText("Merchant's proof") as HTMLImageElement;
    expect(proof.src).toBe('https://cdn.test/statement.jpg');
  });

  it('says so when a complaint has no proof behind it', async () => {
    // Hidden, this reads exactly like a complaint that came with evidence.
    render(<FlaggedPlayers />);
    await waitFor(() => expect(screen.getByText('sunil')).toBeInTheDocument());
    expect(screen.getByText(/No proof image on this rejection/i)).toBeInTheDocument();
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
    getFlagged.mockResolvedValue({ success: true, warningThreshold: 7, players: [WITH_PROOF] });
    render(<FlaggedPlayers />);
    await waitFor(() => expect(screen.getByText('7')).toBeInTheDocument());
    expect(screen.getByText('4 / 7')).toBeInTheDocument();
  });

  it('does not offer to block a player who is already blocked', async () => {
    getFlagged.mockResolvedValue({
      success: true, warningThreshold: 3,
      players: [{ ...WITH_PROOF, isBlocked: true }],
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
