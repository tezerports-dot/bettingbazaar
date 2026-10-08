// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A floor may never rise above its own ceiling.
 *
 * ── What this is protecting ─────────────────────────────────────────────────
 * `SYSTEM_CONFIG_SPEC` declared `minDeposit: n(500, 0)` — a floor of 0 and NO
 * ceiling — and the same for `minWithdrawal` and every bet limit (the deposit
 * and withdrawal pairs became the size list in Step 2d; the USDT buy bounds
 * are the pair here now). Measured
 * against the live admin route before this guard existed:
 *
 *     PUT minDeposit = -5           ->  400  "must be >= 0, got -5"
 *     PUT minDeposit = 999999999    ->  200  "System config updated"
 *
 * So one extra digit in the Min Deposit box sets the platform's minimum
 * deposit to ₹999,999,999 and NO PLAYER CAN DEPOSIT AGAIN. The save succeeds,
 * the screen says "System config updated", and nothing objects. The same typo
 * in Min Withdrawal strands every balance on the platform.
 *
 * Found by the form pass (`npm run test:forms`), which noticed those fields
 * carry no `min`/`max` on the client either — so nothing between the keyboard
 * and the database was going to stop it.
 *
 * ── Why not simply give each field a `max` ─────────────────────────────────
 * Any per-field ceiling would be a number nobody chose. The real invariant
 * needs BOTH values, and a patch may set only one of them — so it is checked
 * against the MERGED document inside the same transaction that writes it.
 * `usdtBuy.maxUsdt: 100` on its own is refused against a stored
 * `usdtBuy.minUsdt` of 500, which a patch-only check could never see.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { pgConfigured, applySchema, closePg } from '../client.js';
import { applyConfig, getConfig } from '../repositories/config.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('paired config bounds (PostgreSQL)', () => {
  // `config_documents` is ONE row per scope and holds the platform's live
  // rules, so this suite puts back exactly what it found (trap 10).
  let baseline;
  beforeAll(async () => {
    await applySchema();
    baseline = await getConfig('system', { fresh: true });
  });
  afterAll(async () => {
    await applyConfig({
      scope: 'system', actor: 'test-restore',
      patch: {
        usdtBuy: baseline.usdtBuy,
      },
    }).catch(() => {});
    await closePg();
  });
  beforeEach(async () => {
    await applyConfig({
      scope: 'system', actor: 'test-setup',
      patch: { usdtBuy: { minUsdt: 100, maxUsdt: 10000 } },
    });
  });

  const put = (patch) => applyConfig({ scope: 'system', patch, actor: 'test' });

  it('refuses a USDT buy minimum above the maximum — the typo that closes the rail', async () => {
    // The deposit and withdrawal pairs became the size list (Step 2d); the
    // USDT buy bounds are the pair a typo can still invert.
    await expect(put({ usdtBuy: { minUsdt: 99900 } })).rejects.toMatchObject({ status: 400 });
    // Nothing was written.
    expect((await getConfig('system', { fresh: true })).usdtBuy.minUsdt).toBe(100);
  });

  it('names BOTH fields and BOTH values, so the operator knows what to type', async () => {
    await expect(put({ usdtBuy: { minUsdt: 99900 } }))
      .rejects.toThrow(/'usdtBuy\.minUsdt' \(99900\) cannot be above 'usdtBuy\.maxUsdt' \(10000\)/);
  });

  /**
   * The case a patch-only check cannot see, and the reason this runs on the
   * merged document: nothing in this patch is out of range BY ITSELF.
   */
  it('refuses lowering the MAXIMUM under a minimum that is already stored', async () => {
    await put({ usdtBuy: { minUsdt: 500 } });
    await expect(put({ usdtBuy: { maxUsdt: 400 } })).rejects.toThrow(/'usdtBuy\.minUsdt' \(500\) cannot be above 'usdtBuy\.maxUsdt' \(400\)/);
  });

  it('accepts the pair moved together in one save', async () => {
    const r = await put({ usdtBuy: { minUsdt: 20000, maxUsdt: 50000 } });
    expect(r.ok).toBe(true);
    const c = await getConfig('system', { fresh: true });
    expect(c.usdtBuy).toEqual({ minUsdt: 20000, maxUsdt: 50000 });
  });

  it('still accepts an ordinary change, and refuses one off the 100 USDT step or below it', async () => {
    expect((await put({ usdtBuy: { minUsdt: 600 } })).ok).toBe(true);
    await expect(put({ usdtBuy: { minUsdt: 650 } })).rejects.toThrow(/must be a multiple of 100/);
    await expect(put({ usdtBuy: { minUsdt: 0 } })).rejects.toThrow(/must be >= 100/);
    await expect(put({ usdtBuy: { maxUsdt: 100100 } })).rejects.toThrow(/must be <= 100000/);
  });
});
