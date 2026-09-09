// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * What a token is worth: pegged against INR, floating against USDT.
 *
 * ── The two rules, and how each was broken ──────────────────────────────────
 * AGAINST INR the token is 1:1 and NOT configurable. That was true, but stated
 * as a bare literal `1` in five places with nothing naming it — so nothing
 * stopped a sixth place from disagreeing, and nothing said why it could not
 * move.
 *
 * AGAINST USDT the rate floats and the admin sets it, separately per leg. One
 * leg worked. The other, `userMerchantBuyInr` — what a player pays a USDT
 * merchant — was editable in the admin panel, stored, echoed back, and READ BY
 * NOTHING. A player buying from a USDT merchant was priced at the INR peg
 * whatever the admin had configured.
 *
 * ── The trap this file exists to hold shut ──────────────────────────────────
 * That rate's schema default is 0, and 0 is not a rate. Dividing by it gives
 * Infinity; substituting 1 for it sells tokens at the INR peg to a merchant who
 * settles in USDT — the platform eats the spread on every order, silently. So
 * an unset rate returns null and the caller must refuse, and the cases below
 * are mostly about that.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === '.git') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.m?js$/.test(p)) out.push(p);
  }
  return out;
}
import {
  INR_TOKEN_RATE,
  adminToMerchantUsdtRate,
  merchantToUserUsdtRate,
  rateForMerchant,
  tokensPerUsdt,
  usdtForTokens,
  isSaneUsdtRate,
  USDT_RATE_MIN_INR,
  USDT_RATE_MAX_INR,
} from '../../domains/configuration/tokenRates.js';

const inrMerchant  = { acceptedCurrencies: ['INR'] };
const usdtMerchant = { acceptedCurrencies: ['USDT'] };

describe('the INR peg', () => {
  it('is one', () => {
    expect(INR_TOKEN_RATE).toBe(1);
  });

  it('is what an INR merchant settles at, whatever the USDT config says', () => {
    // The peg does not move because somebody edited a USDT rate.
    const config = { usdtPricing: { userMerchantBuyInr: 88, merchantAdminBuyInr: 90 } };
    expect(rateForMerchant(inrMerchant, config)).toBe(1);
  });

  it('applies to a merchant with no rail recorded', () => {
    // `merchantTypeOf` falls back to INR, and the peg must follow it — an
    // unknown rail must not be priced as USDT.
    expect(rateForMerchant({}, {})).toBe(1);
    expect(rateForMerchant(null, {})).toBe(1);
  });
});

describe('the USDT legs are separate', () => {
  it('reads each leg from its own field', () => {
    const config = { usdtPricing: { merchantAdminBuyInr: 90, userMerchantBuyInr: 95 } };
    expect(adminToMerchantUsdtRate(config)).toBe(90);
    expect(merchantToUserUsdtRate(config)).toBe(95);
  });

  it('keeps the spread — one rate for both would erase the merchant margin', () => {
    const config = { usdtPricing: { merchantAdminBuyInr: 90, userMerchantBuyInr: 95 } };
    expect(adminToMerchantUsdtRate(config)).not.toBe(merchantToUserUsdtRate(config));
  });

  it('prices a USDT merchant at the merchant-to-user leg, not the admin one', () => {
    // Using `merchantAdminBuyInr` here would charge the player what the
    // MERCHANT paid, and the merchant would earn nothing.
    const config = { usdtPricing: { merchantAdminBuyInr: 90, userMerchantBuyInr: 95 } };
    expect(rateForMerchant(usdtMerchant, config)).toBe(95);
  });
});

describe('an unset merchant-to-user rate is refused, not guessed', () => {
  for (const [label, config] of [
    ['the schema default of 0', { usdtPricing: { userMerchantBuyInr: 0 } }],
    ['a missing field',         { usdtPricing: {} }],
    ['no usdtPricing at all',   {}],
    ['no config at all',        null],
    ['a negative rate',         { usdtPricing: { userMerchantBuyInr: -5 } }],
    ['a non-number',            { usdtPricing: { userMerchantBuyInr: 'ninety' } }],
    // Not a price at all. Reading one of these would sell 500,000 tokens for
    // 50 USDT, or charge a player a hundred times over.
    ['a rate below the band',   { usdtPricing: { userMerchantBuyInr: 1 } }],
    ['a rate above the band',   { usdtPricing: { userMerchantBuyInr: 10_000 } }],
  ]) {
    it(`returns null for ${label}`, () => {
      expect(merchantToUserUsdtRate(config)).toBeNull();
      // And therefore refuses to price a USDT merchant's order at all.
      expect(rateForMerchant(usdtMerchant, config)).toBeNull();
    });
  }

  it('never substitutes the peg for a missing USDT rate', () => {
    // The failure this is really about: 1 here means the platform sells tokens
    // at one rupee each to a merchant settling in USDT, and eats the spread on
    // every order with nothing reporting it.
    expect(rateForMerchant(usdtMerchant, { usdtPricing: { userMerchantBuyInr: 0 } })).not.toBe(1);
  });
});

describe('the rate that prices every USDT purchase is bounded', () => {
  /**
   * ── Why a rate needs a bound ─────────────────────────────────────────────
   * One number prices the whole rail, and the sizes are large. 10,000 typed
   * for 100 sells 500,000 tokens for 50 USDT, and the first player to notice
   * does not stop at one order. This is a SANITY band — an order of magnitude
   * either side of any real USDT price — not a market view.
   */
  it('accepts a real rate and refuses a misplaced decimal', () => {
    expect(isSaneUsdtRate(100)).toBe(true);
    expect(isSaneUsdtRate(83.5)).toBe(true);
    expect(isSaneUsdtRate(USDT_RATE_MIN_INR)).toBe(true);
    expect(isSaneUsdtRate(USDT_RATE_MAX_INR)).toBe(true);

    expect(isSaneUsdtRate(1)).toBe(false);
    expect(isSaneUsdtRate(10_000)).toBe(false);
    expect(isSaneUsdtRate(0)).toBe(false);
    expect(isSaneUsdtRate(Infinity)).toBe(false);
    expect(isSaneUsdtRate('100')).toBe(true); // a numeric string is a number here
  });

  it('fails CLOSED on a stored rate outside the band', () => {
    // The admin route refuses to store one, but a value can reach the row
    // another way — a direct UPDATE, a restore from an old backup. Refusing to
    // PRICE with it is what makes the bound structural rather than a form
    // validation somebody can route around.
    const absurd = { usdtPricing: { userMerchantBuyInr: 10_000 } };
    expect(merchantToUserUsdtRate(absurd)).toBeNull();
    expect(tokensPerUsdt(absurd)).toBeNull();
    expect(usdtForTokens(500_000, absurd)).toBeNull();
  });

  it('prices the three sizes exactly as the owner specified', () => {
    // 1 USDT = 100 tokens: 50,000 → 500, 100,000 → 1,000, 500,000 → 5,000.
    const cfg = { usdtPricing: { userMerchantBuyInr: 100 } };
    expect(tokensPerUsdt(cfg)).toBe(100);
    expect(usdtForTokens(50_000, cfg)).toBe(500);
    expect(usdtForTokens(100_000, cfg)).toBe(1_000);
    expect(usdtForTokens(500_000, cfg)).toBe(5_000);
  });

  it('rounds the USDT figure UP, never against the platform', () => {
    // 50,000 / 33 = 1515.1515…, and a rate that does not divide evenly is the
    // normal case. Rounding down would hand over the difference on every order.
    const cfg = { usdtPricing: { userMerchantBuyInr: 33 } };
    expect(usdtForTokens(50_000, cfg)).toBe(1515.16);
  });
});

describe('the admin-to-merchant leg', () => {
  it('falls back to the schema default of 1 when unset', () => {
    // Unlike the other leg this one HAS a meaningful default — it is the value
    // the route it feeds has always used — so a fallback here is not a guess.
    expect(adminToMerchantUsdtRate({})).toBe(1);
    expect(adminToMerchantUsdtRate(null)).toBe(1);
    expect(adminToMerchantUsdtRate({ usdtPricing: { merchantAdminBuyInr: 0 } })).toBe(1);
  });
});

describe('the peg has one owner', () => {
  it('is not declared as a bare literal anywhere else', () => {
    // It was `1` in five places — two order-creation paths, the system-config
    // payload and two user routes. Nothing named the rule, so nothing stopped a
    // sixth place from disagreeing, and a reader met a magic number.
    const offenders = [];
    for (const f of walk(join(repo, 'backend'))) {
      if (/[\\/]tests?[\\/]|\.test\./.test(f)) continue;
      if (f.endsWith('domains/configuration/tokenRates.js')) continue;
      // Comments stripped: a note explaining a REMOVED route quotes the old
      // shape, and prose about a rule must not read as a declaration of it.
      const src = readFileSync(f, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      if (/(?:tokenBuyRate|tokenSellRate|buyRate|sellRate|rateUsed)\s*:\s*1\b/.test(src)) {
        offenders.push(f.replace(repo, ''));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is not something the admin can edit', () => {
    // A peg an operator can change is not a peg, and the ledger, depositCredit
    // and every INR order are written assuming it holds.
    const spec = readFileSync(join(repo, 'database/spec/config.spec.js'), 'utf8');
    expect(spec).not.toMatch(/tokenBuyRate|tokenSellRate/);
  });

  it('leaves both USDT legs admin-editable', () => {
    // The other half of the rule: these two DO move, and the admin owns them.
    const spec = readFileSync(join(repo, 'database/spec/config.spec.js'), 'utf8');
    expect(spec).toMatch(/userMerchantBuyInr/);
    expect(spec).toMatch(/merchantAdminBuyInr/);
  });
});
