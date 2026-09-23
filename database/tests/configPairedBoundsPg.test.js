// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A floor may never rise above its own ceiling.
 *
 * ── What this is protecting ─────────────────────────────────────────────────
 * `SYSTEM_CONFIG_SPEC` declares `minDeposit: n(500, 0)` — a floor of 0 and NO
 * ceiling — and the same for `minWithdrawal` and every bet limit. Measured
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
 * `maxDeposit: 1` on its own is refused against the stored `minDeposit`, which
 * a patch-only check could never see.
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
        minDeposit: baseline.minDeposit, maxDeposit: baseline.maxDeposit,
        minWithdrawal: baseline.minWithdrawal, maxWithdrawal: baseline.maxWithdrawal,
        betLimits: baseline.betLimits,
      },
    }).catch(() => {});
    await closePg();
  });
  beforeEach(async () => {
    await applyConfig({
      scope: 'system', actor: 'test-setup',
      patch: { minDeposit: 500, maxDeposit: 50000, minWithdrawal: 500, maxWithdrawal: 50000 },
    });
  });

  const put = (patch) => applyConfig({ scope: 'system', patch, actor: 'test' });

  it('refuses a minimum deposit above the maximum — the typo that closes the rail', async () => {
    await expect(put({ minDeposit: 999999999 })).rejects.toMatchObject({ status: 400 });
    // And it did not write: the whole transaction unwinds.
    expect((await getConfig('system', { fresh: true })).minDeposit).toBe(500);
  });

  it('names BOTH fields and BOTH values, so the operator knows what to type', async () => {
    await expect(put({ minDeposit: 999999999 }))
      .rejects.toThrow(/'minDeposit' \(999999999\) cannot be above 'maxDeposit' \(50000\)/);
  });

  it('refuses a minimum WITHDRAWAL above its maximum — every balance stranded', async () => {
    await expect(put({ minWithdrawal: 60000 })).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a bet minimum above its maximum, per board', async () => {
    await expect(put({ betLimits: { oneMin: { min: 200000 } } })).rejects.toMatchObject({ status: 400 });
    await expect(put({ betLimits: { fullDay: { min: 999999 } } })).rejects.toMatchObject({ status: 400 });
  });

  /**
   * The case a patch-only check cannot see, and the reason this runs on the
   * merged document: nothing in this patch is out of range BY ITSELF.
   */
  it('refuses lowering the MAXIMUM under a minimum that is already stored', async () => {
    await expect(put({ maxDeposit: 1 })).rejects.toThrow(/'minDeposit' \(500\) cannot be above 'maxDeposit' \(1\)/);
  });

  it('accepts the pair moved together in one save', async () => {
    const r = await put({ minDeposit: 1000, maxDeposit: 90000 });
    expect(r.ok).toBe(true);
    const c = await getConfig('system', { fresh: true });
    expect(c.minDeposit).toBe(1000);
    expect(c.maxDeposit).toBe(90000);
  });

  it('still accepts an ordinary change, and still refuses a negative', async () => {
    expect((await put({ minDeposit: 600 })).ok).toBe(true);
    await expect(put({ minDeposit: -5 })).rejects.toThrow(/must be >= 0/);
  });
});
