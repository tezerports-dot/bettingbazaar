// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The reviewer approves the player they clicked.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `types.ts` declared `User._id`, and the server has never sent one: the users
 * repository and the KYC queue query both emit `userId`. TypeScript could not
 * catch it, because the interface WAS the wrong thing — it described a wire
 * format that did not exist, so every `u._id` typechecked and was `undefined`
 * at runtime.
 *
 * On this screen that produced three failures at once, none of which look like
 * an error:
 *
 *   `setSelectedId(u._id)` stored undefined, so `pendingKYC.find(u => u._id ===
 *   selectedId)` matched the FIRST row every time — clicking the fifth player
 *   showed the first player's details.
 *
 *   `active = selected?._id === u._id` was `undefined === undefined`, so EVERY
 *   row rendered highlighted as the selected one.
 *
 *   `handleApprove(confirmApprove._id)` called the API with undefined, so the
 *   request 404'd and the toast said the approval failed.
 *
 * This is a KYC screen: approving grants full withdrawal access. A reviewer
 * reading one player's record while acting on another is the failure that
 * matters, and it is a rendering fact no route test can see.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const { getQueue, approve, reject } = vi.hoisted(() => ({
  getQueue: vi.fn(), approve: vi.fn(), reject: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  default: { kyc: { getQueue, approve, reject } },
}));
vi.mock('../../services/sse', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { KYCQueue } from './KYCQueue';

// Exactly what the server sends: `userId`, and no `_id`.
const QUEUE = [
  { userId: 'u-first',  username: 'aarav', mobile: '9000000001', kycStatus: 'PENDING_APPROVAL' },
  { userId: 'u-second', username: 'bhavna', mobile: '9000000002', kycStatus: 'PENDING_APPROVAL' },
  { userId: 'u-third',  username: 'chetan', mobile: '9000000003', kycStatus: 'PENDING_APPROVAL' },
];

beforeEach(() => {
  getQueue.mockReset(); approve.mockReset(); reject.mockReset();
  getQueue.mockResolvedValue({ success: true, data: QUEUE });
  approve.mockResolvedValue({ success: true });
  reject.mockResolvedValue({ success: true });
});

describe('KYCQueue', () => {
  // The list only — the detail pane names the selected player too, so an
  // unscoped query matches twice and says nothing about which pane it found.
  const queueList = () => screen.getByTestId('kyc-queue-list');
  const clickInQueue = (name: string) =>
    fireEvent.click(within(queueList()).getByText(name));

  it('lists everyone waiting', async () => {
    render(<KYCQueue />);
    // Scoped to the list: the first player is auto-selected, so their name is
    // also in the detail pane.
    await waitFor(() => expect(within(queueList()).getByText('aarav')).toBeInTheDocument());
    expect(within(queueList()).getByText('bhavna')).toBeInTheDocument();
    expect(within(queueList()).getByText('chetan')).toBeInTheDocument();
  });

  it('shows the player the reviewer clicked, not the first one', async () => {
    // With `_id` this found row 0 whatever was clicked.
    render(<KYCQueue />);
    await waitFor(() => expect(within(queueList()).getByText('bhavna')).toBeInTheDocument());

    clickInQueue('bhavna');

    // The detail pane names them — so the name appears twice, in the list and
    // in the panel. One occurrence means the panel is still showing somebody
    // else.
    await waitFor(() => expect(screen.getAllByText('bhavna').length).toBeGreaterThan(1));
  });

  it('approves the player who is on screen', async () => {
    render(<KYCQueue />);
    await waitFor(() => expect(within(queueList()).getByText('chetan')).toBeInTheDocument());
    clickInQueue('chetan');

    const approveBtn = await screen.findByRole('button', { name: /approve/i });
    fireEvent.click(approveBtn);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Approve KYC$/ }));

    // Never `undefined`, and never the first player in the list.
    await waitFor(() => expect(approve).toHaveBeenCalledWith('u-third'));
  });

  it('removes only the approved player from the queue', async () => {
    // The filter compared `u._id !== userId` — undefined against a real id, so
    // it never matched and the row stayed on screen after a successful approve.
    render(<KYCQueue />);
    await waitFor(() => expect(within(queueList()).getByText('aarav')).toBeInTheDocument());
    clickInQueue('aarav');

    fireEvent.click(await screen.findByRole('button', { name: /approve/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Approve KYC$/ }));

    await waitFor(() => expect(approve).toHaveBeenCalledWith('u-first'));
    await waitFor(() => expect(within(queueList()).queryByText('aarav')).not.toBeInTheDocument());
    expect(within(queueList()).getByText('bhavna')).toBeInTheDocument();
    expect(within(queueList()).getByText('chetan')).toBeInTheDocument();
  });

  it('rejects the player who is on screen, with the reason typed', async () => {
    render(<KYCQueue />);
    await waitFor(() => expect(within(queueList()).getByText('bhavna')).toBeInTheDocument());
    clickInQueue('bhavna');

    fireEvent.click(await screen.findByRole('button', { name: /reject/i }));
    fireEvent.change(await screen.findByPlaceholderText(/clear reason/i), {
      target: { value: 'The name on the document does not match the account' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /^Reject KYC$/ }));

    await waitFor(() => expect(reject).toHaveBeenCalledWith(
      'u-second', 'The name on the document does not match the account',
    ));
  });
});
