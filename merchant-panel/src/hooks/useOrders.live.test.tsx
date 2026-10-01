// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What the server pushes about an order reaches the merchant's list — through
 * the REAL SSE client, with only the browser's EventSource replaced.
 *
 * ── What was wrong (2026-10-01) ─────────────────────────────────────────────
 * The panel's SSE client registers a listener per NAME, so a name it does not
 * list is never delivered and nothing errors (CLAUDE.md §12). Two things the
 * server sends a merchant were in that position:
 *
 *   · `order_paid` — the player tapped Paid. Never listed, so the order sat
 *     unchanged until a reload while `paidResponseMinutes` ran against the
 *     merchant, and the sweep then counts the silence as a refusal.
 *   · a moved UTR deadline, sent as `order_updated` — a typo variant of
 *     `order_update`. It is `order_update` now.
 *
 * A test that mocks the SSE module cannot see this: the defect is in which
 * names the transport registers, which is the half a mock replaces.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ getOrders: vi.fn() }));
vi.mock('../services/api', () => ({ api: { getOrders: api.getOrders } }));

/** A stand-in for the browser's EventSource that records what was registered. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static CLOSED = 2;
  static OPEN = 1;
  readyState = 1;
  url: string;
  listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) { this.url = url; FakeEventSource.instances.push(this); }
  addEventListener(name: string, fn: (e: MessageEvent) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name)!.push(fn);
  }
  dispatch(name: string, data: unknown) {
    for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(data) } as MessageEvent);
  }
  close() { this.readyState = 2; }
}

const merchantStream = () => FakeEventSource.instances.find((s) => s.url.includes('/api/sse/merchant/events'))!;

describe('the merchant order list, live', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    localStorage.setItem('merchantToken', 'merchant-session');
    api.getOrders.mockResolvedValue({
      orders: [{ _id: 'ord-1', orderId: 'ord-1', type: 'DEPOSIT', status: 'ASSIGNED', expiresAt: '2026-10-01T10:00:00.000Z', createdAt: '2026-10-01T09:30:00.000Z' }],
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  const mount = async () => {
    vi.resetModules();
    const { default: sseService } = await import('../services/sse');
    const { useOrders } = await import('./useOrders');
    const Probe = () => {
      const { orders } = useOrders();
      return <ul>{orders.map((o: any) => <li key={o._id}>{`${o._id} ${o.status} ${o.type} ${o.expiresAt}`}</li>)}</ul>;
    };
    render(<Probe />);
    await screen.findByText(/ord-1 ASSIGNED/);
    sseService.connect();
    return merchantStream();
  };

  it("moves the order to PAID when the player taps Paid", async () => {
    const stream = await mount();
    act(() => stream.dispatch('order_paid', {
      orderId: 'ord-1', _id: 'ord-1', status: 'PAID', utrNumber: null, awaitingReference: true,
    }));
    await waitFor(() => expect(screen.getByText(/ord-1 PAID DEPOSIT/)).toBeInTheDocument());
  });

  it('takes a moved deadline on order_update, keeping the order\'s own type', async () => {
    const stream = await mount();
    act(() => stream.dispatch('order_update', { orderId: 'ord-1', expiresAt: '2026-10-01T10:15:00.000Z' }));
    await waitFor(() => expect(screen.getByText('ord-1 ASSIGNED DEPOSIT 2026-10-01T10:15:00.000Z')).toBeInTheDocument());
  });

  it('registers every name the order list subscribes to on the merchant stream', async () => {
    const stream = await mount();
    for (const name of ['merchant_orders_snapshot', 'new_order', 'order_update', 'order_paid']) {
      expect(stream.listeners.has(name), `${name} is subscribed but never registered`).toBe(true);
    }
  });
});
