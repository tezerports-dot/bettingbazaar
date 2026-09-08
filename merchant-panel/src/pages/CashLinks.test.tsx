// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * The ATM cash-rail screen.
 *
 * ── Why these four states and not a render smoke test ──────────────────────
 * An expired link earns the merchant nothing — no compensation, no money — so
 * every wrong signal on this screen costs them a journey to a cash machine.
 * The states that must be told apart:
 *
 *   1. NOT APPROVED versus NOTHING WAITING. Both would render an empty screen,
 *      and this codebase has already shipped that confusion five times: a
 *      failed call, a caught error, an empty state, and nobody able to tell it
 *      from "no data".
 *
 *   2. WORK EXISTS versus WORK YOU CAN TAKE. `worthGoing` comes from the
 *      server, which is the only side that knows the merchant's token balance.
 *      Deriving it here from `waiting > 0` would send a merchant with no tokens
 *      to an ATM for an order they cannot serve.
 *
 *   3. A LIVE LINK, with its real countdown, so they know whether to wait or
 *      go back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getCashLinkState: vi.fn(),
  supplyCashLink: vi.fn(),
  cancelCashLink: vi.fn(),
}));
const sse = vi.hoisted(() => {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  return {
    handlers,
    on: vi.fn((e: string, h: (d: unknown) => void) => {
      if (!handlers.has(e)) handlers.set(e, new Set());
      handlers.get(e)!.add(h);
    }),
    off: vi.fn((e: string, h: (d: unknown) => void) => { handlers.get(e)?.delete(h); }),
    fire: (e: string, d: unknown) => { handlers.get(e)?.forEach((h) => h(d)); },
  };
});

vi.mock('../services/api', () => api);
vi.mock('../services/sse', () => ({ default: { on: sse.on, off: sse.off } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import CashLinks from './CashLinks';

const state = (over = {}) => ({
  approved: true, denomination: 5000, live: null, waiting: 0, worthGoing: false, ...over,
});

beforeEach(() => {
  api.getCashLinkState.mockReset();
  api.supplyCashLink.mockReset();
  api.cancelCashLink.mockReset();
  sse.handlers.clear();
});

describe('the ATM cash-rail screen', () => {
  it('says a merchant is not approved, rather than showing an empty queue', async () => {
    api.getCashLinkState.mockResolvedValue(state({ approved: false, denomination: null }));
    render(<CashLinks />);
    expect(await screen.findByText(/not approved for the ATM cash rail/i)).toBeInTheDocument();
    // And offers no way to supply one, which would fail at the server anyway.
    expect(screen.queryByText(/Supply link/i)).not.toBeInTheDocument();
  });

  it('tells work-exists apart from work-you-can-take', async () => {
    // Orders are waiting, but this merchant's tokens are committed. Sending
    // them to a machine here is the wasted trip nothing compensates.
    api.getCashLinkState.mockResolvedValue(state({ waiting: 3, worthGoing: false }));
    const { unmount } = render(<CashLinks />);
    expect(await screen.findByText(/cannot take it yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/Worth a trip/i)).not.toBeInTheDocument();
    unmount();

    api.getCashLinkState.mockResolvedValue(state({ waiting: 3, worthGoing: true }));
    render(<CashLinks />);
    expect(await screen.findByText(/Worth a trip/i)).toBeInTheDocument();
  });

  it('shows the merchant only their own denomination', async () => {
    api.getCashLinkState.mockResolvedValue(state({ denomination: 1000, waiting: 2 }));
    render(<CashLinks />);
    expect(await screen.findByText(/Your denomination: ₹1,000/)).toBeInTheDocument();
    expect(screen.getByText(/orders waiting for a link/i)).toBeInTheDocument();
  });

  it('shows a live link with its countdown, and offers to withdraw it', async () => {
    api.getCashLinkState.mockResolvedValue(state({
      live: {
        linkId: 'clk_1',
        paymentLink: 'upi://pay?pa=atm&am=5000',
        expiresAt: new Date(Date.now() + 95_000).toISOString(),
      },
    }));
    render(<CashLinks />);
    expect(await screen.findByText(/Your link is waiting/i)).toBeInTheDocument();
    expect(screen.getByText('upi://pay?pa=atm&am=5000')).toBeInTheDocument();
    // The supply form is gone: one live link at a time is the server's rule,
    // and offering the form anyway would invite a refusal.
    expect(screen.queryByLabelText(/Payment link/i)).not.toBeInTheDocument();

    api.cancelCashLink.mockResolvedValue(undefined);
    fireEvent.click(screen.getByText(/Withdraw this link/i));
    await waitFor(() => expect(api.cancelCashLink).toHaveBeenCalledWith('clk_1'));
  });

  it('re-reads on a demand push instead of trusting the payload', async () => {
    api.getCashLinkState
      .mockResolvedValueOnce(state({ waiting: 0 }))
      .mockResolvedValueOnce(state({ waiting: 4, worthGoing: true }));
    render(<CashLinks />);
    expect(await screen.findByText(/Nothing waiting/i)).toBeInTheDocument();

    // The push says demand changed. It does not know this merchant's balance,
    // so the screen asks the server rather than rendering what arrived.
    sse.fire('cash_link_demand', { denominationPaise: 500_000, waiting: 4 });
    expect(await screen.findByText(/Worth a trip/i)).toBeInTheDocument();
    expect(api.getCashLinkState).toHaveBeenCalledTimes(2);
  });

  it('subscribes to the event name the SSE service actually registers', () => {
    api.getCashLinkState.mockResolvedValue(state());
    render(<CashLinks />);
    // Subscribing to a name sse.ts does not list is a dead subscription that
    // never fires and never errors — the `merchant_stats` defect, again.
    expect(sse.on).toHaveBeenCalledWith('cash_link_demand', expect.any(Function));
  });
});
