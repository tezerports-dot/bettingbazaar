// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Which rail a buy is on — decided by its AMOUNT, against the server's ceiling.
 *
 * There is no platform-wide payment mode any more (redesign §3.10, 2c). The
 * server derives an order's rail from the order itself (`paymentModeFor`,
 * database/repositories/orderRails.js): an INR buy up to `maxCashBuy` is a CASH
 * order and must be one of `buyDenominations`; above it, UPI/bank. Both numbers
 * arrive in the system-config payload, so this screen asks the same question
 * of the same figures before the player commits to anything.
 *
 * What is asserted, and why each:
 *   - above the ceiling is offered as UPI, at or below as cash, and the order is
 *     created with the amount the player chose;
 *   - the ceiling is the SERVER's — the same amounts flip rail when the config
 *     says a different number, which a literal 10,000 here could not do (§3);
 *   - a cash-sized amount no machine dispenses is not sent, and the screen says
 *     which amounts are (the server refuses it as NOT_A_DENOMINATION);
 *   - with no config the screen claims no rail and leaves the decision to the
 *     server rather than guessing one;
 *   - a USDT buy in flight is drawn by the USDT panel, never by the INR step.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../services/apiClient', () => ({ default: { get, post } }));

import WalletPage from './WalletPage';

/** The payload's shape (backend/domains/configuration/systemConfigPayload.js). */
const CONFIG = {
  maxCashBuy: 10000,
  buyDenominations: [500, 1000, 5000, 10000],
  usdtBuyDenominations: [50000, 100000, 500000],
  usdtTokensPerUnit: 100,
  usdtChains: [{ chain: 'TRC20', label: 'Tron (TRC-20)' }],
};

const serve = ({ config = CONFIG as object | null, orders = [] as object[] } = {}) => (url: string) => {
  if (url === '/api/v1/system/config') {
    return config ? Promise.resolve({ success: true, config }) : Promise.reject(new Error('offline'));
  }
  if (url.startsWith('/api/payment/orders')) return Promise.resolve({ success: true, orders });
  return Promise.resolve({ success: true });
};

beforeEach(() => {
  get.mockReset(); post.mockReset();
  post.mockResolvedValue({ success: true, order: { orderId: 'ORD-NEW', status: 'PENDING_QUEUE', type: 'DEPOSIT', tokenAmount: 0, fiatAmount: 0 } });
});

const amountField = () => screen.getByRole('textbox', { name: /Or type an amount|Amount/ });
const continueButton = () => screen.getByRole('button', { name: 'Continue to payment' }) as HTMLButtonElement;
/** The live sentence under the field that names this amount's rail. */
const railNote = () => screen.getAllByRole('status').find((el) => el.textContent?.match(/purchase|ATM/))?.textContent ?? '';

/** Render, and wait for the config to land (the tiles are drawn from it). */
const open = async (opts?: Parameters<typeof serve>[0]) => {
  get.mockImplementation(serve(opts));
  render(<WalletPage />);
  await waitFor(() => expect(get).toHaveBeenCalledWith('/api/v1/system/config'));
};

describe('the buy rail follows the amount', () => {
  it('offers an amount ABOVE maxCashBuy as a UPI purchase, and creates it', async () => {
    await open();
    await screen.findByRole('radiogroup', { name: /Cash amounts, up to ₹10,000/ });

    fireEvent.change(amountField(), { target: { value: '12000' } });
    expect(railNote()).toMatch(/UPI purchase/);
    expect(railNote()).not.toMatch(/Cash purchase/);
    expect(continueButton()).toBeEnabled();

    fireEvent.click(continueButton());
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/payment/deposit/create', { tokenAmount: 12000 }));
  });

  it('offers an amount AT or below maxCashBuy as a cash purchase, and creates it', async () => {
    await open();
    // A tile, as a player would.
    fireEvent.click(await screen.findByRole('radio', { name: '₹5,000' }));
    expect(screen.getByRole('radio', { name: '₹5,000' })).toHaveAttribute('aria-checked', 'true');
    expect(railNote()).toMatch(/Cash purchase/);

    // The ceiling itself is still cash: `paymentModeFor` is `<=`.
    fireEvent.change(amountField(), { target: { value: '10000' } });
    expect(railNote()).toMatch(/Cash purchase/);
    expect(continueButton()).toBeEnabled();

    fireEvent.click(continueButton());
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/payment/deposit/create', { tokenAmount: 10000 }));
  });

  it('takes the ceiling from the SERVER — the same amount flips rail when the config does', async () => {
    // At a 5,000 ceiling, 7,000 is UPI; at the 10,000 one above it would be a
    // cash amount no machine dispenses. Only a threshold read from the config
    // can tell these apart.
    await open({ config: { ...CONFIG, maxCashBuy: 5000, buyDenominations: [500, 1000, 5000] } });
    await screen.findByRole('radiogroup', { name: /Cash amounts, up to ₹5,000/ });
    expect(screen.queryByRole('radio', { name: '₹10,000' })).toBeNull();

    fireEvent.change(amountField(), { target: { value: '7000' } });
    expect(railNote()).toMatch(/UPI purchase/);
    expect(continueButton()).toBeEnabled();
  });

  it('does not send a cash-sized amount no machine dispenses, and names the ones it does', async () => {
    await open();
    await screen.findByRole('radiogroup', { name: /Cash amounts/ });

    fireEvent.change(amountField(), { target: { value: '7000' } });
    expect(railNote()).toMatch(/₹500, ₹1,000, ₹5,000, ₹10,000/);
    expect(railNote()).toMatch(/more than ₹10,000, which is paid by UPI/);
    expect(continueButton()).toBeDisabled();
    fireEvent.click(continueButton());
    expect(post).not.toHaveBeenCalled();
  });

  it('claims no rail when the config could not be read — the server decides', async () => {
    await open({ config: null });
    // No tiles: there is no list to draw them from.
    expect(screen.queryByRole('radiogroup', { name: /Cash amounts/ })).toBeNull();
    fireEvent.change(amountField(), { target: { value: '7000' } });
    expect(railNote()).toBe('');
    expect(continueButton()).toBeEnabled();
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
