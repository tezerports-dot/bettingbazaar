// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The INR routing switch and the merchants' numbers (owner, 2026-10-11).
 *
 *   1. The switch draws the served `inrRoutingModes`, shows the served mode,
 *      and a change goes back as `inrRoutingMode` in the PUT.
 *   2. The server says how many waiting INR orders moved (`rerailedOrders`),
 *      and the toast repeats it.
 *   3. `merchantRouting` and `directMerchants` are shown with the served
 *      values and go back whole; an out-of-range value is announced and the
 *      save is off.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { getConfig, updateConfig, toggleMaintenance, toastSuccess } = vi.hoisted(() => ({
  getConfig: vi.fn(), updateConfig: vi.fn(), toggleMaintenance: vi.fn(), toastSuccess: vi.fn(),
}));
vi.mock('../../services/api', () => ({
  default: { system: { getConfig, updateConfig, toggleMaintenance }, get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));
vi.mock('react-hot-toast', () => ({ default: { success: toastSuccess, error: vi.fn() } }));
vi.mock('../../components/ConfirmDialog', () => ({ ConfirmDialog: () => null }));

const { SystemSettings } = await import('./SystemSettings');

const served = {
  inrRoutingModes: ['AGENTS', 'MERCHANTS'],
  inrRoutingMode: 'AGENTS',
  merchantRouting: {
    concurrency: { DEPOSIT: 12, WITHDRAWAL: 8 },
    assignmentWaitSeconds: 1300,
    processingWindowSeconds: { DEPOSIT: 600, WITHDRAWAL: 1200 },
  },
  directMerchants: { commissionPercent: 12, dailyProblemFlagThreshold: 6 },
};

const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const saveButton = () => screen.getAllByRole('button', { name: /save/i }).pop() as HTMLButtonElement;

const paint = async () => {
  getConfig.mockResolvedValue({ success: true, data: served });
  render(<SystemSettings />);
  await screen.findByText('INR Orders');
  await waitFor(() => expect(screen.getByRole('radio', { name: 'Agents' })).toBeChecked());
};

beforeEach(() => vi.clearAllMocks());

describe('INR orders go to: Agents / Merchants', () => {
  it('saves the switch and says how many waiting orders moved', async () => {
    updateConfig.mockResolvedValue({ success: true, rerailedOrders: 3 });
    await paint();
    expect(screen.getByText(/USDT orders always go to agent teams/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Merchants' }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    expect(updateConfig.mock.calls[0][0]).toMatchObject({ inrRoutingMode: 'MERCHANTS' });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/3 waiting INR orders were moved/)));
  });

  it('a save that moved nothing says only that it saved', async () => {
    updateConfig.mockResolvedValue({ success: true, rerailedOrders: 0 });
    await paint();
    fireEvent.click(saveButton());
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('System settings updated'));
    expect(updateConfig.mock.calls[0][0]).toMatchObject({ inrRoutingMode: 'AGENTS' });
  });

  it('shows and sends the merchants\' numbers whole', async () => {
    updateConfig.mockResolvedValue({ success: true, rerailedOrders: 0 });
    await paint();
    expect(field('mr-conc-DEPOSIT').value).toBe('12');
    expect(field('mr-proc-WITHDRAWAL').value).toBe('1200');
    expect(field('mr-assignmentWaitSeconds').value).toBe('1300');
    expect(field('dm-commissionPercent').value).toBe('12');
    fireEvent.change(field('dm-dailyProblemFlagThreshold'), { target: { value: '9' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    expect(updateConfig.mock.calls[0][0]).toMatchObject({
      merchantRouting: served.merchantRouting,
      directMerchants: { commissionPercent: 12, dailyProblemFlagThreshold: 9 },
    });
  });

  it('an out-of-range commission is announced and the save is off', async () => {
    await paint();
    fireEvent.change(field('dm-commissionPercent'), { target: { value: '80' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Must be 1–50.');
    expect(saveButton()).toBeDisabled();
  });
});
