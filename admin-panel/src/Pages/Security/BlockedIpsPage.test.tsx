// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Blocked IPs screen sends exactly what the server's route takes, and shows
 * the operator the address they are connecting from before they pick a range.
 *
 * The route itself is proven in backend/tests/routes/ipBlocklistRoutesPg — this
 * file proves the BUTTONS call it with the body it requires (§32 S26: a button
 * calling the right route with a request that route refuses).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { list, block, release } = vi.hoisted(() => ({ list: vi.fn(), block: vi.fn(), release: vi.fn() }));
vi.mock('../../services/api', () => ({ ipBlocks: { list, block, release } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { BlockedIpsPage } from './BlockedIpsPage';

const LIVE = {
  blockId: 'ipb_1', network: '203.0.113.0/24', reason: 'Credential stuffing', blockedBy: 'admin-1',
  blockedAt: '2026-09-30T10:00:00.000Z', expiresAt: null, releasedAt: null, releasedBy: null, live: true,
};

beforeEach(() => {
  list.mockReset(); block.mockReset(); release.mockReset();
  list.mockResolvedValue({ success: true, blocks: [LIVE], yourIp: '198.51.100.10', enforcer: { enforcing: true, blocks: 1, loadedAt: null, refreshSeconds: 10 } });
  block.mockResolvedValue({ success: true, block: { ...LIVE, blockId: 'ipb_2', network: '192.0.2.0/24' } });
  release.mockResolvedValue({ success: true, block: { ...LIVE, live: false, releasedAt: '2026-09-30T11:00:00.000Z' } });
});

describe('Blocked IPs', () => {
  it('lists live blocks and shows the address the admin is connecting from', async () => {
    render(<BlockedIpsPage />);
    expect(await screen.findByText('203.0.113.0/24')).toBeTruthy();
    expect(screen.getByText('198.51.100.10')).toBeTruthy();
  });

  it('Block sends the range, the reason and the expiry the route takes', async () => {
    render(<BlockedIpsPage />);
    await screen.findByText('203.0.113.0/24');
    await userEvent.type(screen.getByLabelText(/Address or range/i), '192.0.2.0/24');
    await userEvent.type(screen.getByLabelText(/Reason/i), 'Scraping');
    await userEvent.type(screen.getByLabelText(/Expires after/i), '1440');
    await userEvent.click(screen.getByRole('button', { name: /^Block$/i }));
    await waitFor(() => expect(block).toHaveBeenCalledWith({ network: '192.0.2.0/24', reason: 'Scraping', expiresInMinutes: 1440 }));
  });

  it('leaves the expiry out when the field is empty, so the block lasts until lifted', async () => {
    render(<BlockedIpsPage />);
    await screen.findByText('203.0.113.0/24');
    await userEvent.type(screen.getByLabelText(/Address or range/i), '192.0.2.9');
    await userEvent.type(screen.getByLabelText(/Reason/i), 'One client');
    await userEvent.click(screen.getByRole('button', { name: /^Block$/i }));
    await waitFor(() => expect(block).toHaveBeenCalledWith({ network: '192.0.2.9', reason: 'One client' }));
  });

  it('Lift block releases that row, after a confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<BlockedIpsPage />);
    await userEvent.click(await screen.findByRole('button', { name: /Lift the block on 203.0.113.0\/24/i }));
    await waitFor(() => expect(release).toHaveBeenCalledWith('ipb_1'));
  });
});
