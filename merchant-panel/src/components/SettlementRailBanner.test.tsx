// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * A merchant must always be able to see which workflow they are performing.
 *
 * ── What this is protecting ─────────────────────────────────────────────────
 * The platform runs one of two settlement rails and an admin can switch between
 * them at any moment. The two ask different things of a merchant: on the UPI
 * rail they take a UTR against their own UPI; on the ATM cash rail they scan a
 * cash-withdrawal QR and settle deposits at a CDM. A merchant performing
 * yesterday's workflow leaves a player waiting for a payment nobody is sending.
 *
 * Three assertions, and the first is the important one:
 *
 *   1. With the rail UNKNOWN the banner renders NOTHING. A banner that
 *      confidently names a default workflow is worse than no banner, because
 *      the merchant acts on it.
 *   2. It renders what the server said, not a copy of its own. The wording a
 *      merchant reads has one owner (paymentMode.service.js) so that the banner
 *      and the notification cannot drift apart.
 *   3. A live switch RE-READS rather than rendering the pushed payload — same
 *      reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ getPaymentMode: vi.fn() }));
const sse = vi.hoisted(() => {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  return {
    handlers,
    on: vi.fn((e: string, h: (d: unknown) => void) => {
      if (!handlers.has(e)) handlers.set(e, new Set());
      handlers.get(e)!.add(h);
    }),
    off: vi.fn((e: string, h: (d: unknown) => void) => { handlers.get(e)?.delete(h); }),
    fire: (e: string, data: unknown) => { handlers.get(e)?.forEach((h) => h(data)); },
  };
});

vi.mock('../services/api', () => ({ getPaymentMode: api.getPaymentMode }));
vi.mock('../services/sse', () => ({ default: { on: sse.on, off: sse.off } }));

import { SettlementRailBanner } from './SettlementRailBanner';

const upi = {
  activeMode: 'P2P_UPI' as const,
  version: 4,
  label: 'UPI settlement',
  merchantMessage: 'Buy orders are paid to your UPI and confirmed by UTR.',
  timers: {
    assignmentWaitSeconds: 1500, processingWindowSeconds: 900, utrSubmitSeconds: 60,
    disputeWindowSeconds: 1800, linkExpirySeconds: 120, linkMinRemainingSeconds: 60,
  },
};
const atm = {
  ...upi,
  activeMode: 'CASH_ATM' as const,
  version: 5,
  label: 'ATM cash settlement',
  merchantMessage: 'Buy orders are served by scanning an ATM cash-withdrawal QR.',
};

beforeEach(() => {
  api.getPaymentMode.mockReset();
  sse.handlers.clear();
});

describe('the settlement rail a merchant is on', () => {
  it('renders nothing at all while the rail is unknown', async () => {
    // A failing read must not become a confident wrong answer on screen.
    api.getPaymentMode.mockRejectedValue(new Error('offline'));
    const { container } = render(<SettlementRailBanner />);
    await waitFor(() => expect(api.getPaymentMode).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the wording the server sent, not a copy of its own', async () => {
    api.getPaymentMode.mockResolvedValue(upi);
    render(<SettlementRailBanner />);

    expect(await screen.findByText(/UPI settlement/)).toBeInTheDocument();
    // The exact sentence the merchant's notification also carries.
    expect(screen.getByText(upi.merchantMessage)).toBeInTheDocument();
    // The window they are actually held to, from the policy rather than a
    // constant in the panel.
    expect(screen.getByText(/15 min to act/)).toBeInTheDocument();
  });

  it('re-reads on a live switch instead of trusting the pushed payload', async () => {
    api.getPaymentMode.mockResolvedValueOnce(upi).mockResolvedValueOnce(atm);
    render(<SettlementRailBanner />);
    expect(await screen.findByText(/UPI settlement/)).toBeInTheDocument();

    // The server pushes a change. The banner asks the server what the rail is
    // rather than rendering what the event claimed — one owner for the answer.
    sse.fire('payment_mode_changed', { activeMode: 'CASH_ATM', version: 5 });

    expect(await screen.findByText(/ATM cash settlement/)).toBeInTheDocument();
    expect(api.getPaymentMode).toHaveBeenCalledTimes(2);
    // And it says the thing every merchant asks next.
    expect(screen.getByText(/keep the process they were created under/i)).toBeInTheDocument();
  });

  it('subscribes to the event name the SSE service actually registers', () => {
    api.getPaymentMode.mockResolvedValue(upi);
    render(<SettlementRailBanner />);
    // Subscribing to a name sse.ts does not list is a dead subscription that
    // never fires and never errors — the `merchant_stats` defect, again.
    expect(sse.on).toHaveBeenCalledWith('payment_mode_changed', expect.any(Function));
  });
});
