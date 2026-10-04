// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * System Settings — the red-flag threshold (PROJECT_STATUS §3.10, Step 2f).
 *
 * The number `SystemConfig.redFlags` declares is on the screen with the
 * served value, and an edit goes back in the PUT under the spec's own name —
 * a name the spec does not declare is skipped silently by the server, which
 * would look like a save.
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
vi.mock('../../components/TwoFactorSetup', () => ({ default: () => null }));
vi.mock('../../components/ConfirmDialog', () => ({ ConfirmDialog: () => null }));

const { SystemSettings } = await import('./SystemSettings');

const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const saveButton = () => screen.getAllByRole('button', { name: /save/i }).pop() as HTMLButtonElement;

describe('System Settings — red flags', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the served threshold and sends an edit back under the spec\'s name', async () => {
    getConfig.mockResolvedValue({ success: true, data: { redFlags: { lowActivityPercent: 30 } } });
    updateConfig.mockResolvedValue({ success: true });
    render(<SystemSettings />);
    await waitFor(() => expect(field('red-flag-low-activity').value).toBe('30'));
    fireEvent.change(field('red-flag-low-activity'), { target: { value: '40' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    expect(updateConfig.mock.calls[0][0].redFlags).toEqual({ lowActivityPercent: 40 });
  });

  it('falls back to the schema defaults when nothing is stored', async () => {
    getConfig.mockResolvedValue({ success: true, data: {} });
    render(<SystemSettings />);
    await screen.findByLabelText(/Low-activity red flag/);
    await waitFor(() => expect(field('red-flag-low-activity').value).toBe('25'));
  });
});
