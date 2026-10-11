// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * System Settings — the order sizes and the USDT buy bounds (Step 2d).
 *
 * The seven sizes are fixed (`denominations.js`, served as `orderSizeRails`
 * with each rail's payment method); the admin chooses which are on offer to
 * buy and which to sell, in two lists (Phase A). They replaced the min/max deposit and
 * withdrawal limits, which are gone from this screen and from the save. A USDT
 * buy is a step of 100 USDT between a minimum and a maximum the admin sets.
 * The screen refuses what the server refuses (an empty list; off-step or inverted
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

/** The universe as GET /api/admin/system/config serves it (ORDER_SIZE_RAILS). */
const RAILS = [
  { rail: 'CASH', label: 'Cash (member at an ATM)', sizes: [500, 1000, 5000, 10000],
    methods: { DEPOSIT: 'Cash at an ATM: pay the ATM QR the member scans, in any UPI app', WITHDRAWAL: 'Bank transfer to your bank account' } },
  { rail: 'UPI_BANK', label: 'UPI / bank', sizes: [50000, 100000, 500000],
    methods: { DEPOSIT: "Bank transfer (IMPS, NEFT or RTGS) to the member's bank account", WITHDRAWAL: 'Bank transfer to your bank account' } },
];

/** What the GET serves: different sizes off for buying and selling, the USDT bounds moved. */
const served = {
  orderSizeRails: RAILS,
  buyOrderSizes: [500, 1000, 5000, 50000, 100000],
  sellOrderSizes: [1000, 10000, 500000],
  usdtBuy: { minUsdt: 200, maxUsdt: 5000 },
};

const paint = async (data: Partial<typeof served> = served) => {
  getConfig.mockResolvedValue({ success: true, data });
  render(<SystemSettings />);
  await screen.findByLabelText('Buy 10,000');
  // Served, not the placeholder: the minimum differs from its default.
  await waitFor(() => expect(field(/USDT Buy Minimum/i).value).toBe(String(data.usdtBuy?.minUsdt)));
};

const box = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const saveButton = () => screen.getAllByRole('button', { name: /save/i }).pop() as HTMLButtonElement;

describe('the order sizes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the seven sizes twice, buy and sell, each ticked as served', async () => {
    await paint();
    expect(screen.getByText('Sizes players can buy')).toBeInTheDocument();
    expect(screen.getByText('Sizes players can sell')).toBeInTheDocument();
    for (const on of ['500', '1,000', '5,000', '50,000', '1,00,000']) expect(box(`Buy ${on}`).checked).toBe(true);
    for (const off of ['10,000', '5,00,000']) expect(box(`Buy ${off}`).checked).toBe(false);
    for (const on of ['1,000', '10,000', '5,00,000']) expect(box(`Sell ${on}`).checked).toBe(true);
    for (const off of ['500', '5,000', '50,000', '1,00,000']) expect(box(`Sell ${off}`).checked).toBe(false);
  });

  it('shows how each rail is paid, in the server\'s words, under each list', async () => {
    await paint();
    expect(screen.getByText(RAILS[0].methods.DEPOSIT)).toBeInTheDocument();
    expect(screen.getByText(RAILS[1].methods.DEPOSIT)).toBeInTheDocument();
    // A sell on either rail is paid the same way: once per rail in the sell list.
    expect(screen.getAllByText('Bank transfer to your bank account')).toHaveLength(2);
  });

  it('offers none of the min/max limits the sizes replaced', async () => {
    await paint();
    for (const gone of [/Min Deposit/i, /Max Deposit Amount/i, /Min Withdrawal/i, /Max Withdrawal/i, /Max Winnings Withdrawal/i]) {
      expect(screen.queryByLabelText(gone)).toBeNull();
    }
  });

  it('saves each list in the fixed order, changing only the one pressed, and no removed key', async () => {
    await paint();
    updateConfig.mockResolvedValue({ data: { success: true } });
    fireEvent.click(box('Buy 10,000'));
    fireEvent.click(box('Buy 500'));
    fireEvent.click(box('Sell 500'));
    fireEvent.click(saveButton());
    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    const body = updateConfig.mock.calls[0][0];
    expect(body.buyOrderSizes).toEqual([1000, 5000, 10000, 50000, 100000]);
    expect(body.sellOrderSizes).toEqual([500, 1000, 10000, 500000]);
    for (const gone of ['orderSizes', 'orderSizeRails', 'minDeposit', 'maxDeposit', 'minWithdrawal', 'maxWithdrawal', 'maxWinningsWithdrawal']) {
      expect(body).not.toHaveProperty(gone);
    }
    expect(body.merchantOrderLimits).not.toHaveProperty('minUserTokenPurchaseUsdt');
  });

  it('refuses to save with no size to sell, and says why; the buy list is untouched', async () => {
    await paint({ ...served, sellOrderSizes: [500] });
    fireEvent.click(box('Sell 500'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/at least one size players can sell/i));
    expect(saveButton().disabled).toBe(true);
    // Ticking one back lets it save again (the opposite case).
    fireEvent.click(box('Sell 5,00,000'));
    await waitFor(() => expect(saveButton().disabled).toBe(false));
  });

  it('refuses to save with no size to buy, and says why', async () => {
    await paint({ ...served, buyOrderSizes: [1000] });
    fireEvent.click(box('Buy 1,000'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/at least one size players can buy/i));
    expect(saveButton().disabled).toBe(true);
  });
});

describe('the order sizes, not served', () => {
  beforeEach(() => vi.clearAllMocks());

  it('draws no size it was not sent, and saves the other settings without the lists', async () => {
    // The card keeps no copy of the seven (§5). A GET without them draws
    // none, and the save leaves both lists alone rather than sending an empty
    // one the server would refuse.
    getConfig.mockResolvedValue({ success: true, data: { usdtBuy: { minUsdt: 200, maxUsdt: 5000 } } });
    render(<SystemSettings />);
    await waitFor(() => expect(field(/USDT Buy Minimum/i).value).toBe('200'));
    expect(screen.queryByLabelText('Buy 500')).toBeNull();
    updateConfig.mockResolvedValue({ data: { success: true } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    const body = updateConfig.mock.calls[0][0];
    expect(body).not.toHaveProperty('buyOrderSizes');
    expect(body).not.toHaveProperty('sellOrderSizes');
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
