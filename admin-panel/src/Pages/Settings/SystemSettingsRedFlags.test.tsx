// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * System Settings — the red-flag thresholds (PROJECT_STATUS §3.10, Step 2f).
 *
 * The three numbers `SystemConfig.redFlags` declares are on the screen with
 * the served values, and an edit goes back in the PUT under the spec's own
 * names — a name the spec does not declare is skipped silently by the server,
 * which would look like a save.
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

  it('shows the served thresholds and sends an edit back under the spec\'s names', async () => {
    getConfig.mockResolvedValue({ success: true, data: { redFlags: { lowActivityPercent: 30, farmingMinRounds: 4, farmingHedgePercent: 70 } } });
    updateConfig.mockResolvedValue({ success: true });
    render(<SystemSettings />);
    await waitFor(() => expect(field('red-flag-low-activity').value).toBe('30'));
    expect(field('red-flag-farming-rounds').value).toBe('4');
    expect(field('red-flag-farming-share').value).toBe('70');
    fireEvent.change(field('red-flag-low-activity'), { target: { value: '40' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    expect(updateConfig.mock.calls[0][0].redFlags).toEqual({ lowActivityPercent: 40, farmingMinRounds: 4, farmingHedgePercent: 70 });
  });

  it('falls back to the schema defaults when nothing is stored', async () => {
    getConfig.mockResolvedValue({ success: true, data: {} });
    render(<SystemSettings />);
    await screen.findByLabelText(/Low-activity red flag/);
    await waitFor(() => expect(field('red-flag-low-activity').value).toBe('25'));
    expect(field('red-flag-farming-rounds').value).toBe('3');
    expect(field('red-flag-farming-share').value).toBe('80');
  });
});
