// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The system-config payload has exactly one owner, and it reads a legitimate 0.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * This object was assembled twice — Socket.IO on connect, HTTP on request — and
 * the copies had already drifted in both directions: only the socket carried
 * webUrl/androidUrl/iosUrl, only the HTTP route carried kycRequired (removed with KYC, 2026-10-02) and
 * registrationEnabled. What a client believed about the platform depended on
 * which transport it asked over.
 *
 * The HTTP copy also wrote `config?.minDeposit || 100` for every numeric limit.
 * `||` cannot tell 0 from absent, so an operator who set a limit to zero was
 * served the default and the panel enforced a floor they had explicitly
 * removed. That is trap 1 and mutation M23 in a third place, which is why the
 * zero case is asserted here rather than assumed.
 *
 * These are absence-and-shape checks. A happy-path test passes perfectly well
 * against two builders that agree today and diverge next week.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { systemConfigPayload, systemConfigFallback } from '../../domains/configuration/systemConfigPayload.js';
import { CASH_SIZES, UPI_BANK_SIZES } from '../../domains/merchant/denominations.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => readFileSync(join(repo, p), 'utf8');

describe('the system-config payload', () => {
  it('gives every consumer the same field set', () => {
    // Both transports render the same object, so a field added for one reaches
    // the other. The two used to differ by five fields.
    const keys = Object.keys(systemConfigPayload(null)).sort();
    for (const gone of ['webUrl', 'iosUrl', 'registrationEnabled']) {
      expect(keys, `${gone} must be in the one payload, not one transport's copy`).toContain(gone);
    }
    expect(Object.keys(systemConfigFallback()).sort()).toEqual(keys);
  });

  it('reads a limit an operator deliberately set to 0', () => {
    // The whole point of the `??`/`||` distinction. With `||` every one of
    // these silently became the default.
    const zeroed = systemConfigPayload({
      payoutMultiplier: 0,
    });
    for (const k of ['payoutMultiplier']) {
      expect(zeroed[k], `${k}: a configured 0 must survive, not fall back`).toBe(0);
    }
  });

  it('still fills an ABSENT value with its declared default', () => {
    // The other half: `??` must not turn into "pass everything through".
    const empty = systemConfigPayload(null);
    expect(empty.orderSizes).toEqual({ CASH: [...CASH_SIZES], UPI_BANK: [...UPI_BANK_SIZES] });
    expect(empty.usdtBuy).toEqual({ minUsdt: 100, maxUsdt: 10_000, stepUsdt: 100 });
    expect(empty.payoutMultiplier).toBe(2);
  });

  it('treats false and empty string as configured, not missing', () => {
    expect(systemConfigPayload({ maintenanceMode: false }).maintenanceMode).toBe(false);
    expect(systemConfigPayload({ maintenanceMessage: '' }).maintenanceMessage).toBe('');
    expect(systemConfigPayload({ registrationEnabled: false }).registrationEnabled).toBe(false);
  });

  it('keeps the conversion at exactly 1:1', () => {
    // Moved here from paymentRoutes.test.js when GET /api/payment/rates was
    // deleted: that route declared the rate as a literal, so it was a third
    // copy AND the one an operator's edit would never reach. The invariant is
    // what mattered — tokens and rupees are the same unit, and a rate that
    // drifted from 1 would silently stop that being true.
    //
    // Asserted for a populated row too, not just an empty one: these are
    // constants in the builder, so a future `cfg?.tokenBuyRate ?? 1` that made
    // them configurable would have to come here and say so deliberately.
    for (const cfg of [null, { tokenBuyRate: 3, tokenSellRate: 7, payoutMultiplier: 5 }]) {
      const p = systemConfigPayload(cfg);
      expect(p.tokenBuyRate, 'buy rate must be exactly 1').toBe(1);
      expect(p.tokenSellRate, 'sell rate must be exactly 1').toBe(1);
    }
  });

  it('never hands back an empty footer', () => {
    // An admin cannot intend a panel with no navigation, so [] means unset.
    expect(systemConfigPayload({ footerPages: [] }).footerPages).toHaveLength(5);
    expect(systemConfigPayload({ footerPages: ['home', 'profile'] }).footerPages).toEqual(['home', 'profile']);
  });

  it('does not hand out the array the caller owns', () => {
    // The default list is frozen and shared; returning it directly would let one
    // request's mutation reach every later one.
    const a = systemConfigPayload(null).footerPages;
    a.push('injected');
    expect(systemConfigPayload(null).footerPages).toHaveLength(5);
  });

  it('is assembled in one place — neither consumer builds its own', () => {
    // The regression that matters: someone reintroducing a literal beside the
    // builder is how these drifted the first time.
    for (const f of ['backend/startup/socketHandlers.js', 'backend/domains/user/user.routes.js']) {
      const src = read(f);
      expect(src, `${f} must call the builder`).toMatch(/systemConfigPayload\(/);
      // No second declaration of a default that the builder already owns.
      expect(src, `${f} must not re-declare payoutMultiplier's default`)
        .not.toMatch(/payoutMultiplier:\s*\w+\?\?/);
      expect(src, `${f} must not re-declare minDeposit's default`)
        .not.toMatch(/minDeposit:\s*\w/);
    }
  });
});

describe('the settlement rail, and the amounts it allows', () => {
  /**
   * ── Why the client is told these at all ──────────────────────────────────
   * The player app ships as an APK containing the whole bundle, so a picker
   * built from a list written in the client is a list an attacker can edit —
   * and, worse for honest players, a list that DRIFTS from the server's is a
   * player offered an amount the gate will refuse. They pick it, wait, and are
   * rejected for a reason the screen never showed them.
   *
   * So the amounts come from `denominations.js` — the same module
   * `assessFundingOrder` validates against — and are asserted here to BE that
   * module's list rather than a copy that happens to match today.
   */
  it('tells the client exactly the sizes the risk gate accepts, per rail', () => {
    // Only the sizes the admin has on offer, split by the rail each one runs on
    // (Step 2d). The same list serves buys and sells.
    const payload = systemConfigPayload({ orderSizes: [1_000, 10_000, 100_000] });
    expect(payload.orderSizes).toEqual({ CASH: [1_000, 10_000], UPI_BANK: [100_000] });
  });

  it('ignores a stored size that is not one of the seven', () => {
    // A row edited around the spec (a direct UPDATE, an old backup) is not a
    // size a team is organised to serve, so it is not offered.
    expect(systemConfigPayload({ orderSizes: [500, 7_777, 40_000] }).orderSizes)
      .toEqual({ CASH: [500], UPI_BANK: [] });
  });

  it('tells the client the USDT bounds in USDT, and the rate to price them', () => {
    // A USDT buy is chosen in what the player SENDS; the tokens follow from the
    // rate. A panel given one without the other cannot show what they receive.
    const payload = systemConfigPayload({
      usdtPricing: { userMerchantBuyInr: 100 }, usdtBuy: { minUsdt: 200, maxUsdt: 5_000 },
    });
    expect(payload.usdtBuy).toEqual({ minUsdt: 200, maxUsdt: 5_000, stepUsdt: 100 });
    expect(payload.usdtTokensPerUnit).toBe(100);
    expect(payload).not.toHaveProperty('usdtBuyDenominations');
  });

  it('says the USDT rate is UNSET rather than guessing one', () => {
    // The schema default is 0 and 0 is not a rate. A panel told `null` shows
    // "not available"; a panel told 1 would offer 50,000 tokens for 50,000
    // USDT and a player might take it.
    expect(systemConfigPayload(null).usdtTokensPerUnit).toBeNull();
    expect(systemConfigPayload({ usdtPricing: { userMerchantBuyInr: 0 } }).usdtTokensPerUnit).toBeNull();
  });

  it('names no platform-wide rail and no min/max limits', () => {
    // There is no rail switch: an order's rail is derived from its own size
    // and currency (`paymentModeFor`, §3.10 2c). And the size list replaced
    // the min/max buy and sell limits (2d): either beside it would be a second
    // answer a panel could believe instead.
    for (const gone of ['paymentMode', 'minDeposit', 'maxDeposit', 'minWithdrawal', 'maxWithdrawal',
                        'buyDenominations', 'maxCashBuy']) {
      expect(systemConfigPayload(null)).not.toHaveProperty(gone);
      expect(systemConfigFallback()).not.toHaveProperty(gone);
    }
  });

  it('still carries the sizes when the config cannot be read', () => {
    // A payload that dropped these would leave the picker empty and the player
    // unable to buy for a reason unrelated to what failed.
    expect(systemConfigFallback().orderSizes.CASH.length).toBeGreaterThan(0);
    expect(systemConfigFallback().orderSizes.UPI_BANK.length).toBeGreaterThan(0);
  });
});
