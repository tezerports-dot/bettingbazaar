// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * System Settings — the signed gateway document's line under API Host.
 *
 * The document is signed offline and only replaced on the server, so the
 * screen offers no control for it; what it owes the admin is whether apps are
 * getting it and when it lapses, so an expiry is seen before it happens. The
 * line renders the server's `gatewayDocumentStatus` and never sends it back.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { getConfig, updateConfig, toggleMaintenance } = vi.hoisted(() => ({
  getConfig: vi.fn(), updateConfig: vi.fn(), toggleMaintenance: vi.fn(),
}));
vi.mock('../../services/api', () => ({
  default: { system: { getConfig, updateConfig, toggleMaintenance }, get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('react-router', () => ({ Link: ({ children }: any) => <>{children}</> }));
vi.mock('../../components/ConfirmDialog', () => ({ ConfirmDialog: () => null }));

const { SystemSettings } = await import('./SystemSettings');

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000 + 3_600_000).toISOString();

const paint = async (gatewayDocument: unknown) => {
  getConfig.mockResolvedValue({ success: true, data: { gatewayDocument } });
  render(<SystemSettings />);
  return screen.findByText(/Signed gateway document/);
};

describe('the signed gateway document line', () => {
  beforeEach(() => vi.clearAllMocks());

  it('says when none is configured', async () => {
    const line = await paint({ state: 'NOT_CONFIGURED' });
    expect(line.textContent).toMatch(/none configured/);
    expect(line.getAttribute('role')).toBe('status');
  });

  it('shows the version, host count and days left of a served document', async () => {
    const line = await paint({ state: 'SERVING', version: 4, issuedAt: inDays(-10), expiresAt: inDays(90), hostCount: 3 });
    expect(line.textContent).toMatch(/serving version 4 with 3 hosts/);
    expect(line.textContent).toMatch(/\(90 days left\)/);
    expect(line.textContent).not.toMatch(/Sign a replacement/);
  });

  it('warns while there is still time to replace it', async () => {
    const line = await paint({ state: 'SERVING', version: 4, issuedAt: inDays(-300), expiresAt: inDays(12), hostCount: 1 });
    expect(line.textContent).toMatch(/1 host,/);
    expect(line.textContent).toMatch(/Sign a replacement before it lapses/);
  });

  it('announces a document the server refuses to serve, with its reason', async () => {
    const line = await paint({ state: 'NOT_SERVING', code: 'GATEWAY_EXPIRED', message: 'document expired at 2026-09-01T00:00:00.000Z' });
    expect(line.getAttribute('role')).toBe('alert');
    expect(line.textContent).toMatch(/GATEWAY_EXPIRED/);
  });

  it('never sends the status back with a save', async () => {
    await paint({ state: 'SERVING', version: 4, issuedAt: inDays(-10), expiresAt: inDays(90), hostCount: 3 });
    updateConfig.mockResolvedValue({ data: { success: true } });
    fireEvent.click(screen.getAllByRole('button', { name: /save/i }).pop() as HTMLButtonElement);
    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    expect(updateConfig.mock.calls[0][0]).not.toHaveProperty('gatewayDocument');
  });
});
