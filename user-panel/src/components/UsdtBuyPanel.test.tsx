// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * Buying with USDT, from the player's side.
 *
 * ── The one mistake this screen exists to prevent ──────────────────────────
 * USDT is one token on several blockchains and they are NOT interchangeable.
 * Tokens sent to a Tron address from a BNB Smart Chain wallet are gone — no
 * support desk recovers them. It is the only unrecoverable mistake available on
 * this platform, so the assertions here are mostly about the NETWORK: that it
 * is chosen before an order exists, that it is shown beside the address every
 * time, and that a transaction ID from the wrong chain is refused before it is
 * submitted.
 *
 * ── And the two states that must not look alike ────────────────────────────
 * "Waiting for a merchant" and "here is where to send" are different facts. An
 * empty address rendered as a destination is how somebody sends tokens into
 * nothing, which is the empty-state-as-success failure in the place it costs
 * the most.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../services/apiClient', () => ({ default: { post, get: vi.fn() } }));

import { UsdtBuyPanel } from './UsdtBuyPanel';

// PLATFORM TOKENS, as the server sends them. What a player SENDS is derived
// from the rate, so a size is only ever half of what the tile has to say.
const DENOMINATIONS = [50000, 100000, 500000];
const TOKENS_PER_USDT = 100;
const CHAINS = [
  { chain: 'TRC20', label: 'Tron (TRC-20)' },
  { chain: 'BEP20', label: 'BNB Smart Chain (BEP-20)' },
];

const TRON_ADDRESS = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
const hex64 = 'a'.repeat(64);

const assigned = (over: any = {}) => ({
  orderId: 'ORD-USDT-1',
  status: 'ASSIGNED',
  tokenAmount: 50000,
  // The order's OWN quote, fixed at creation. Never recomputed on the screen.
  fiatAmount: 500,
  usdtChain: 'TRC20',
  payTo: {
    usdtAddress: TRON_ADDRESS,
    usdtChain: 'TRC20',
    usdtChainLabel: 'Tron (TRC-20)',
    merchantRef: 'Merchant #7731',
  },
  ...over,
});

const renderPanel = (props: any = {}) => render(
  <UsdtBuyPanel
    denominations={DENOMINATIONS}
    tokensPerUsdt={TOKENS_PER_USDT}
    chains={CHAINS}
    {...props}
  />,
);

beforeEach(() => { post.mockReset(); post.mockResolvedValue({ success: true }); });

describe('choosing an amount and a network', () => {
  it('offers exactly the sizes the server serves, and no free field', () => {
    // A typed amount would let a player ask for a size no merchant is queued
    // for and be refused after choosing a network.
    renderPanel();
    expect(screen.getByRole('radio', { name: /50,000 tokens/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /1,00,000 tokens/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /5,00,000 tokens/ })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows what the player RECEIVES and what they SEND, on every tile', () => {
    // The denomination is a token count; the price comes from the admin's rate.
    // A tile showing only one leaves the player guessing at the number that
    // will actually leave their wallet — the only number their wallet asks for.
    renderPanel();
    expect(screen.getByRole('radio', { name: /50,000 tokens.*500 USDT/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /1,00,000 tokens.*1,000 USDT/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /5,00,000 tokens.*5,000 USDT/ })).toBeInTheDocument();
  });

  it('prices from the SERVER’s rate, not a rate of its own', () => {
    // The rate is admin-editable. A panel holding a copy would quote a price
    // the order refuses — the same drift that put two owners on the config
    // payload. Halving the rate must double every price on the screen.
    render(
      <UsdtBuyPanel denominations={[50000]} tokensPerUsdt={50} chains={CHAINS} />,
    );
    expect(screen.getByRole('radio', { name: /50,000 tokens.*1,000 USDT/ })).toBeInTheDocument();
  });

  it('offers NOTHING when no rate has been set', () => {
    // 0 is the schema default and 0 is not a rate. Offering unpriceable sizes
    // is how a player picks one and is refused for a reason the screen never
    // showed them; the server refuses these outright with USDT_RATE_UNSET.
    render(<UsdtBuyPanel denominations={DENOMINATIONS} tokensPerUsdt={null} chains={CHAINS} />);
    expect(screen.getByText(/not available right now/i)).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull();
  });

  it('offers the networks the server named', () => {
    renderPanel();
    expect(screen.getByRole('radio', { name: /Tron \(TRC-20\)/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /BNB Smart Chain \(BEP-20\)/ })).toBeInTheDocument();
  });

  it('will not create an order until BOTH are chosen', () => {
    // The network decides which merchants can serve the order, so it cannot be
    // asked for afterwards — that would mean reassigning an order already
    // placed.
    renderPanel();
    const go = screen.getByRole('button', { name: /Continue/ });
    expect(go).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: /50,000 tokens/ }));
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: /Tron/ }));
    expect(screen.getByRole('button', { name: /Continue/ })).toBeEnabled();
  });

  it('sends the amount and the network the player picked', async () => {
    renderPanel();
    fireEvent.click(screen.getByRole('radio', { name: /1,00,000 tokens/ }));
    fireEvent.click(screen.getByRole('radio', { name: /BNB Smart Chain/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/api/payment/usdt/deposit/create',
      { tokenAmount: 100000, usdtChain: 'BEP20' },
    ));
  });

  it('surfaces a refusal instead of pretending the order was created', async () => {
    post.mockRejectedValue({ message: 'You already have a USDT purchase in progress.' });
    renderPanel();
    fireEvent.click(screen.getByRole('radio', { name: /50,000 tokens/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Tron/ }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));
    expect(await screen.findByText(/already have a USDT purchase/)).toBeInTheDocument();
  });
});

describe('an order waiting for a merchant', () => {
  it('says so, and shows NO address', () => {
    // An empty address rendered as a destination is how somebody sends tokens
    // into nothing.
    renderPanel({ order: { orderId: 'O1', status: 'PENDING_QUEUE', tokenAmount: 50000, fiatAmount: 500, usdtChain: 'TRC20', payTo: null } });
    expect(screen.getByText(/Finding a merchant/i)).toBeInTheDocument();
    expect(screen.getByText(/do not send anything until then/i)).toBeInTheDocument();
    expect(screen.queryByText(TRON_ADDRESS)).toBeNull();
  });

  it('shows no address when the payTo names one with no chain', () => {
    // An address without its network is exactly the shape of the mistake: the
    // player cannot know which chain to send on, and half of them will guess.
    renderPanel({ order: assigned({ payTo: { usdtAddress: TRON_ADDRESS, merchantRef: 'M' } }) });
    expect(screen.getByText(/Finding a merchant/i)).toBeInTheDocument();
    expect(screen.queryByText(TRON_ADDRESS)).toBeNull();
  });
});

describe('an assigned order', () => {
  it('shows the address AND the network it belongs to', () => {
    renderPanel({ order: assigned() });
    expect(screen.getByText(TRON_ADDRESS)).toBeInTheDocument();
    expect(screen.getByText('Tron (TRC-20)')).toBeInTheDocument();
    expect(screen.getByText(/cannot be recovered/i)).toBeInTheDocument();
  });

  it('names the merchant only by an opaque reference', () => {
    // A player sees where to pay and nothing about who they are paying.
    renderPanel({ order: assigned() });
    expect(screen.getByText('Merchant #7731')).toBeInTheDocument();
  });

  it('shows the order’s OWN quote, not one recomputed from today’s rate', () => {
    // The rate is admin-editable and an order is quoted at creation. A screen
    // that re-derived the figure would tell a player to send an amount their
    // order does not hold — and they would send it.
    render(
      <UsdtBuyPanel
        denominations={DENOMINATIONS}
        tokensPerUsdt={50}
        chains={CHAINS}
        order={assigned({ fiatAmount: 500 })}
      />,
    );
    expect(screen.getByText('500 USDT')).toBeInTheDocument();
    // 50 tokens per USDT would make this 1,000 — the number a re-derivation
    // would print, and the number that must not appear.
    expect(screen.queryByText('1,000 USDT')).toBeNull();
    expect(screen.getByText('50,000 tokens')).toBeInTheDocument();
  });

  it('shows a dash rather than inventing an amount it was not sent', () => {
    // An order missing its quote is a bug upstream. Printing 0, or a figure
    // computed here, would have somebody send the wrong number.
    renderPanel({ order: assigned({ fiatAmount: null }) });
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('accepts the chain’s own transaction id shape', async () => {
    renderPanel({ order: assigned() });
    fireEvent.change(screen.getByPlaceholderText(/hexadecimal/i), { target: { value: hex64 } });
    fireEvent.click(screen.getByRole('button', { name: /sent it/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/api/payment/order/ORD-USDT-1/mark-paid', { utrNumber: hex64 },
    ));
  });

  it('REFUSES the other chain’s transaction id before submitting it', () => {
    // A BEP-20 hash on a Tron order is proof of a payment the merchant is not
    // watching for. Catching it here is the only cheap moment.
    renderPanel({ order: assigned() });
    fireEvent.change(screen.getByPlaceholderText(/hexadecimal/i), { target: { value: `0x${hex64}` } });
    expect(screen.getByText(/not a Tron \(TRC-20\) transaction ID/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sent it/i })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });

  it('checks the shape for the order’s OWN chain, not a fixed one', () => {
    renderPanel({
      order: assigned({
        usdtChain: 'BEP20',
        payTo: {
          usdtAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0',
          usdtChain: 'BEP20', usdtChainLabel: 'BNB Smart Chain (BEP-20)', merchantRef: 'M',
        },
      }),
    });
    // On a BEP-20 order it is the 0x form that is right, and the bare one wrong.
    fireEvent.change(screen.getByPlaceholderText(/hexadecimal/i), { target: { value: hex64 } });
    expect(screen.getByText(/not a BNB Smart Chain \(BEP-20\) transaction ID/i)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/hexadecimal/i), { target: { value: `0x${hex64}` } });
    expect(screen.getByRole('button', { name: /sent it/i })).toBeEnabled();
  });

  it('says in full that a transaction id was already used', async () => {
    // The whole sentence, not "invalid". A player retyping a hash that will
    // never be accepted is a support ticket the message could have prevented.
    post.mockRejectedValue({ message: 'This transaction ID has already been used for another order.' });
    renderPanel({ order: assigned() });
    fireEvent.change(screen.getByPlaceholderText(/hexadecimal/i), { target: { value: hex64 } });
    fireEvent.click(screen.getByRole('button', { name: /sent it/i }));
    expect(await screen.findByText(/already been used for another order/i)).toBeInTheDocument();
  });

  it('stops asking for a transaction id once one is submitted', () => {
    renderPanel({ order: assigned({ status: 'PAID' }) });
    expect(screen.getByText(/merchant is confirming it/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sent it/i })).toBeNull();
  });
});
