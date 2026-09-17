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
