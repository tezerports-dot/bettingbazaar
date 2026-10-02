// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * System Settings after the team-routing change (PROJECT_STATUS §3.10, 2c).
 *
 * Three things, each invisible in a screenshot:
 *
 *   1. The per-rail numbers routing reads (`SystemConfig.teamRouting`) are on
 *      the screen and go back in the PUT — they replaced the Settlement Rail
 *      screen's timers, which no longer exist.
 *   2. The settings the spec no longer declares (per-merchant concurrency, the
 *      merchant↔admin token purchase limits) are neither shown nor SENT. The PUT
 *      skips an undeclared key silently, so a panel still sending one would
 *      look like it saved.
 *   3. `disputeWindowSeconds` is declared with no consumer, so it is not
 *      offered (§3) — and it round-trips exactly as served rather than being
 *      dropped or reset.
 *
 * The mock returns what `api.system.getConfig` returns — `{ success, data }`
 * — so the served values are actually applied.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { getConfig, updateConfig, toggleMaintenance } = vi.hoisted(() => ({
  getConfig: vi.fn(), updateConfig: vi.fn(), toggleMaintenance: vi.fn(),
}));
vi.mock('../../services/api', () => ({
  default: { system: { getConfig, updateConfig, toggleMaintenance }, get: vi.fn(), put: vi.fn(), post: vi.fn() },
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../components/TwoFactorSetup', () => ({ default: () => null }));
vi.mock('../../components/ConfirmDialog', () => ({ ConfirmDialog: () => null }));

const { SystemSettings } = await import('./SystemSettings');

// The shape the GET serves for these two groups (config.spec.js), with values
// that differ from every default so a test can tell served from fallback.
const served = {
  minDeposit: 500, maxDeposit: 50000, minWithdrawal: 500, maxWithdrawal: 50000,
  merchantOrderLimits: {
    maxConsecutiveRejections: 4, paidResponseMinutes: 31, utrAfterPaidMinutes: 16,
    maxConsecutivePlayerPaymentFailures: 4, playerOrderLockMinutes: 61,
    maxConsecutiveMerchantExpiries: 4, minUserTokenPurchaseUsdt: 100, maxUserTokenPurchaseUsdt: 0,
  },
  teamRouting: {
    concurrency: { CASH: 2, UPI_BANK: 5, USDT: 4 },
    assignmentWaitSeconds: 1200,
    processingWindowSeconds: { CASH: 600, UPI_BANK: 1200, USDT: 1800 },
    utrSubmitSeconds: 90,
    disputeWindowSeconds: 2400,
  },
};

const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const saveButton = () => screen.getAllByRole('button', { name: /save/i }).pop() as HTMLButtonElement;

const paint = async () => {
  getConfig.mockResolvedValue({ success: true, data: served });
  render(<SystemSettings />);
  await screen.findByText('Team Routing');
  await waitFor(() => expect(field('tr-conc-UPI_BANK').value).toBe('5'));
};

describe('System Settings — team routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the served per-rail caps and windows', async () => {
    await paint();
    expect(field('tr-conc-CASH').value).toBe('2');
    expect(field('tr-conc-USDT').value).toBe('4');
    expect(field('tr-proc-CASH').value).toBe('600');
    expect(field('tr-proc-USDT').value).toBe('1800');
    expect(field('tr-assignmentWaitSeconds').value).toBe('1200');
    expect(field('tr-utrSubmitSeconds').value).toBe('90');
    expect(field('mol-utrAfterPaidMinutes').value).toBe('16');
  });

  it('offers none of the removed settings and no dispute window', async () => {
    await paint();
    expect(screen.queryByText(/Concurrent (Buy|Sell) Orders per Merchant/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Merchant Admin Token/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Minimum Token Top-up/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Settlement Rail/)).not.toBeInTheDocument();
    expect(screen.queryByText(/dispute window/i)).not.toBeInTheDocument();
  });

  it('sends teamRouting back, the dispute window as served, and no undeclared key', async () => {
    await paint();
    updateConfig.mockResolvedValue({ success: true });
    fireEvent.change(field('tr-conc-UPI_BANK'), { target: { value: '7' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    const body = updateConfig.mock.calls[0][0];
    expect(body.teamRouting).toEqual({ ...served.teamRouting, concurrency: { CASH: 2, UPI_BANK: 7, USDT: 4 } });
    for (const gone of ['maxConcurrentDepositOrders', 'maxConcurrentWithdrawalOrders', 'minAdminTokenPurchase',
      'minAdminTokenPurchaseUsdt', 'maxAdminTokenPurchaseUsdt']) {
      expect(Object.keys(body.merchantOrderLimits), gone).not.toContain(gone);
    }
  });

  it('refuses an out-of-range cap before the round trip, and names the bound', async () => {
    await paint();
    fireEvent.change(field('tr-conc-CASH'), { target: { value: '11' } });
    expect(await screen.findByText('Must be 1–10.')).toBeInTheDocument();
    expect(saveButton().disabled).toBe(true);
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
