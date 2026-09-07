// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * Restoring a previous merchant bonus policy.
 *
 * The version history has been listed on this page since it shipped and there
 * was no way to act on it: the rollback endpoint existed, nothing called it, so
 * undoing a bad policy meant re-typing the old numbers off the list and hoping
 * they were read correctly.
 *
 * Two properties are asserted because both are easy to get wrong and neither
 * shows up in a screenshot: the ACTIVE version is not offered as a target (it
 * would add a version that changes nothing), and the action is confirmed before
 * it fires (the policy decides what merchants are paid).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { get, put, post } = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock('../../services/api', () => ({ default: { get, put, post } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
// The policy card — and therefore the history and its rollback buttons — is
// gated behind isAdmin. Without this the page renders the leaderboard only,
// and every assertion below fails for a reason that has nothing to do with
// rollback.
vi.mock('../../hooks/usePermission', () => ({
  usePermissions: () => ({ isAdmin: true, can: () => true, isSubAdmin: false, isQueueManager: false }),
}));

import { MerchantPlatform } from './MerchantPlatform';

const HISTORY = [
  { _id: 'v3', version: 3, enabled: true, bonusPercent: 2, minMatchedVolume: 1000, status: 'ACTIVE', createdAt: '2026-03-01T00:00:00Z' },
  { _id: 'v2', version: 2, enabled: true, bonusPercent: 5, minMatchedVolume: 500, status: 'SUPERSEDED', createdAt: '2026-02-01T00:00:00Z' },
  { _id: 'v1', version: 1, enabled: false, bonusPercent: 0, minMatchedVolume: 0, status: 'SUPERSEDED', createdAt: '2026-01-01T00:00:00Z' },
];

beforeEach(() => {
  get.mockReset(); put.mockReset(); post.mockReset();
  get.mockImplementation((url: string) => {
    if (url.includes('merchant-bonus-policy/history')) return Promise.resolve({ data: { success: true, history: HISTORY } });
    if (url.includes('merchant-bonus-policy')) return Promise.resolve({ data: { success: true, policy: HISTORY[0] } });
    return Promise.resolve({ data: { success: true } });
  });
  post.mockResolvedValue({ data: { success: true } });
});

const openHistory = async () => {
  render(<MerchantPlatform />);
  await waitFor(() => expect(get.mock.calls.some(([u]) => String(u).includes('history'))).toBe(true));
  const summary = await screen.findByText(/Version history/);
  fireEvent.click(summary);
};

describe('merchant bonus policy rollback', () => {
  it('offers a restore for superseded versions only', async () => {
    await openHistory();
    // v2 and v1 are superseded; v3 is live and must NOT be restorable.
    const buttons = await screen.findAllByRole('button', { name: /Restore/ });
    expect(buttons).toHaveLength(2);
  });

  it('confirms first, and does not call the API on cancel', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await openHistory();
    fireEvent.click((await screen.findAllByRole('button', { name: /Restore/ }))[0]);
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(post).not.toHaveBeenCalled());
  });

  it('posts the version id once confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await openHistory();
    fireEvent.click((await screen.findAllByRole('button', { name: /Restore/ }))[0]);
    await waitFor(() => expect(post).toHaveBeenCalled());
    // The FIRST superseded row is v2 — the id, not the version number, is what
    // the route keys on.
    expect(post.mock.calls[0][0]).toBe('/api/admin/merchant-bonus-policy/version/v2/rollback');
  });
});
