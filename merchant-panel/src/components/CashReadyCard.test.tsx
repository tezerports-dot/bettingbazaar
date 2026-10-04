// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The Ready switch a CASH team member presses at the ATM (redesign Step 2c).
 *
 * What is asserted, against the server's own contract
 * (backend/domains/merchant/merchant.routes.js PUT /cash-ready, formatMerchant,
 * backend/domains/team/team.merchant.routes.js GET /team):
 *   - it exists ONLY for an approved member of a CASH team — every other reader
 *     of GET /team gets nothing, because Ready means nothing on other rails;
 *   - it shows the PROFILE's `cashReady`, switches it on and off through
 *     PUT /cash-ready, and re-reads the profile after the press;
 *   - an assignment (`new_order` on the merchant stream) re-reads the profile,
 *     because being given a cash buy is when the server turns Ready OFF;
 *   - a refusal is shown in the server's words and announced (role="alert").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getMyTeam: vi.fn(),
  setCashReady: vi.fn(),
}));
const auth = vi.hoisted(() => ({
  merchant: null as Record<string, unknown> | null,
  refreshProfile: vi.fn(),
}));
const stream = vi.hoisted(() => {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  return {
    handlers,
    on: vi.fn((ev: string, cb: (d: unknown) => void) => {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev)!.add(cb);
    }),
    off: vi.fn((ev: string, cb: (d: unknown) => void) => { handlers.get(ev)?.delete(cb); }),
    emit: (ev: string, data: unknown = {}) => handlers.get(ev)?.forEach((cb) => cb(data)),
  };
});

vi.mock('../services/api', () => ({
  ...api,
  // The Dashboard's own reads, for the one case that renders it.
  api: {
    getStats: vi.fn().mockResolvedValue({}),
    getEarnings: vi.fn().mockResolvedValue({ earnings: null }),
    getWeeklyEarnings: vi.fn().mockResolvedValue({ weekly: [] }),
    toggleOnlineStatus: vi.fn(),
  },
}));
vi.mock('../services/AuthContext', () => ({
  useAuth: () => ({ merchant: auth.merchant, refreshProfile: auth.refreshProfile }),
}));
vi.mock('../services/sse', () => ({ default: stream, sseService: stream }));
vi.mock('../hooks/useOrders', () => ({
  useOrders: () => ({ orders: [], state: 'ready', counts: {} }),
  needsAction: () => false,
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import { CashReadyCard } from './CashReadyCard';
import Dashboard from '../pages/Dashboard';

const team = (rail: string) => ({
  teamId: 't-1', supervisorId: 's-1', supervisorName: 'Sup', supervisorRef: 'MSUP', name: 'Alpha', rail,
  approvedCount: 10, pendingCount: 0, size: 10, strength: 'WORKING', shortSince: null, wasFull: true,
  createdAt: '', poolAvailablePaise: 0, poolHeldPaise: 0,
});
const cashMember = { role: 'MEMBER', publicRef: 'M1', status: 'APPROVED', team: team('CASH') };
const merchant = (extra: Record<string, unknown> = {}) => ({ id: 'm-1', isOnline: true, cashReady: false, ...extra });
const theSwitch = () => screen.findByRole('switch', { name: 'Ready for a cash buy' });
// The switch is drawn in the same commit that subscribes, but the subscription
// is a passive effect React may flush after `findByRole` has resolved. Emitting
// before it lands reaches nobody, so a test that emits waits for it first.
const subscribed = (ev: string) => waitFor(() => expect(stream.handlers.get(ev)?.size ?? 0).toBeGreaterThan(0));

describe('the cash Ready switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stream.handlers.clear();
    auth.refreshProfile.mockResolvedValue(undefined);
  });

  it.each([
    ['a member of a UPI_BANK team', { role: 'MEMBER', publicRef: 'M1', status: 'APPROVED', team: team('UPI_BANK') }],
    ['a member of a USDT team', { role: 'MEMBER', publicRef: 'M1', status: 'APPROVED', team: team('USDT') }],
    ['a cash member an admin has not approved yet', { role: 'MEMBER', publicRef: 'M1', status: 'PENDING', team: team('CASH') }],
    ['a supervisor of a cash team', { role: 'SUPERVISOR', rail: 'CASH', publicRef: 'MS', teams: [], members: [], poolRequests: [] }],
    ['a merchant in no team', { role: 'NONE', publicRef: 'M1' }],
  ])('is not shown to %s', async (_who, mine) => {
    auth.merchant = merchant();
    api.getMyTeam.mockResolvedValue(mine);
    const { container } = render(<CashReadyCard />);
    await waitFor(() => expect(api.getMyTeam).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('switches Ready ON for an approved cash member, and re-reads the profile', async () => {
    auth.merchant = merchant({ cashReady: false });
    api.getMyTeam.mockResolvedValue(cashMember);
    api.setCashReady.mockResolvedValue(true);
    render(<CashReadyCard />);
    const sw = await theSwitch();
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/Press Ready when you are at the ATM/)).toBeInTheDocument();

    fireEvent.click(sw);
    await waitFor(() => expect(api.setCashReady).toHaveBeenCalledWith(true));
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
    expect(auth.refreshProfile).toHaveBeenCalled();
    // The rule the member works by: an assignment switches it off, press again.
    expect(screen.getByText(/Being given one switches Ready off/)).toBeInTheDocument();
    expect(screen.getByText(/Press Ready again when you are free/)).toBeInTheDocument();
  });

  it('switches Ready OFF when it is on (the opposite press)', async () => {
    auth.merchant = merchant({ cashReady: true });
    api.getMyTeam.mockResolvedValue(cashMember);
    api.setCashReady.mockResolvedValue(false);
    render(<CashReadyCard />);
    const sw = await theSwitch();
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    await waitFor(() => expect(api.setCashReady).toHaveBeenCalledWith(false));
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'));
  });

  it('shows the server refusal in its own words, announced, and leaves Ready as it was', async () => {
    auth.merchant = merchant({ cashReady: false });
    api.getMyTeam.mockResolvedValue(cashMember);
    api.setCashReady.mockRejectedValue(
      new Error('Ready is only for members of a cash team. Ask your supervisor to add you to one.'));
    render(<CashReadyCard />);
    const sw = await theSwitch();
    fireEvent.click(sw);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Ready is only for members of a cash team. Ask your supervisor to add you to one.');
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(auth.refreshProfile).not.toHaveBeenCalled();
  });

  it('re-reads the profile when an order is assigned, and shows Ready off once the server has switched it off', async () => {
    auth.merchant = merchant({ cashReady: true });
    api.getMyTeam.mockResolvedValue(cashMember);
    const { rerender } = render(<CashReadyCard />);
    const sw = await theSwitch();
    expect(sw).toHaveAttribute('aria-checked', 'true');

    await subscribed('new_order');
    act(() => { stream.emit('new_order', { orderId: 'O-1', type: 'DEPOSIT', paymentMode: 'CASH_ATM' }); });
    expect(auth.refreshProfile).toHaveBeenCalledTimes(1);

    // What refreshProfile brings back: the assignment turned Ready off.
    auth.merchant = merchant({ cashReady: false });
    rerender(<CashReadyCard />);
    expect(await theSwitch()).toHaveAttribute('aria-checked', 'false');
  });

  it('lets a re-read profile override the last press even when it carries the same flag as before', async () => {
    // Profile false → press → server says true. The re-read after the press
    // brings nothing new (a blip). Then a cash buy is assigned and the next
    // re-read says false — the SAME value the profile held before the press.
    // Keyed on the flag rather than the profile, the switch would stay lit.
    auth.merchant = merchant({ cashReady: false });
    api.getMyTeam.mockResolvedValue(cashMember);
    api.setCashReady.mockResolvedValue(true);
    const { rerender } = render(<CashReadyCard />);
    const sw = await theSwitch();
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));

    await subscribed('new_order');
    act(() => { stream.emit('new_order', {}); });
    auth.merchant = merchant({ cashReady: false });
    rerender(<CashReadyCard />);
    expect(await theSwitch()).toHaveAttribute('aria-checked', 'false');
  });

  it('re-reads the profile when the merchant stream reconnects, in case an assignment was missed', async () => {
    auth.merchant = merchant({ cashReady: true });
    api.getMyTeam.mockResolvedValue(cashMember);
    render(<CashReadyCard />);
    await theSwitch();
    await subscribed('merchant_orders_snapshot');
    act(() => { stream.emit('merchant_orders_snapshot', { orders: [] }); });
    expect(auth.refreshProfile).toHaveBeenCalledTimes(1);
  });

  it('subscribes to nothing for a merchant who is not a cash member', async () => {
    auth.merchant = merchant();
    api.getMyTeam.mockResolvedValue({ role: 'NONE', publicRef: 'M1' });
    render(<CashReadyCard />);
    await waitFor(() => expect(api.getMyTeam).toHaveBeenCalled());
    await act(async () => {});
    act(() => { stream.emit('new_order', {}); });
    expect(auth.refreshProfile).not.toHaveBeenCalled();
  });

  it('warns a Ready member who is offline that no cash buy reaches them', async () => {
    auth.merchant = merchant({ cashReady: true, isOnline: false });
    api.getMyTeam.mockResolvedValue(cashMember);
    render(<CashReadyCard />);
    await theSwitch();
    expect(screen.getByText(/You are offline, so no cash buy reaches you/)).toBeInTheDocument();
  });

  it('says so when the team could not be read, and checks again on request', async () => {
    auth.merchant = merchant();
    api.getMyTeam.mockRejectedValueOnce(new Error('Request failed with status 502'));
    api.getMyTeam.mockResolvedValueOnce(cashMember);
    render(<CashReadyCard />);
    expect(await screen.findByText(/Could not check whether you are in a cash team/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Check again/ }));
    expect(await theSwitch()).toBeInTheDocument();
    expect(api.getMyTeam).toHaveBeenCalledTimes(2);
  });

  it('is on the Dashboard, under the online switch', async () => {
    auth.merchant = merchant({ cashReady: false, acceptedCurrencies: ['INR'] });
    api.getMyTeam.mockResolvedValue(cashMember);
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    const sw = await theSwitch();
    const goOnline = screen.getByRole('button', { name: /Go offline/ });
    // DOCUMENT_POSITION_FOLLOWING: the switch comes after the online toggle.
    expect(goOnline.compareDocumentPosition(sw) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
