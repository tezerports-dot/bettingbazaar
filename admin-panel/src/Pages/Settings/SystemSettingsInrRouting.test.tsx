// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The INR routing switch and the merchants' numbers (owner, 2026-10-11).
 *
 *   1. Each size, per direction, goes to Agents or Merchant accounts: drawn
 *      from the served `orderSizeRails`, showing `merchantBuySizes` /
 *      `merchantSellSizes`, and a change goes back in the PUT (owner, 2026-10-15).
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
  default: { system: { getConfig, updateConfig, toggleMaintenance }, users: { maintenanceTesters: async () => [] }, get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));
vi.mock('react-hot-toast', () => ({ default: { success: toastSuccess, error: vi.fn() } }));
vi.mock('../../components/ConfirmDialog', () => ({ ConfirmDialog: () => null }));

const { SystemSettings } = await import('./SystemSettings');

const served = {
  orderSizeRails: [
    { rail: 'CASH', label: 'Cash', sizes: [500, 1000], methods: { DEPOSIT: 'ATM', WITHDRAWAL: 'Bank' } },
    { rail: 'UPI_BANK', label: 'UPI / bank', sizes: [50000], methods: { DEPOSIT: 'Bank', WITHDRAWAL: 'Bank' } },
  ],
  buyOrderSizes: [500, 1000, 50000],
  sellOrderSizes: [500, 1000, 50000],
  merchantBuySizes: [50000],
  merchantSellSizes: [],
  merchantRouting: {
    concurrency: { DEPOSIT: 12, WITHDRAWAL: 8 },
    assignmentWaitSeconds: 1300,
    processingWindowSeconds: { DEPOSIT: 600, WITHDRAWAL: 1200 },
  },
  directMerchants: { dailyProblemFlagThreshold: 6 },
  orderCommission: { depositPercent: 4.5, withdrawalPercent: 5 },
};

const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const saveButton = () => screen.getAllByRole('button', { name: /save/i }).pop() as HTMLButtonElement;

const paint = async () => {
  getConfig.mockResolvedValue({ success: true, data: served, help: {
    merchantBuySizes: { what: 'The buy sizes that go to merchant accounts, paid by UPI QR.', example: '[50000]' },
  } });
  render(<SystemSettings />);
  await screen.findByText('INR Orders');
  await waitFor(() => expect((screen.getByRole('combobox', { name: 'Buy 50,000 goes to' }) as HTMLSelectElement).value).toBe('MERCHANTS'));
};

beforeEach(() => vi.clearAllMocks());

describe('each INR size goes to: Agents / Merchant accounts', () => {
  it('saves each size\'s choice and says how many waiting orders moved', async () => {
    updateConfig.mockResolvedValue({ success: true, rerailedOrders: 3 });
    await paint();
    // The setting's help is the server's (configHelp.js), rendered under it.
    expect(screen.getByText(/go to merchant accounts, paid by UPI QR/)).toBeInTheDocument();
    expect((screen.getByRole('combobox', { name: 'Buy 500 goes to' }) as HTMLSelectElement).value).toBe('AGENTS');
    fireEvent.change(screen.getByRole('combobox', { name: 'Buy 1,000 goes to' }), { target: { value: 'MERCHANTS' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Sell 500 goes to' }), { target: { value: 'MERCHANTS' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    expect(updateConfig.mock.calls[0][0]).toMatchObject({ merchantBuySizes: [1000, 50000], merchantSellSizes: [500] });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/3 waiting INR orders were moved/)));
  });

  it('a save that moved nothing says only that it saved', async () => {
    updateConfig.mockResolvedValue({ success: true, rerailedOrders: 0 });
    await paint();
    fireEvent.click(saveButton());
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('System settings updated'));
    expect(updateConfig.mock.calls[0][0]).toMatchObject({ merchantBuySizes: [50000], merchantSellSizes: [] });
  });

  it('shows and sends the merchants\' numbers whole', async () => {
    updateConfig.mockResolvedValue({ success: true, rerailedOrders: 0 });
    await paint();
    expect(field('mr-conc-DEPOSIT').value).toBe('12');
    expect(field('mr-proc-WITHDRAWAL').value).toBe('1200');
    expect(field('mr-assignmentWaitSeconds').value).toBe('1300');
    expect(field('oc-depositPercent').value).toBe('4.5');
    fireEvent.change(field('dm-dailyProblemFlagThreshold'), { target: { value: '9' } });
    fireEvent.change(field('oc-withdrawalPercent'), { target: { value: '6.25' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    expect(updateConfig.mock.calls[0][0]).toMatchObject({
      merchantRouting: served.merchantRouting,
      directMerchants: { dailyProblemFlagThreshold: 9 },
      orderCommission: { depositPercent: 4.5, withdrawalPercent: 6.25 },
    });
  });

  it('an out-of-range commission is announced and the save is off', async () => {
    await paint();
    fireEvent.change(field('oc-depositPercent'), { target: { value: '80' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Must be 0–20.');
    expect(saveButton()).toBeDisabled();
  });
});
