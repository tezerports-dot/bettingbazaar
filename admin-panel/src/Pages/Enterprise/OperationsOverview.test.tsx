// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The operations console reaches the endpoints it exists for.
 *
 * `/communication/channels` and `/communication/admin-activity` were built and
 * unreachable. `/leaderboard/rebuild` too — the board the player panel reads is
 * derived, so after a correction or a backfill there was no way to recompute it
 * short of calling the API by hand.
 *
 * The rebuild is confirmed before it fires. It recomputes every period, and a
 * maintenance action that runs on a stray click is one nobody trusts.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../services/api', () => ({ default: { get, post } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { OperationsOverview } from './OperationsOverview';
import { useAuthStore } from '../../services/auth';

/**
 * The overview tab is left UNSET on purpose (`success: false`, so `overview`
 * stays null and that block renders nothing). These cases are about the
 * Channels & Activity tab, and modelling the whole overview payload to reach a
 * different tab makes the mock the thing under test.
 *
 * Worth recording, because it cost a cycle here: the overview tab dereferences
 * `overview.settlement.ledgerIntegrityOk` straight through, so a PARTIAL
 * payload throws and takes the entire console down — its `overview && (…)`
 * guard only protects against null, not against a response missing a section.
 */
const CHANNELS = [
  { code: 'IN_APP', label: 'In-app notification inbox', active: true },
  { code: 'SMS', label: 'SMS', active: false },
];

beforeEach(() => {
  get.mockReset(); post.mockReset();
  // A full admin: the maintenance controls are the canRunMaintenance area.
  useAuthStore.setState({ admin: { isAdmin: true } as any, isAuthenticated: true });
  get.mockImplementation((url: string) => {
    if (url.includes('operations/overview')) return Promise.resolve({ data: { success: false } });
    if (url.includes('config-catalog')) return Promise.resolve({ data: { success: true, catalog: [] } });
    if (url.includes('audit-feed')) return Promise.resolve({ data: { success: true, feed: [] } });
    if (url.includes('communication/channels')) return Promise.resolve({ data: { success: true, channels: CHANNELS } });
    if (url.includes('admin-activity')) return Promise.resolve({ data: { success: true, activity: [{ performedBy: 'a1', performedByName: 'Asha', actions: 12 }] } });
    return Promise.resolve({ data: { success: true } });
  });
  post.mockResolvedValue({ data: { success: true, periods: 3 } });
});

const called = (f: string) => get.mock.calls.some(([u]) => String(u).includes(f));
const openChannels = async () => {
  render(<OperationsOverview />);
  await waitFor(() => expect(called('operations/overview')).toBe(true));
  fireEvent.click(screen.getByText('Channels & Activity'));
};

describe('the operations console', () => {
  it('asks for channels and admin activity on load', async () => {
    render(<OperationsOverview />);
    await waitFor(() => {
      expect(called('/api/admin/communication/channels')).toBe(true);
      expect(called('/api/admin/communication/admin-activity')).toBe(true);
    });
  });

  it('shows which channels are configured and which are not', async () => {
    // A declared channel with no provider FAILS when sent to; it does not
    // silently do nothing. The distinction has to be visible.
    await openChannels();
    expect(await screen.findByText('In-app notification inbox')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
  });

  it('shows admin activity for the window', async () => {
    await openChannels();
    expect(await screen.findByText('Asha')).toBeInTheDocument();
    expect(screen.getByText(/12 action/)).toBeInTheDocument();
  });

  it('confirms before rebuilding the leaderboard, and does not call on cancel', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await openChannels();
    fireEvent.click(await screen.findByRole('button', { name: /Rebuild leaderboard/ }));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(post).not.toHaveBeenCalled());
  });

  it('rebuilds once confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await openChannels();
    fireEvent.click(await screen.findByRole('button', { name: /Rebuild leaderboard/ }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).toBe('/api/leaderboard/rebuild');
  });

  it('does not offer the rebuild or retention to a sub-admin who was not given maintenance', async () => {
    useAuthStore.setState({ admin: { isAdmin: false, isSubAdmin: true, permissions: { canViewAnalytics: true } } as any });
    await openChannels();
    await screen.findByText(/admin actions|No admin actions/i).catch(() => undefined);
    expect(screen.queryByRole('button', { name: /Rebuild leaderboard/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Preview retention/ })).toBeNull();
  });

  // ── Retention (2026-10-01) ──────────────────────────────────────────────
  // `POST /api/admin/operations/retention/run` had no screen: the nightly job
  // was the only way it ever ran, and nobody could see what it would take.
  const PREVIEW = {
    success: true, dryRun: true, cutoff: '2026-04-01T00:00:00.000Z', totalDeleted: 7,
    results: { frontendErrors: 4, referralClicks: 2, notifications: 1 },
  };
  const DONE = { ...PREVIEW, dryRun: false };

  it('previews first, and offers Prune only after a preview', async () => {
    post.mockResolvedValueOnce({ data: PREVIEW });
    await openChannels();
    expect(screen.queryByRole('button', { name: 'Prune now' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /Preview retention/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/admin/operations/retention/run', { dryRun: true }));
    const result = await screen.findByRole('status', { name: 'Retention result' });
    expect(result).toHaveTextContent('Would delete 7 row(s)');
    expect(result).toHaveTextContent('Crash reports');
    expect(result).toHaveTextContent('Expired referral clicks');
    expect(screen.getByRole('button', { name: 'Prune now' })).toBeEnabled();
  });

  it('prunes only once confirmed, with the count and cutoff the preview reported', async () => {
    post.mockResolvedValueOnce({ data: PREVIEW }).mockResolvedValueOnce({ data: DONE });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await openChannels();
    fireEvent.click(await screen.findByRole('button', { name: /Preview retention/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Prune now' }));
    expect(confirm.mock.calls[0][0]).toMatch(/Delete 7 row\(s\) older than/);
    expect(post).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Prune now' }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/api/admin/operations/retention/run', { dryRun: false }));
    expect(await screen.findByRole('status', { name: 'Retention result' })).toHaveTextContent('Deleted 7 row(s)');
    const toast = (await import('react-hot-toast')).default;
    expect(toast.success).toHaveBeenCalledWith('Retention pruned 7 row(s)');
    // The result is no longer a preview, so the prune is not offered again on it.
    expect(screen.queryByRole('button', { name: 'Prune now' })).toBeNull();
  });

  it('does not offer a prune when the preview found nothing', async () => {
    post.mockResolvedValueOnce({ data: { ...PREVIEW, totalDeleted: 0, results: { frontendErrors: 0, referralClicks: 0, notifications: 0 } } });
    await openChannels();
    fireEvent.click(await screen.findByRole('button', { name: /Preview retention/ }));
    expect(await screen.findByRole('button', { name: 'Prune now' })).toBeDisabled();
  });

  it("shows the server's refusal rather than a result", async () => {
    post.mockRejectedValueOnce({ response: { data: { message: 'Retention stopped before it finished. Run a preview to see what is left.' } } });
    await openChannels();
    fireEvent.click(await screen.findByRole('button', { name: /Preview retention/ }));
    const toast = (await import('react-hot-toast')).default;
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Retention stopped before it finished. Run a preview to see what is left.'));
    expect(screen.queryByRole('status', { name: 'Retention result' })).toBeNull();
  });

  it('survives channels being unavailable without losing the rest', async () => {
    // Each extra read carries its OWN .catch. Without one, the rejection takes
    // down the whole Promise.all, the outer catch swallows it, and every other
    // section is lost too.
    //
    // Asserting only "No channels reported." could not tell those apart — the
    // empty state renders either way, so that version of this test passed with
    // the .catch removed. What distinguishes them is whether the OTHER data
    // still arrived, so that is what is asserted.
    get.mockImplementation((url: string) => {
      if (url.includes('communication/channels')) return Promise.reject(new Error('down'));
      if (url.includes('operations/overview')) return Promise.resolve({ data: { success: false } });
      if (url.includes('admin-activity')) {
        return Promise.resolve({ data: { success: true, activity: [{ performedBy: 'a2', performedByName: 'Bela', actions: 4 }] } });
      }
      return Promise.resolve({ data: { success: true, catalog: [], feed: [] } });
    });
    await openChannels();
    expect(await screen.findByText('No channels reported.')).toBeInTheDocument();
    // The section that did NOT fail must still have its data.
    expect(screen.getByText('Bela')).toBeInTheDocument();
  });
});
