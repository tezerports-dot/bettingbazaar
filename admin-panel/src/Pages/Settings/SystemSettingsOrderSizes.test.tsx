// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * System Settings — the order sizes and the USDT buy bounds (Step 2d).
 *
 * The seven sizes are fixed (`denominations.js`); the admin chooses which are
 * on offer, for buys and sells alike. They replaced the min/max deposit and
 * withdrawal limits, which are gone from this screen and from the save. A USDT
 * buy is a step of 100 USDT between a minimum and a maximum the admin sets.
 * The screen refuses what the server refuses (no sizes; off-step or inverted
 * USDT bounds) before the round trip, and says why.
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

/** What the GET serves: two sizes switched off, the USDT bounds moved. */
const served = {
  orderSizes: [500, 1000, 5000, 50000, 100000],
  usdtBuy: { minUsdt: 200, maxUsdt: 5000 },
};

const paint = async (data: typeof served = served) => {
  getConfig.mockResolvedValue({ success: true, data });
  render(<SystemSettings />);
  await screen.findByLabelText('10,000');
  // Served, not the placeholder: the minimum differs from its default.
  await waitFor(() => expect(field(/USDT Buy Minimum/i).value).toBe(String(data.usdtBuy.minUsdt)));
};

const box = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const saveButton = () => screen.getAllByRole('button', { name: /save/i }).pop() as HTMLButtonElement;

describe('the order sizes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the seven sizes, ticked as served', async () => {
    await paint();
    for (const on of ['500', '1,000', '5,000', '50,000', '1,00,000']) expect(box(on).checked).toBe(true);
    for (const off of ['10,000', '5,00,000']) expect(box(off).checked).toBe(false);
  });

  it('offers none of the min/max limits the sizes replaced', async () => {
    await paint();
    for (const gone of [/Min Deposit/i, /Max Deposit Amount/i, /Min Withdrawal/i, /Max Withdrawal/i, /Max Winnings Withdrawal/i]) {
      expect(screen.queryByLabelText(gone)).toBeNull();
    }
  });

  it('saves the sizes in the fixed order, and no removed key', async () => {
    await paint();
    updateConfig.mockResolvedValue({ data: { success: true } });
    fireEvent.click(box('10,000'));
    fireEvent.click(box('500'));
    fireEvent.click(saveButton());
    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    const body = updateConfig.mock.calls[0][0];
    expect(body.orderSizes).toEqual([1000, 5000, 10000, 50000, 100000]);
    for (const gone of ['minDeposit', 'maxDeposit', 'minWithdrawal', 'maxWithdrawal', 'maxWinningsWithdrawal']) {
      expect(body).not.toHaveProperty(gone);
    }
    expect(body.merchantOrderLimits).not.toHaveProperty('minUserTokenPurchaseUsdt');
  });

  it('refuses to save with no size on offer, and says why', async () => {
    await paint({ ...served, orderSizes: [500] });
    fireEvent.click(box('500'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/at least one size/i));
    expect(saveButton().disabled).toBe(true);
  });

  it('starts from every size when the server sends none', async () => {
    getConfig.mockResolvedValue({ success: true, data: {} });
    render(<SystemSettings />);
    await screen.findByLabelText('10,000');
    await waitFor(() => expect(getConfig).toHaveBeenCalled());
    for (const size of ['500', '1,000', '5,000', '10,000', '50,000', '1,00,000', '5,00,000']) {
      expect(box(size).checked).toBe(true);
    }
  });
});

describe('the USDT buy bounds', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the served bounds and saves them under usdtBuy', async () => {
    await paint();
    expect(field(/USDT Buy Minimum/i).value).toBe('200');
    expect(field(/USDT Buy Maximum/i).value).toBe('5000');
    updateConfig.mockResolvedValue({ data: { success: true } });
    fireEvent.change(field(/USDT Buy Maximum/i), { target: { value: '10000' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    expect(updateConfig.mock.calls[0][0].usdtBuy).toEqual({ minUsdt: 200, maxUsdt: 10000 });
  });

  it('refuses a bound off the 100 USDT step', async () => {
    await paint();
    fireEvent.change(field(/USDT Buy Minimum/i), { target: { value: '150' } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/multiples of 100/i));
    expect(saveButton().disabled).toBe(true);
  });

  it('refuses a minimum above the maximum', async () => {
    await paint();
    fireEvent.change(field(/USDT Buy Minimum/i), { target: { value: '6000' } });
    await waitFor(() => expect(saveButton().disabled).toBe(true));
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
