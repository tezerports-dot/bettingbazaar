// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The sizes a player may buy or sell — the SERVER's list, as tiles, each on
 * the rail its size names (PROJECT_STATUS §3.10, Step 2d).
 *
 * The server sends `orderSizes` grouped by rail (backend/domains/configuration/
 * systemConfigPayload.js, from the module the risk gate judges by), so this
 * screen draws exactly those, never a list of its own (§3).
 *
 * What is asserted, and why each:
 *   - a bank-size tile is a UPI/bank purchase and a cash-size tile a cash one,
 *     and the order is created with the size the player picked;
 *   - the tiles are the SERVER's — a size the admin switched off is not drawn;
 *   - nothing is sent until a size is picked, and with no config the screen
 *     says nothing is on offer rather than guessing;
 *   - a sell uses the same sizes, and a size above the winnings is not offered;
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
const CONFIG = {
  orderSizes: { CASH: [500, 1000, 5000, 10000], UPI_BANK: [50000, 100000, 500000] },
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

  it('offers a cash size as a cash purchase, and creates it', async () => {
    await open();
    fireEvent.click(await tile('10,000 tokens'));
    expect(railNote()).toMatch(/Cash purchase/);
    fireEvent.click(continueButton());
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/payment/deposit/create', { tokenAmount: 10000 }));
  });

  it('draws only the SERVER\'s sizes — a size the admin switched off is not offered', async () => {
    await open({ config: { ...CONFIG, orderSizes: { CASH: [1000], UPI_BANK: [100000] } } });
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

describe('a sell is one of the same sizes', () => {
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
