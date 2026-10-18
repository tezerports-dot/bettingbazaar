// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * Buying with USDT, from the player's side (owner, 2026-10-18: paid to an
 * address the platform derives for the order on BNB Smart Chain, credited by
 * itself once the full amount arrives).
 *
 * ── The one mistake this screen exists to prevent ──────────────────────────
 * USDT is one token on several blockchains and they are NOT interchangeable,
 * so the network is shown beside the address every time.
 *
 * ── And the states that must not look alike ────────────────────────────────
 * "Here is where to send" and "there is nowhere to send" are different facts.
 * An empty address rendered as a destination is how somebody sends USDT into
 * nothing. And there is nothing to submit: no transaction ID, no "I've paid".
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

const { post, get } = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock('../services/apiClient', () => ({ default: { post, get } }));

import { UsdtBuyPanel } from './UsdtBuyPanel';

// Whole USDT, as the server sends them (SystemConfig.usdtBuy, Step 2d). What
// the player RECEIVES is derived from the rate.
const BOUNDS = { minUsdt: 100, maxUsdt: 10000, stepUsdt: 100 };
const TOKENS_PER_USDT = 100;
const CHAINS = [{ chain: 'BEP20', label: 'BNB Smart Chain (BEP-20)' }];

const ADDRESS = '0x9858effd232b4033e47d90003d41ec34ecaeda94';
const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

const open = (over: any = {}) => ({
  orderId: 'ORD-USDT-1',
  status: 'PROCESSING',
  tokenAmount: 50000,
  // The order's OWN quote, fixed at creation. Never recomputed on the screen.
  fiatAmount: 500,
  usdtChain: 'BEP20',
  usdtReceived: 0,
  payTo: { usdtAddress: ADDRESS, usdtChain: 'BEP20', usdtChainLabel: 'BNB Smart Chain (BEP-20)', expiresAt: inAnHour() },
  ...over,
});

const renderPanel = (props: any = {}) => render(
  <UsdtBuyPanel bounds={BOUNDS} tokensPerUsdt={TOKENS_PER_USDT} chains={CHAINS} {...props} />,
);

beforeEach(() => {
  post.mockReset(); post.mockResolvedValue({ success: true });
  get.mockReset(); get.mockResolvedValue({ success: true, status: 'PROCESSING', usdtReceived: 0 });
});
afterEach(() => { vi.useRealTimers(); });

const amountBox = () => screen.getByLabelText(/USDT to send/i) as HTMLInputElement;
const typeUsdt = (v: string) => fireEvent.change(amountBox(), { target: { value: v } });
const startButton = () => screen.getByRole('button', { name: /Get my payment address/ });

describe('choosing an amount', () => {
  it('takes USDT, and says the bounds and the step the server sent', () => {
    renderPanel();
    expect(amountBox()).toBeInTheDocument();
    expect(screen.getByRole('status').textContent).toMatch(/100 to 10,000 USDT, in steps of 100/);
  });

  it('shows what the player RECEIVES for what they SEND', () => {
    renderPanel();
    typeUsdt('300');
    expect(screen.getByRole('status').textContent).toMatch(/You receive 30,000 tokens/);
  });

  it('prices from the SERVER’s rate, in paise, as the order will', () => {
    // 100 × 88.55 in floating point is 8854.999…; the server works in paise.
    render(<UsdtBuyPanel bounds={BOUNDS} tokensPerUsdt={88.55} chains={CHAINS} />);
    typeUsdt('100');
    expect(screen.getByRole('status').textContent).toMatch(/You receive 8,855 tokens/);
  });

  it('refuses an amount off the step or outside the bounds, and says why', () => {
    renderPanel();
    for (const bad of ['150', '50', '10100']) {
      typeUsdt(bad);
      expect(screen.getByRole('status').textContent).toMatch(/Choose 100 to 10,000 USDT, in steps of 100/);
      expect(startButton()).toBeDisabled();
    }
  });

  it('steps by 100 inside the bounds', () => {
    renderPanel({ bounds: { minUsdt: 200, maxUsdt: 400, stepUsdt: 100 } });
    const more = screen.getByRole('button', { name: /100 USDT more/ });
    fireEvent.click(more);
    expect(amountBox().value).toBe('200');
    fireEvent.click(more); fireEvent.click(more); fireEvent.click(more);
    expect(amountBox().value).toBe('400');
    fireEvent.click(screen.getByRole('button', { name: /100 USDT less/ }));
    expect(amountBox().value).toBe('300');
  });

  it('offers NOTHING when no rate has been set', () => {
    render(<UsdtBuyPanel bounds={BOUNDS} tokensPerUsdt={null} chains={CHAINS} />);
    expect(screen.getByText(/not available right now/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/USDT to send/i)).toBeNull();
  });

  it('names the one network before an order exists, and offers no choice of another', () => {
    renderPanel();
    expect(screen.getAllByText(/BNB Smart Chain \(BEP-20\)/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByText(/Tron/)).toBeNull();
  });

  it('sends the USDT and the network, and no token count', async () => {
    renderPanel();
    typeUsdt('1000');
    fireEvent.click(startButton());
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/api/payment/usdt/deposit/create', { usdtAmount: 1000, usdtChain: 'BEP20' },
    ));
  });

  it('surfaces a refusal instead of pretending the order was created', async () => {
    post.mockRejectedValue({ message: 'You already have a USDT purchase in progress.' });
    renderPanel();
    typeUsdt('100');
    fireEvent.click(startButton());
    expect(await screen.findByText(/already have a USDT purchase/)).toBeInTheDocument();
  });
});

describe('an open order', () => {
  it('shows the address AND the network it belongs to', () => {
    renderPanel({ order: open() });
    expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    expect(screen.getByText('BNB Smart Chain (BEP-20)')).toBeInTheDocument();
    expect(screen.getByText(/cannot be recovered/i)).toBeInTheDocument();
  });

  it('asks for nothing: no transaction ID and no "I have paid"', () => {
    renderPanel({ order: open() });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /sent it|paid/i })).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/added by themselves/);
  });

  it('shows the order’s OWN quote, not one recomputed from today’s rate', () => {
    render(<UsdtBuyPanel bounds={BOUNDS} tokensPerUsdt={50} chains={CHAINS} order={open({ fiatAmount: 500 })} />);
    expect(screen.getByText('500 USDT')).toBeInTheDocument();
    expect(screen.queryByText('1,000 USDT')).toBeNull();
    expect(screen.getByText('50,000 tokens')).toBeInTheDocument();
  });

  it('counts down to the deadline the server set', () => {
    renderPanel({ order: open() });
    expect(screen.getByRole('timer').textContent).toMatch(/Time left (59|60):\d\d/);
  });

  it('says what is still owed once part has arrived', () => {
    renderPanel({ order: open({ usdtReceived: 200 }) });
    expect(screen.getByText('200 USDT')).toBeInTheDocument();
    expect(screen.getByRole('status').textContent).toMatch(/300 USDT still to send/);
  });

  it('asks the server what has arrived, and hands back when the order finishes', async () => {
    vi.useFakeTimers();
    const onChanged = vi.fn();
    get.mockResolvedValue({ success: true, status: 'COMPLETED', usdtReceived: 500, payTo: null });
    renderPanel({ order: open(), onChanged });
    await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
    expect(get).toHaveBeenCalledWith('/api/payment/order/ORD-USDT-1/status');
    expect(onChanged).toHaveBeenCalled();
  });

  it('shows NO address on an order that has none to send to', () => {
    // An empty address rendered as a destination is how somebody sends USDT
    // into nothing; and an address without its network is the same mistake.
    renderPanel({ order: open({ payTo: null }) });
    expect(screen.getByText(/Do not send anything/i)).toBeInTheDocument();
    renderPanel({ order: open({ payTo: { usdtAddress: ADDRESS } }) });
    expect(screen.queryByText(ADDRESS)).toBeNull();
  });
});
