// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * Restoring a previous merchant commission policy, and pricing a variety.
 *
 * The version history has been listed on this page since it shipped and there
 * was no way to act on it: the rollback endpoint existed, nothing called it, so
 * undoing a bad policy meant re-typing the old numbers off the list and hoping
 * they were read correctly.
 *
 * Two properties are asserted because both are easy to get wrong and neither
 * shows up in a screenshot: the ACTIVE version is not offered as a target (it
 * would add a version that changes nothing), and the action is confirmed before
 * it fires (the policy decides what merchants are paid).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const { get, put, post } = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock('../../services/api', () => ({ default: { get, put, post } }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
// The policy card — and therefore the history and its rollback buttons — is
// gated behind isAdmin. Without this the page renders the leaderboard only,
// and every assertion below fails for a reason that has nothing to do with
// rollback.
vi.mock('../../hooks/usePermission', () => ({
  usePermissions: () => ({ isAdmin: true, can: () => true, isSubAdmin: false, isQueueManager: false }),
}));

import { MerchantPlatform } from './MerchantPlatform';

const UPI_RATE = { currency: 'INR', paymentMode: 'P2P_UPI', denominationPaise: null, buyPercent: 1, sellPercent: 1 };

const HISTORY = [
  { _id: 'v3', version: 3, enabled: true, rates: [UPI_RATE], minMatchedVolume: 1000, status: 'ACTIVE', createdAt: '2026-03-01T00:00:00Z' },
  { _id: 'v2', version: 2, enabled: true, rates: [UPI_RATE], minMatchedVolume: 500, status: 'SUPERSEDED', createdAt: '2026-02-01T00:00:00Z' },
  { _id: 'v1', version: 1, enabled: false, rates: [], minMatchedVolume: 0, status: 'SUPERSEDED', createdAt: '2026-01-01T00:00:00Z' },
];

const VARIETIES = [
  { currency: 'INR', paymentMode: 'P2P_UPI', denominationPaise: null, label: 'INR · UPI · any amount in range' },
  { currency: 'INR', paymentMode: 'CASH_ATM', denominationPaise: 50000, label: 'INR · Cash/ATM · ₹500' },
];

beforeEach(() => {
  get.mockReset(); put.mockReset(); post.mockReset();
  get.mockImplementation((url: string) => {
    if (url.includes('merchant-commission-policy/history')) return Promise.resolve({ data: { success: true, history: HISTORY } });
    if (url.includes('merchant-commission-policy')) return Promise.resolve({ data: { success: true, policy: HISTORY[0], varieties: VARIETIES } });
    return Promise.resolve({ data: { success: true } });
  });
  post.mockResolvedValue({ data: { success: true } });
});

const openHistory = async () => {
  render(<MerchantPlatform />);
  await waitFor(() => expect(get.mock.calls.some(([u]) => String(u).includes('history'))).toBe(true));
  const summary = await screen.findByText(/Version history/);
  fireEvent.click(summary);
};

describe('merchant commission policy rollback', () => {
  it('offers a restore for superseded versions only', async () => {
    await openHistory();
    // v2 and v1 are superseded; v3 is live and must NOT be restorable.
    const buttons = await screen.findAllByRole('button', { name: /Restore/ });
    expect(buttons).toHaveLength(2);
  });

  it('confirms first, and does not call the API on cancel', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await openHistory();
    fireEvent.click((await screen.findAllByRole('button', { name: /Restore/ }))[0]);
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(post).not.toHaveBeenCalled());
  });

  it('posts the version id once confirmed', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await openHistory();
    fireEvent.click((await screen.findAllByRole('button', { name: /Restore/ }))[0]);
    await waitFor(() => expect(post).toHaveBeenCalled());
    // The FIRST superseded row is v2 — the id, not the version number, is what
    // the route keys on.
    expect(post.mock.calls[0][0]).toBe('/api/admin/merchant-commission-policy/version/v2/rollback');
  });
});

/**
 * The rate editor.
 *
 * A rate is per VARIETY, and the difference between "priced at 0%" and "not
 * priced at all" is a real one the engine acts on — an unpriced variety earns
 * nothing and is REPORTED as unpriced, so an admin can see the work their
 * merchants are actually doing. That distinction is invisible in a screenshot,
 * so it is asserted on the payload the panel sends.
 */
describe('merchant commission rate editor', () => {
  const openEditor = async () => {
    render(<MerchantPlatform />);
    await screen.findByText(/Rates by variety/);
  };

  it('loads the active policy\u2019s rates into the form', async () => {
    await openEditor();
    expect(await screen.findByText('INR \u00b7 UPI \u00b7 any amount in range')).toBeTruthy();
  });

  it('offers only the varieties that are not priced yet', async () => {
    await openEditor();
    // The UPI variety is already priced by the active policy, so only the cash
    // one is offered to add.
    const add = await screen.findByRole('button', { name: /INR \u00b7 Cash\/ATM \u00b7 \u20b9500/ });
    expect(add).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^INR \u00b7 UPI/ })).toBeNull();
  });

  it('sends each priced variety with both legs', async () => {
    put.mockResolvedValue({ data: { success: true, message: 'saved' } });
    await openEditor();

    fireEvent.click(await screen.findByRole('button', { name: /INR \u00b7 Cash\/ATM \u00b7 \u20b9500/ }));
    fireEvent.change(screen.getByPlaceholderText('Why this change?'), { target: { value: 'cash is harder to serve' } });
    fireEvent.click(screen.getByRole('button', { name: /Save New Policy Version/ }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    const body = put.mock.calls[0][1] as any;
    expect(body.rates).toHaveLength(2);
    expect(body.rates).toContainEqual(
      { currency: 'INR', paymentMode: 'CASH_ATM', denominationPaise: 50000, buyPercent: 0, sellPercent: 0 },
    );
  });

  it('drops a variety from the payload when it is unpriced', async () => {
    put.mockResolvedValue({ data: { success: true, message: 'saved' } });
    await openEditor();

    // Removing is how a variety goes unpriced. A rate of 0% would read as
    // priced and pay nothing, which is the shape the engine refuses.
    fireEvent.click(await screen.findByRole('button', { name: 'Stop pricing INR · UPI · any amount in range' }));
    fireEvent.change(screen.getByPlaceholderText('Why this change?'), { target: { value: 'stop paying UPI work' } });
    fireEvent.click(screen.getByRole('button', { name: /Save New Policy Version/ }));

    await waitFor(() => expect(put).toHaveBeenCalled());
    expect((put.mock.calls[0][1] as any).rates).toHaveLength(0);
  });
});

/**
 * One merchant, opened from the leaderboard (2026-10-01).
 *
 * `funding-stats` and `performance-history` had routes and no screen. Three
 * things are asserted because none shows in a screenshot of the happy path: a
 * USDT merchant's volume is labelled USDT (trap 15's display mouth), one read
 * failing does not blank the others, and the Wallet column shows the balance
 * the row now carries (it rendered 0 BB for every merchant, §32 S9).
 */
describe('a merchant opened from the leaderboard', () => {
  const ROW = { merchantId: 'MRC-1', username: 'ravi', tokenBalance: 12345, completedOrders: 3, totalOrders: 4, completedVolume: 2200, isOnline: true };
  const STATS = {
    currency: 'INR', tokenBalance: 12345,
    depositsCompleted: 2, depositVolume: 1500, withdrawalsCompleted: 1, withdrawalVolume: 700,
    bonusesIssued: 1, bonusTotal: 15, adminTopups: 2, adminTopupTotal: 20000,
    successRate: 0.875, avgResponseMinutes: 4.25,
  };
  const HISTORY_ROWS = [
    { day: '2026-09-30', totalOrders: 0, totalVolume: 0, byType: [] },
    { day: '2026-10-01', totalOrders: 3, totalVolume: 2200, byType: [] },
  ];

  const routes = (over: Record<string, () => Promise<unknown>> = {}) => (url: string) => {
    for (const [frag, fn] of Object.entries(over)) if (url.includes(frag)) return fn();
    if (url.includes('merchant-platform/leaderboard')) return Promise.resolve({ data: { success: true, leaderboard: [ROW] } });
    if (url.includes('funding-stats')) return Promise.resolve({ data: { success: true, stats: STATS } });
    if (url.includes('performance-history')) return Promise.resolve({ data: { success: true, days: 30, history: HISTORY_ROWS } });
    if (url.includes('wallet-ledger')) return Promise.resolve({ data: { success: true, entries: [{ _id: 'e1', type: 'CREDIT', amount: 500, balanceAfter: 12345, reason: 'top-up', createdAt: '2026-10-01T09:00:00Z' }] } });
    if (url.includes('merchant-commission-policy/history')) return Promise.resolve({ data: { success: true, history: [] } });
    if (url.includes('merchant-commission-policy')) return Promise.resolve({ data: { success: true, policy: null, varieties: [] } });
    return Promise.resolve({ data: { success: true } });
  };

  const open = async () => {
    render(<MerchantPlatform />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open ravi' }));
    return screen.findByLabelText('Merchant ravi');
  };

  it("shows the Wallet column's real balance on the leaderboard", async () => {
    get.mockImplementation(routes());
    render(<MerchantPlatform />);
    expect(await screen.findByText('12,345 BB')).toBeInTheDocument();
  });

  it('asks for the figures, the history for the selected period, and the ledger', async () => {
    get.mockImplementation(routes());
    const panel = await open();
    await waitFor(() => {
      expect(get).toHaveBeenCalledWith('/api/admin/merchant-platform/MRC-1/funding-stats');
      expect(get).toHaveBeenCalledWith('/api/admin/merchant-platform/MRC-1/performance-history', { params: { days: 30 } });
    });
    const funding = await within(panel).findByLabelText('Funding');
    expect(funding).toHaveTextContent('2 · ₹1,500');
    expect(funding).toHaveTextContent('1 · ₹700');
    expect(funding).toHaveTextContent('2 · 20,000 BB');
    expect(funding).toHaveTextContent('88%');
    const days = within(panel).getByLabelText('Daily completed orders');
    expect(days).toHaveTextContent('2026-10-01');
    expect(days).toHaveTextContent('3 orders');
    // A day with nothing completed is not listed as a row of zeroes.
    expect(days).not.toHaveTextContent('2026-09-30');
  });

  it('labels a USDT merchant’s volume in USDT, never in rupees', async () => {
    get.mockImplementation(routes({
      'funding-stats': () => Promise.resolve({ data: { success: true, stats: { ...STATS, currency: 'USDT', depositVolume: 555.56 } } }),
    }));
    const panel = await open();
    const funding = await within(panel).findByLabelText('Funding');
    await waitFor(() => expect(funding).toHaveTextContent('555.56 USDT'));
    expect(funding).not.toHaveTextContent('₹555.56');
  });

  it('says the figures failed to load, and still shows the history and the ledger', async () => {
    get.mockImplementation(routes({ 'funding-stats': () => Promise.reject(new Error('down')) }));
    const panel = await open();
    expect(await within(panel).findByRole('alert')).toHaveTextContent("Could not load this merchant's figures.");
    expect(await within(panel).findByText('3 orders')).toBeInTheDocument();
    expect(within(panel).getByText('top-up')).toBeInTheDocument();
  });
});
