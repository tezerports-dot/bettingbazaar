// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * Buying tokens with USDT, from the player's side.
 *
 * ── The three states that must not look alike ──────────────────────────────
 * "Waiting for you to pay", "we can see your payment, waiting for
 * confirmations", and "credited" are three different facts about somebody's
 * money. A screen that showed the same "waiting" for the first two would leave
 * a player who has ALREADY SENT USDT believing nothing arrived — and a crypto
 * transfer cannot be taken back. That is the empty-state-as-success failure
 * this codebase has shipped repeatedly, in the place it hurts most.
 *
 * ── And a "pay now" button that goes nowhere ───────────────────────────────
 * Until BTCPay answers there is no checkout link. Rendering the button anyway
 * gives a player an affordance that does nothing, which reads as broken rather
 * than as waiting.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../services/apiClient', () => ({ default: { get, post } }));

import { UsdtBuyPanel } from './UsdtBuyPanel';

const AVAILABLE = { success: true, available: true, minTokenAmount: 10000.01 };

const INVOICE = {
  depositId: 'USDT_abc123def456',
  status: 'AWAITING_PAYMENT',
  tokenAmount: 25000,
  usdtAmount: 277.777778,
  usdtRateInr: 90,
  checkoutLink: 'https://pay.example/i/inv-1',
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
};

/** The two reads the panel makes on mount, in whatever order they arrive. */
const answering = (overrides: Record<string, any> = {}) => {
  get.mockImplementation((url: string) => {
    if (url.includes('/availability')) return Promise.resolve(overrides.availability ?? AVAILABLE);
    if (url.includes('/usdt/deposits')) return Promise.resolve(overrides.list ?? { success: true, deposits: [] });
    if (url.includes('/usdt/deposit/')) return Promise.resolve(overrides.one ?? { success: true, deposit: INVOICE });
    return Promise.resolve({});
  });
};

beforeEach(() => { get.mockReset(); post.mockReset(); answering(); });
afterEach(() => { vi.useRealTimers(); });

/**
 * Open an invoice, then let one poll come back in `status`.
 *
 * Fake timers, because the panel asks every eight seconds and a test that
 * waited that long really would take eight seconds. The interval is the
 * behaviour under test as much as the copy is: without it a player who paid
 * would sit on "waiting for your payment" until they reloaded.
 */
async function pollTo(status: string, props: Record<string, any> = {}) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  post.mockResolvedValue({ success: true, deposit: INVOICE });
  render(<UsdtBuyPanel tokenAmount={25000} {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: /USDT payment page/i }));
  await screen.findByText('277.777778 USDT');

  answering({ one: { success: true, deposit: { ...INVOICE, status } } });
  await vi.advanceTimersByTimeAsync(8000);
}

describe('buying with USDT', () => {
  it('offers to create an invoice, and creates one on the server', async () => {
    post.mockResolvedValue({ success: true, deposit: INVOICE });
    render(<UsdtBuyPanel tokenAmount={25000} />);

    const button = await screen.findByRole('button', { name: /USDT payment page/i });
    fireEvent.click(button);

    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/api/payment/usdt/deposit/create', { tokenAmount: 25000 },
    ));
  });

  it('shows the exact USDT amount, the tokens, and the rate it was priced at', async () => {
    post.mockResolvedValue({ success: true, deposit: INVOICE });
    render(<UsdtBuyPanel tokenAmount={25000} />);
    fireEvent.click(await screen.findByRole('button', { name: /USDT payment page/i }));

    // The amount is the SERVER's. A panel that recomputed it from the rate
    // would be a second owner of a price, and the two would disagree the day
    // rounding changed.
    expect(await screen.findByText('277.777778 USDT')).toBeInTheDocument();
    expect(screen.getByText('25,000 tokens')).toBeInTheDocument();
    expect(screen.getByText(/1 USDT = ₹90/)).toBeInTheDocument();
  });

  it('renders the checkout link the server sent, verbatim', async () => {
    post.mockResolvedValue({ success: true, deposit: INVOICE });
    render(<UsdtBuyPanel tokenAmount={25000} />);
    fireEvent.click(await screen.findByRole('button', { name: /USDT payment page/i }));

    const link = await screen.findByRole('link', { name: /Open the payment page/i });
    expect(link).toHaveAttribute('href', 'https://pay.example/i/inv-1');
  });

  it('offers NO link until the server has one', async () => {
    // A "pay now" button with nowhere to go is an affordance that does nothing.
    post.mockResolvedValue({ success: true, deposit: { ...INVOICE, checkoutLink: null } });
    render(<UsdtBuyPanel tokenAmount={25000} />);
    fireEvent.click(await screen.findByRole('button', { name: /USDT payment page/i }));

    expect(await screen.findByText(/Waiting for the payment page/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open the payment page/i })).toBeNull();
  });

  // ── The states ───────────────────────────────────────────────────────────
  it('tells a player their payment has been SEEN, not merely that it is waiting', async () => {
    answering({ list: { success: true, deposits: [{ ...INVOICE, status: 'PROCESSING' }] } });
    render(<UsdtBuyPanel tokenAmount={25000} />);
    expect(await screen.findByText(/waiting for confirmations/i)).toBeInTheDocument();
    // And NOT the pre-payment copy, which would say nothing arrived.
    expect(screen.queryByText('Waiting for your payment')).toBeNull();
  });

  it('says the tokens landed, and offers no link once they have', async () => {
    answering({ list: { success: true, deposits: [] } });
    post.mockResolvedValue({ success: true, deposit: { ...INVOICE, status: 'SETTLED' } });
    render(<UsdtBuyPanel tokenAmount={25000} />);
    fireEvent.click(await screen.findByRole('button', { name: /USDT payment page/i }));

    expect(await screen.findByText(/tokens added to your wallet/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open the payment page/i })).toBeNull();
  });

  it('says plainly that an expired invoice charged nothing', async () => {
    // Reached by POLLING, which is how a player actually gets here: they were
    // looking at an open invoice and its window passed. The settle and the
    // expiry both arrive at the SERVER by webhook, so this screen learns about
    // them by asking.
    await pollTo('EXPIRED');
    expect(await screen.findByText(/expired\. Nothing was charged/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open the payment page/i })).toBeNull();
  });

  it('tells the wallet once, and only once, when the tokens land', async () => {
    const onSettled = vi.fn();
    await pollTo('SETTLED', { onSettled });
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));

    // A second poll returning the same SETTLED must not refresh the balance
    // again — a callback firing on every tick would reload the wallet forever.
    await vi.advanceTimersByTimeAsync(8000);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('does NOT resume a deposit that has already finished', async () => {
    // Resuming means "you have an invoice in flight". A settled or expired one
    // is not in flight, and showing its outcome instead of the create button
    // would strand a player who has come back to buy again.
    answering({ list: { success: true, deposits: [{ ...INVOICE, status: 'SETTLED' }] } });
    render(<UsdtBuyPanel tokenAmount={25000} />);
    expect(await screen.findByRole('button', { name: /USDT payment page/i })).toBeInTheDocument();
  });

  // ── Resuming ─────────────────────────────────────────────────────────────
  it('resumes an invoice already open instead of asking for a second one', async () => {
    // The server allows ONE open invoice. Without this a reload would offer a
    // create that 409s, and the screen would show an error for a payment that
    // is perfectly fine.
    answering({ list: { success: true, deposits: [INVOICE] } });
    render(<UsdtBuyPanel tokenAmount={25000} />);
    expect(await screen.findByText('277.777778 USDT')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /USDT payment page/i })).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  // ── When the rail is off ─────────────────────────────────────────────────
  it('says the rail is closed when the server says so, and offers no button', async () => {
    answering({ availability: { success: true, available: false, minTokenAmount: 10000.01 } });
    render(<UsdtBuyPanel tokenAmount={25000} />);
    expect(await screen.findByText(/USDT is not available right now/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /USDT payment page/i })).toBeNull();
  });

  it('does NOT report the rail closed when it merely failed to ask', async () => {
    // A failed read is not an answer. Saying "unavailable" would send a player
    // away from a purchase they could have made.
    get.mockImplementation((url: string) => (url.includes('/availability')
      ? Promise.reject(new Error('network'))
      : Promise.resolve({ success: true, deposits: [] })));
    render(<UsdtBuyPanel tokenAmount={25000} />);
    expect(await screen.findByRole('button', { name: /USDT payment page/i })).toBeInTheDocument();
    expect(screen.queryByText(/USDT is not available right now/i)).toBeNull();
  });

  it('surfaces a refusal instead of pretending the invoice was created', async () => {
    post.mockRejectedValue({ message: 'You already have a USDT purchase waiting for payment.' });
    render(<UsdtBuyPanel tokenAmount={25000} />);
    fireEvent.click(await screen.findByRole('button', { name: /USDT payment page/i }));
    expect(await screen.findByText(/already have a USDT purchase/)).toBeInTheDocument();
  });
});
