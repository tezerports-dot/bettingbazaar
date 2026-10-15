// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The sizes a player may buy or sell — the SERVER's list, as tiles, each on
 * the rail its size names (PROJECT_STATUS §3.10, Step 2d).
 *
 * The server sends `orderSizes` per direction (`buy`, `sell`; Phase A) and
 * grouped by rail, with `orderSizeMethods` saying how each rail is paid
 * (backend/domains/configuration/systemConfigPayload.js, from the module the
 * risk gate judges by), so this screen draws exactly those, never a list or a
 * sentence of its own (§3, §5).
 *
 * What is asserted, and why each:
 *   - a bank-size tile is a UPI/bank purchase and a cash-size tile a cash one,
 *     and the order is created with the size the player picked;
 *   - the tiles are the SERVER's — a size the admin switched off is not drawn;
 *   - nothing is sent until a size is picked, and with no config the screen
 *     says nothing is on offer rather than guessing;
 *   - the Buy tab draws the buy list and the Sell tab the sell list, each with
 *     the server's payment method under each rail;
 *   - a size above the winnings is not offered for a sell;
 *   - the USDT panel is drawn from the server's bounds;
 *   - a USDT buy in flight is drawn by the USDT panel, never by the INR step.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../services/apiClient', () => ({ default: { get, post } }));

import WalletPage from './WalletPage';

/** The payload's shape (backend/domains/configuration/systemConfigPayload.js). */
const ALL_SIZES = { CASH: [500, 1000, 5000, 10000], UPI_BANK: [50000, 100000, 500000] };
const METHODS = {
  buy: { CASH: 'Cash at an ATM: pay the ATM QR the member scans, in any UPI app', UPI_BANK: "Bank transfer (IMPS, NEFT or RTGS) to the member's bank account" },
  sell: { CASH: 'Bank transfer to your bank account', UPI_BANK: 'Bank transfer to your bank account' },
};
const CONFIG = {
  orderSizes: { buy: ALL_SIZES, sell: ALL_SIZES },
  orderSizeMethods: METHODS,
  usdtBuy: { minUsdt: 100, maxUsdt: 10000, stepUsdt: 100 },
  usdtTokensPerUnit: 90,
  usdtChains: [{ chain: 'TRC20', label: 'Tron (TRC-20)' }],
};

const serve = ({
  config = CONFIG as object | null, orders = [] as object[], winnings = 0,
} = {}) => (url: string) => {
  if (url === '/api/v1/system/config') {
    return config ? Promise.resolve({ success: true, config }) : Promise.reject(new Error('offline'));
  }
  if (url.startsWith('/api/payment/orders')) return Promise.resolve({ success: true, orders });
  if (url === '/api/user/bet-limits') {
    return Promise.resolve({ success: true, deposit: 0, winnings, locked: 0, reserve: 0, maxStake: 0 });
  }
  return Promise.resolve({ success: true });
};

beforeEach(() => {
  get.mockReset(); post.mockReset();
  post.mockResolvedValue({ success: true, order: { orderId: 'ORD-NEW', status: 'PENDING_QUEUE', type: 'DEPOSIT', tokenAmount: 0, fiatAmount: 0 } });
});

const continueButton = () => screen.getByRole('button', { name: 'Continue to payment' }) as HTMLButtonElement;
const tile = (name: string) => screen.findByRole('radio', { name });
/** The live sentence under the tiles that names the chosen size's rail. */
const railNote = () => screen.getAllByRole('status').find((el) => el.textContent?.match(/purchase|bank transfer/))?.textContent ?? '';

/** Render, and wait for the config to land (the tiles are drawn from it). */
const open = async (opts?: Parameters<typeof serve>[0]) => {
  get.mockImplementation(serve(opts));
  render(<WalletPage />);
  await waitFor(() => expect(get).toHaveBeenCalledWith('/api/v1/system/config'));
};

describe('a buy is one of the sizes on offer', () => {
  it('groups the tiles by rail, as the server grouped them', async () => {
    await open();
    const cash = await screen.findByRole('radiogroup', { name: 'Cash team' });
    const bank = screen.getByRole('radiogroup', { name: 'UPI / bank team' });
    const names = (g: HTMLElement) => within(g).getAllByRole('radio').map((r) => r.getAttribute('aria-label'));
    expect(names(cash)).toEqual(['500 tokens', '1,000 tokens', '5,000 tokens', '10,000 tokens']);
    expect(names(bank)).toEqual(['50,000 tokens', '1,00,000 tokens', '5,00,000 tokens']);
  });

  it('offers a bank size as a UPI/bank purchase, and creates it', async () => {
    await open();
    fireEvent.click(await tile('50,000 tokens'));
    expect(screen.getByRole('radio', { name: '50,000 tokens' })).toHaveAttribute('aria-checked', 'true');
    expect(railNote()).toMatch(/UPI \/ bank purchase/);
    expect(continueButton()).toBeEnabled();

    fireEvent.click(continueButton());
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/payment/deposit/create', { tokenAmount: 50000 }));
  });

  it('draws the sizes the admin sends to merchant accounts as their own group, as a merchant purchase', async () => {
    await open({ config: { ...CONFIG, orderSizes: {
      buy: { CASH: [500, 1000], UPI_BANK: [], MERCHANT: [50000, 100000] }, sell: ALL_SIZES,
    }, orderSizeMethods: { ...METHODS, buy: { ...METHODS.buy, MERCHANT: 'UPI or bank transfer' } } } });
    const merchant = await screen.findByRole('radiogroup', { name: 'Merchant' });
    expect(within(merchant).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['50,000 tokens', '1,00,000 tokens']);
    expect(screen.queryByRole('radiogroup', { name: 'UPI / bank team' })).toBeNull();
    fireEvent.click(await tile('50,000 tokens'));
    expect(railNote()).toMatch(/Merchant purchase/);
    fireEvent.click(continueButton());
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/payment/deposit/create', { tokenAmount: 50000 }));
  });

  it('offers a cash size as a cash purchase, and creates it', async () => {
    await open();
    fireEvent.click(await tile('10,000 tokens'));
    expect(railNote()).toMatch(/Cash purchase/);
    fireEvent.click(continueButton());
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/payment/deposit/create', { tokenAmount: 10000 }));
  });

  it('draws only the SERVER\'s sizes — a size the admin switched off is not offered', async () => {
    await open({ config: { ...CONFIG, orderSizes: { buy: { CASH: [1000], UPI_BANK: [100000] }, sell: ALL_SIZES } } });
    expect(await tile('1,000 tokens')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '1,00,000 tokens' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: '500 tokens' })).toBeNull();
    expect(screen.queryByRole('radio', { name: '50,000 tokens' })).toBeNull();
  });

  it('sends nothing until a size is picked', async () => {
    await open();
    await tile('500 tokens');
    expect(continueButton()).toBeDisabled();
    fireEvent.click(continueButton());
    expect(post).not.toHaveBeenCalled();
  });

  it('says nothing is on offer when the config could not be read, and sends nothing', async () => {
    await open({ config: null });
    expect(await screen.findByText('No order sizes are on offer right now.')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Cash team' })).toBeNull();
    expect(continueButton()).toBeDisabled();
  });

  it('draws the USDT panel from the server\'s bounds', async () => {
    await open();
    expect(await screen.findByLabelText('USDT to send')).toBeInTheDocument();
    expect(screen.getAllByText(/100 to 10,000 USDT, in steps of 100/).length).toBeGreaterThan(0);
  });
});

describe('each tab draws its own list (Phase A)', () => {
  const SPLIT = {
    ...CONFIG,
    orderSizes: {
      buy: { CASH: [1000, 5000], UPI_BANK: [50000] },
      sell: { CASH: [500], UPI_BANK: [100000] },
    },
  };

  it('the Buy tab offers the buy list, with how each rail is paid under it', async () => {
    await open({ config: SPLIT });
    expect(await tile('1,000 tokens')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '50,000 tokens' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: '500 tokens' })).toBeNull();
    expect(screen.queryByRole('radio', { name: '1,00,000 tokens' })).toBeNull();
    expect(screen.getByText(METHODS.buy.CASH)).toBeInTheDocument();
    expect(screen.getByText(METHODS.buy.UPI_BANK)).toBeInTheDocument();
    // The method describes its rail's tiles to a screen reader too.
    expect(screen.getByRole('radiogroup', { name: 'Cash team' })).toHaveAccessibleDescription(METHODS.buy.CASH);
  });

  it('the Sell tab offers the sell list, with how each rail is paid under it', async () => {
    await open({ config: SPLIT, winnings: 200000 });
    fireEvent.click(screen.getByRole('button', { name: /SELL TOKENS/ }));
    expect(await tile('500 tokens')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '1,00,000 tokens' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: '1,000 tokens' })).toBeNull();
    expect(screen.queryByRole('radio', { name: '50,000 tokens' })).toBeNull();
    expect(screen.getAllByText(METHODS.sell.CASH)).toHaveLength(2);
    expect(screen.queryByText(METHODS.buy.CASH)).toBeNull();

    await waitFor(() => expect(screen.getByRole('radio', { name: '500 tokens' })).toBeEnabled());
    fireEvent.click(screen.getByRole('radio', { name: '500 tokens' }));
    post.mockResolvedValueOnce({ success: true, order: { orderId: 'WD-2', status: 'PENDING_QUEUE', type: 'WITHDRAWAL', tokenAmount: 500, fiatAmount: 500 } });
    fireEvent.click(screen.getByRole('button', { name: 'Sell tokens' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/payment/withdrawal/create', { tokenAmount: 500 }));
  });
});

describe('a sell is one of the sizes on offer to sell', () => {
  it('offers the sizes the winnings cover, and creates the one picked', async () => {
    await open({ winnings: 20000 });
    fireEvent.click(screen.getByRole('button', { name: /SELL TOKENS/ }));
    // Above the winnings: drawn, so the player sees the size exists, but not offered.
    expect(await tile('50,000 tokens')).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('radio', { name: '10,000 tokens' })).toBeEnabled());
    fireEvent.click(screen.getByRole('radio', { name: '10,000 tokens' }));
    expect(railNote()).toMatch(/bank transfer/);

    post.mockResolvedValueOnce({ success: true, order: { orderId: 'WD-1', status: 'PENDING_QUEUE', type: 'WITHDRAWAL', tokenAmount: 10000, fiatAmount: 10000 } });
    fireEvent.click(screen.getByRole('button', { name: 'Sell tokens' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/payment/withdrawal/create', { tokenAmount: 10000 }));
  });
});

describe('an order already in flight', () => {
  it('draws a USDT buy in the USDT panel, never in the INR payment step', async () => {
    // Taken by the INR step, a 50,000-token USDT buy read "Pay ₹500" (trap 15)
    // and showed no address at all.
    await open({
      orders: [{
        orderId: 'ORD-USDT-1', _id: 'ORD-USDT-1', type: 'DEPOSIT', status: 'ASSIGNED', currency: 'USDT',
        paymentMode: 'P2P_UPI', tokenAmount: 50000, fiatAmount: 500, usdtChain: 'TRC20',
        createdAt: new Date().toISOString(),
        payTo: { usdtAddress: 'TXYZ', usdtChain: 'TRC20', usdtChainLabel: 'Tron (TRC-20)', merchantRef: 'Merchant #9' },
      }],
    });
    expect(await screen.findByText('Send USDT')).toBeInTheDocument();
    expect(screen.queryByText('Complete payment')).toBeNull();
  });

  it('renders an INR order by its OWN paymentMode — a cash order asks for the tap', async () => {
    await open({
      orders: [{
        orderId: 'ORD-CASH-9', _id: 'ORD-CASH-9', type: 'DEPOSIT', status: 'ASSIGNED', currency: 'INR',
        paymentMode: 'CASH_ATM', tokenAmount: 1000, fiatAmount: 1000,
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
        payTo: { paymentLink: 'upi://pay?pa=m%40ok&am=1000.00', merchantRef: 'Merchant #9' },
      }],
    });
    expect(await screen.findByText('Complete payment')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /I've Paid — tell the merchant/ })).toBeInTheDocument();
  });
});

describe('INR orders to merchants: one flat list (owner, 2026-10-11)', () => {
  // In MERCHANTS mode the server sends CASH empty and every size under
  // UPI_BANK, with its own method sentence (systemConfigPayload.js). An empty
  // rail draws nothing, and one rail has no heading.
  const FLAT = {
    ...CONFIG,
    orderSizes: { buy: { CASH: [], UPI_BANK: [500, 1000, 50000] }, sell: { CASH: [], UPI_BANK: [500, 1000, 50000] } },
    orderSizeMethods: { buy: { UPI_BANK: 'UPI or bank transfer' }, sell: { UPI_BANK: 'Bank transfer to your bank account' } },
  };

  it('draws every size in one unheaded group with the server\'s sentence, and buys the size picked', async () => {
    await open({ config: FLAT });
    expect(await tile('500 tokens')).toBeInTheDocument();
    const group = screen.getByRole('radiogroup', { name: 'Order size' });
    expect(within(group).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['500 tokens', '1,000 tokens', '50,000 tokens']);
    expect(screen.queryByText('Cash team')).toBeNull();
    expect(screen.queryByText('UPI / bank team')).toBeNull();
    expect(screen.getByRole('radiogroup', { name: 'Order size' })).toHaveAccessibleDescription('UPI or bank transfer');
    expect(document.body.textContent).not.toMatch(/agent|merchant account/i);
    fireEvent.click(screen.getByRole('radio', { name: '500 tokens' }));
    fireEvent.click(continueButton());
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(JSON.stringify(post.mock.calls[0])).toContain('500');
  });
});

describe('an open order is never hidden behind the size picker', () => {
  // A buy still waiting for a member is the player's one open buy. The screen
  // used to ignore it, offer the tiles again, and the server refused the second
  // order; the only way out was the Cancel under Payment Orders.
  const waitingBuy = { orderId: 'ORD-Q', _id: 'ORD-Q', type: 'DEPOSIT', status: 'PENDING_QUEUE', currency: 'INR', tokenAmount: 5000, fiatAmount: 5000, canCancel: true, createdAt: new Date().toISOString() };

  it('shows a waiting buy, and its Cancel cancels it on the server', async () => {
    await open({ orders: [waitingBuy] });
    const cancel = await screen.findByRole('button', { name: '✕ Cancel order' });
    expect(screen.queryByRole('button', { name: 'Continue to payment' })).toBeNull();
    post.mockResolvedValueOnce({ success: true });
    fireEvent.click(cancel);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/payment/order/cancel', { orderId: 'ORD-Q' }));
  });

  it('offers no Cancel on a buy the member has accepted', async () => {
    await open({ orders: [{ ...waitingBuy, status: 'PROCESSING', canCancel: false }] });
    await screen.findByText('Complete payment');
    expect(screen.queryByRole('button', { name: '✕ Cancel order' })).toBeNull();
  });

  it('says a waiting sell is still looking for a merchant, and lets it be cancelled', async () => {
    await open({ orders: [{ ...waitingBuy, orderId: 'SELL-Q', _id: 'SELL-Q', type: 'WITHDRAWAL' }] });
    expect(await screen.findByText(/Finding a merchant for your payout/)).toBeInTheDocument();
    expect(screen.queryByText(/Payment sent/)).toBeNull();
    post.mockResolvedValueOnce({ success: true });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel sell order' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/payment/order/cancel', { orderId: 'SELL-Q' }));
  });
});

describe('the wallet names what a sell holds', () => {
  it('shows a sell’s locked tokens apart from stakes in play', async () => {
    get.mockImplementation((url: string) => {
      if (url === '/api/user/bet-limits') {
        return Promise.resolve({ success: true, deposit: 0, winnings: 0, locked: 6000, reserve: 0, maxStake: 0, lockedInSells: 5000, lockedInDisputes: 0 });
      }
      return serve()(url);
    });
    render(<WalletPage />);
    expect(await screen.findByText('IN SELL ORDERS')).toBeInTheDocument();
    const inPlay = screen.getByText('IN PLAY').parentElement as HTMLElement;
    expect(inPlay).toHaveTextContent('1,000');
    expect(screen.queryByText('IN DISPUTE')).toBeNull();
  });
});
