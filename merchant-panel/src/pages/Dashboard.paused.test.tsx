// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant whose new buy orders the platform paused is TOLD so.
 *
 * Three unpaid buys in a row pause a merchant's assignment (§2) — they keep
 * their balance and orders, and simply stop being sent players. Opening the
 * panel AS such a merchant (browser profile `merchant-paused`) showed
 * "Online · Accepting orders" and nothing else, while no order could reach
 * them. The profile never carried the pause, and the Dashboard had nowhere to
 * say it.
 */
import { describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const auth = vi.hoisted(() => ({ merchant: null as Record<string, unknown> | null }));
vi.mock('../services/AuthContext', () => ({
  useAuth: () => ({ merchant: auth.merchant, refreshProfile: vi.fn() }),
}));
const stats = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const ledger = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));
vi.mock('../services/api', () => ({
  api: {
    getStats: vi.fn(async () => stats.value),
    getEarnings: vi.fn().mockResolvedValue({ earnings: null }),
    getWeeklyEarnings: vi.fn().mockResolvedValue({ weekly: [] }),
    getBusinessLedger: vi.fn(async () => { if (!ledger.value) throw new Error('no ledger'); return ledger.value; }),
    toggleOnlineStatus: vi.fn(),
  },
}));
vi.mock('../hooks/useOrders', () => ({
  useOrders: () => ({ orders: [], state: 'ready', counts: {} }),
  needsAction: () => false,
}));
// The Ready card has its own suite (components/CashReadyCard.test.tsx); here it
// is a stand-in so this file asserts only what the Dashboard itself says.
vi.mock('../components/CashReadyCard', () => ({ CashReadyCard: () => null }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import Dashboard from './Dashboard';

const show = (merchant: Record<string, unknown>) => {
  auth.merchant = { id: 'm-1', merchantId: 'm-1', isOnline: true, ...merchant };
  return render(<MemoryRouter><Dashboard /></MemoryRouter>);
};

describe('the Dashboard and a paused assignment', () => {
  it('says new buy orders are paused, what it means, and what to do', async () => {
    show({ assignmentPausedAt: '2026-10-01T08:00:00Z' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/New buy orders are paused/i);
    expect(alert).toHaveTextContent(/not a suspension/i);
    expect(alert).toHaveTextContent(/contact support/i);
    // What a member can actually check since 2d: their bank details and their
    // own promptness. A member has no UPI ID or QR a buyer pays any more.
    expect(alert).toHaveTextContent(/bank details on your Profile/i);
    expect(alert).not.toHaveTextContent(/UPI ID/i);
    expect(screen.getByText(/Online · New orders paused/)).toBeInTheDocument();
    expect(screen.queryByText(/Online · Accepting orders/)).not.toBeInTheDocument();
  });

  it('says nothing of the kind to a merchant who is not paused (the opposite case)', async () => {
    show({ assignmentPausedAt: null });
    expect(await screen.findByText(/Online · Accepting orders/)).toBeInTheDocument();
    expect(screen.queryByText(/New buy orders are paused/i)).not.toBeInTheDocument();
  });});

/**
 * A merchant holds no tokens — the team's pool does (PROJECT_STATUS §3.10) —
 * and the profile carries no balance. The Dashboard had a "BB Token balance"
 * tile and a "Largest buy you can serve" tile, both reading `tokenBalance`;
 * with the field gone they would have rendered "0 BB" as if it were a fact.
 */
describe('the Dashboard shows no merchant balance', () => {
  it('has no balance tile, even if a stale cached profile still carries one', async () => {
    show({ tokenBalance: 1000 });
    expect(await screen.findByText(/Online · Accepting orders/)).toBeInTheDocument();
    expect(screen.queryByText(/BB Token balance/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Largest buy you can serve/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/1,000 BB/)).not.toBeInTheDocument();
  });
});

/**
 * The big pool card (owner, 2026-10-22): the pool's tokens out of its size,
 * a bar that can pass 100%, and four small cards, every figure the server's
 * (GET /merchant/stats `money`, GET /merchant/earnings).
 */
describe('the Dashboard\'s pool card', () => {
  const none = { heldOpenPaise: 0, heldDisputedPaise: 0, openBuys: 0, sellsSettlingPaise: 0, sellsDisputedPaise: 0, openSells: 0 };
  const standing = {
    sizePaise: 20_000_000, leftPaise: 9_000_000, heldPaise: 700_000, consumedPaise: 10_300_000,
    sellsOwedPaise: 300_000, sellRoomPaise: 10_000_000, leftPercent: 45,
  };
  it('shows the tokens out of the pool size, the bar, and where the rest is', async () => {
    stats.value = { money: {
      own: none,
      pool: { availablePaise: 9000000, heldPaise: 700000, standing,
        exposure: { ...none, heldOpenPaise: 500000, heldDisputedPaise: 200000, sellsDisputedPaise: 100000, openBuys: 2, sellsSettlingPaise: 40000, openSells: 1 } },
    } };
    show({});
    expect(await screen.findByText('/ 2,00,000 BB')).toBeInTheDocument();
    expect(screen.getByText('90,000 BB', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Pool balance against pool size' })).toHaveAttribute('aria-valuenow', '45');
    expect(screen.getByText(/You can receive up to 1,00,000 BB in sell orders/)).toBeInTheDocument();
    expect(screen.getByText('Locked in open buys')).toBeInTheDocument();
    expect(screen.getByText('5,000 BB')).toBeInTheDocument();
    // Buy and sell disputes are one card.
    expect(screen.getByText('Locked in disputes')).toBeInTheDocument();
    expect(screen.getByText('3,000 BB')).toBeInTheDocument();
    expect(screen.getByText('Incoming from sells')).toBeInTheDocument();
    expect(screen.getByText("Today's earnings")).toBeInTheDocument();
    // The old cards are gone (owner, 2026-10-22).
    for (const gone of [/Needs action/, /Success rate/, /Weekly earnings/, /Your record/, /Expiring soon/]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
    stats.value = {};
  });

  it('above 100% of the size, says buy orders come first', async () => {
    stats.value = { money: { own: none, pool: { availablePaise: 30_000_000, heldPaise: 0, exposure: none,
      standing: { ...standing, leftPaise: 30_000_000, consumedPaise: 0, sellRoomPaise: 0, leftPercent: 150 } } } };
    show({});
    expect(await screen.findByText('150% of your pool size')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Pool balance against pool size' })).toHaveAttribute('aria-valuenow', '150');
    expect(screen.getByText(/buy orders come to you first/)).toBeInTheDocument();
    stats.value = {};
  });

  it('offers the USDT token buy to a merchant account\'s owner, and not to an agent', async () => {
    stats.value = { money: { own: none, pool: null } };
    show({ isMerchantAccount: true });
    expect(await screen.findByRole('button', { name: /Buy tokens from admin \(USDT\)/ })).toBeInTheDocument();
    cleanup();
    show({});
    expect(await screen.findByText(/You have no pool yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Buy tokens from admin/ })).not.toBeInTheDocument();
    stats.value = {};
  });
});
