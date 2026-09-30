// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * A floor may never be saved above its own ceiling.
 *
 * ── What this is protecting ─────────────────────────────────────────────────
 * `SYSTEM_CONFIG_SPEC` declared `minDeposit: n(500, 0)` — a floor of 0 and NO
 * ceiling. Measured against the live admin route before the server guard:
 *
 *     PUT minDeposit = -5           ->  400  "must be >= 0, got -5"
 *     PUT minDeposit = 999999999    ->  200  "System config updated"
 *
 * One extra digit in this box set the platform's minimum deposit to
 * ₹999,999,999 and no player could deposit again. The server refuses that now;
 * this file is the other half — the screen refusing it before it is sent, and
 * saying why.
 *
 * Three things are asserted, and the third is the one that was missing for
 * longest:
 *
 *   1. Each input carries the PAIRED FIELD'S value as its bound. Not a number
 *      invented for the panel — one owner (§2), so the client refuses exactly
 *      what the server refuses.
 *   2. Typing a floor above its ceiling shows a warning naming both values AND
 *      the consequence, and disables Save. An input's `min`/`max` stop the
 *      arrows; a typed or pasted value still lands.
 *   3. **Max Deposit and Max Withdrawal are on the screen at all.** They are
 *      declared settings the GET has always served, and this screen rendered
 *      no input for either — so a floor could be raised with no way to raise
 *      the roof above it.
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
// The screen links to the 2FA page and mounts the enrolment widget; neither is
// what this file is about, and a router is not needed to assert an input's
// bounds.
vi.mock('react-router', () => ({ Link: ({ children }: any) => <>{children}</> }));
vi.mock('../../components/TwoFactorSetup', () => ({ default: () => null }));
vi.mock('../../components/ConfirmDialog', () => ({ ConfirmDialog: () => null }));

const { SystemSettings } = await import('./SystemSettings');

/** What the live GET returns, keys and values as measured. */
const served = {
  minDeposit: 500, maxDeposit: 50000,
  minWithdrawal: 500, maxWithdrawal: 50000,
  minBet: 10, maxBet: 100000,
  betLimits: { oneMin: { min: 10, max: 100000 }, thirtyMin: { min: 10, max: 100000 }, fullDay: { min: 100, max: 500000 } },
};

const paint = async () => {
  getConfig.mockResolvedValue({ data: { success: true, ...served } });
  render(<SystemSettings />);
  await waitFor(() => expect(getConfig).toHaveBeenCalled());
  await screen.findByLabelText(/Min Deposit Amount/i);
};

const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const saveButton = () => screen.getAllByRole('button', { name: /save/i }).pop() as HTMLButtonElement;

describe('the transaction limits cannot be saved inverted', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers the MAXIMUM of each pair, which this screen never did', async () => {
    await paint();
    expect(field(/Max Deposit Amount/i).value).toBe('50000');
    expect(field(/Max Withdrawal Amount/i).value).toBe('50000');
  });

  it('bounds each input by its PAIRED field, not by an invented number', async () => {
    await paint();
    expect(field(/Min Deposit Amount/i).max).toBe('50000');   // = maxDeposit
    expect(field(/Min Deposit Amount/i).min).toBe('0');
    expect(field(/Max Deposit Amount/i).min).toBe('500');     // = minDeposit
    expect(field(/Min Withdrawal Amount/i).max).toBe('50000');
  });

  it('refuses the one-extra-digit typo, names both values, and says what it would do', async () => {
    await paint();
    fireEvent.change(field(/Min Deposit Amount/i), { target: { value: '999999999' } });
    await waitFor(() => expect(
      screen.getByText(/Minimum deposit \(999999999\) is above the maximum \(50000\)/i),
    ).toBeTruthy());
    expect(screen.getByText(/refuse every deposit on the platform/i)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('refuses an inverted WITHDRAWAL pair — every balance stranded', async () => {
    await paint();
    fireEvent.change(field(/Min Withdrawal Amount/i), { target: { value: '60000' } });
    await waitFor(() => expect(screen.getByText(/strand every balance on the platform/i)).toBeTruthy());
    expect(saveButton().disabled).toBe(true);
  });

  it('lets the pair move together, and saves', async () => {
    await paint();
    updateConfig.mockResolvedValue({ data: { success: true } });
    fireEvent.change(field(/Max Deposit Amount/i), { target: { value: '900000' } });
    fireEvent.change(field(/Min Deposit Amount/i), { target: { value: '800000' } });
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());
    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    expect(updateConfig.mock.calls[0][0]).toMatchObject({ minDeposit: 800000, maxDeposit: 900000 });
  });

  /**
   * §4: a `??` fallback must equal the schema default. `minWithdrawal` fell
   * back to 100 — the drifted value §2 records as already removed ("both 500
   * tokens, the same rule read from either end") — and `maxBet` to 50000
   * against a schema default of 100000. Both were `||`, so a legitimate 0
   * became the fallback too.
   */
  it('falls back to the schema default when the server sends nothing', async () => {
    getConfig.mockResolvedValue({ data: { success: true } });
    render(<SystemSettings />);
    await waitFor(() => expect(getConfig).toHaveBeenCalled());
    expect((await screen.findByLabelText(/Min Withdrawal Amount/i) as HTMLInputElement).value).toBe('500');
    expect(field(/Max Deposit Amount/i).value).toBe('50000');
  });
});
