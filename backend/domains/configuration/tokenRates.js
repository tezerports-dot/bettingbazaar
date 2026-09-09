// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * tokenRates.js — what one BB token is worth, and the ONE place that says so.
 *
 * ── The two currencies behave differently, on purpose ───────────────────────
 * AGAINST INR the token is PEGGED 1:1 and is not configurable. A token is a
 * rupee. That is a product decision, not a default waiting to be tuned, so it
 * lives here as a constant rather than in the admin config: a peg an operator
 * can edit is not a peg, and `depositCredit`, the ledger and every INR order
 * are written assuming it holds.
 *
 * AGAINST USDT the rate floats and the admin sets it — separately for each leg,
 * because they are different trades:
 *
 *   admin → merchant   `usdtPricing.merchantAdminBuyInr`
 *       What a merchant pays the platform for the float they trade with.
 *   merchant → user    `usdtPricing.userMerchantBuyInr`
 *       What a player pays a USDT merchant for tokens.
 *
 * The spread between them is the merchant's margin. One rate for both would
 * make that margin zero and the rail pointless, which is why the config carries
 * two numbers and not one.
 *
 * ── What this module replaces ───────────────────────────────────────────────
 * The peg was a bare literal `1` in five places — two order-creation paths, the
 * system-config payload and two user routes — with nothing naming it or
 * explaining why it could not move. `merchantAdminBuyInr` was read in one route
 * with its own `=== undefined ? 1` fallback.
 *
 * And `userMerchantBuyInr` was read NOWHERE. The admin could set the
 * merchant-to-user USDT rate, see it saved, and it changed no transaction: a
 * player buying from a USDT merchant was priced at the INR peg regardless. §9 —
 * a field an operator can edit must wire to a real consumer.
 */
import { MERCHANT_CURRENCY, merchantTypeOf } from '../merchant/merchantCurrency.js';

/**
 * One token, one rupee. Not configurable — see the header.
 *
 * Exported as a named constant so a reader meets the rule rather than a `1`,
 * and so `check:dead-code` notices if it ever stops being used.
 */
export const INR_TOKEN_RATE = 1;

/** True when `rate` is a usable price rather than "nobody has set this yet". */
function isUsableRate(rate) {
  const n = Number(rate);
  return Number.isFinite(n) && n > 0;
}

/**
 * What a merchant pays the platform per token, in USDT terms.
 *
 * Defaults to 1 when unset, which is the schema default and the value this
 * always fell back to.
 */
export function adminToMerchantUsdtRate(config) {
  const rate = config?.usdtPricing?.merchantAdminBuyInr;
  return isUsableRate(rate) ? Number(rate) : 1;
}

/**
 * The band a merchant→user USDT rate must fall in, in INR per USDT.
 *
 * ── Why a rate needs a bound at all ───────────────────────────────────────
 * This single number prices EVERY USDT purchase, and the sizes are large: at
 * the intended rate 500,000 tokens cost 5,000 USDT. A misplaced decimal —
 * 10,000 typed for 100 — makes that same 500,000 tokens cost 50 USDT, and the
 * first player to notice can drain the rail before anybody reads the config
 * screen. The opposite slip charges a player a hundred times over.
 *
 * It is a SANITY band, not a market view: USDT has traded in the ₹60–₹95
 * region, so an order of magnitude either side is far wider than any real rate
 * and still catches a 100× fat finger. A guard tight enough to catch every
 * typo would one day refuse a legitimate rate; this one refuses only figures
 * that cannot be a price.
 *
 * Enforced in BOTH directions, deliberately: the admin route refuses to store
 * one outside the band, and the reader below refuses to price with one — so a
 * value that reached the row some other way (a direct UPDATE, a restore from
 * an old backup) fails closed as "not set" rather than selling tokens at it.
 */
export const USDT_RATE_MIN_INR = 10;
export const USDT_RATE_MAX_INR = 1_000;

/** True when `rate` is a price this platform will actually trade at. */
export function isSaneUsdtRate(rate) {
  const n = Number(rate);
  return Number.isFinite(n) && n >= USDT_RATE_MIN_INR && n <= USDT_RATE_MAX_INR;
}

/**
 * What a player pays a USDT merchant per token.
 *
 * Returns null when it has never been set, and equally when what is stored is
 * not a price at all. The schema default is 0, and 0 is not a rate — pricing
 * an order with it divides by zero, and quietly substituting 1 would sell
 * tokens at the INR peg to a merchant settling in USDT. A caller that cannot
 * price an order must refuse it, not guess.
 */
export function merchantToUserUsdtRate(config) {
  const rate = config?.usdtPricing?.userMerchantBuyInr;
  return isUsableRate(rate) && isSaneUsdtRate(rate) ? Number(rate) : null;
}

/**
 * How many PLATFORM TOKENS one USDT buys.
 *
 * ── Why this is the same stored number, read differently ──────────────────
 * `usdtPricing.userMerchantBuyInr` is "the INR price of one USDT". One token is
 * one rupee (`INR_TOKEN_RATE`), so "₹100 per USDT" and "100 tokens per USDT"
 * are the same fact and the admin sets it once. This function exists so the
 * USDT rail can say what it actually means without a second stored field to
 * drift against the first.
 *
 * The coupling is the peg, and it is worth naming: if the token ever stops
 * being worth exactly ₹1, these become two different numbers and this function
 * becomes wrong rather than merely differently-worded. `INR_TOKEN_RATE` is
 * multiplied in here so that day is a failing test rather than a silent
 * mispricing.
 *
 * Returns null when unset, for the reason `merchantToUserUsdtRate` does: 0 is
 * the schema default and 0 is not a rate — dividing by it gives Infinity USDT,
 * and substituting 1 would sell 50,000 tokens for 50,000 USDT.
 */
export function tokensPerUsdt(config) {
  const inrPerUsdt = merchantToUserUsdtRate(config);
  if (inrPerUsdt === null) return null;
  return inrPerUsdt / INR_TOKEN_RATE;
}

/**
 * What a player sends, in USDT, to receive `tokenAmount` platform tokens.
 *
 * Rounded UP to two decimals — never against the platform, and never a long
 * float in a payment instruction. Two decimals rather than USDT's six because
 * `fiat_amount_paise` is an integer of hundredths; the most that rounding can
 * cost a player is one hundredth of a USDT.
 *
 * Returns null when the rate is unset, so a caller that cannot price a purchase
 * refuses it rather than quoting a number it invented.
 */
export function usdtForTokens(tokenAmount, config) {
  const rate = tokensPerUsdt(config);
  if (rate === null) return null;
  const raw = Number(tokenAmount) / rate;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return Math.ceil(raw * 100) / 100;
}

/**
 * The rate to stamp on an order, given the merchant who will settle it.
 *
 * An INR merchant settles at the peg. A USDT merchant settles at the
 * admin-configured merchant-to-user rate, and there is no fallback: if the
 * admin has not set one, this returns null and the caller must leave the order
 * unassigned rather than price it wrong.
 *
 * @returns {number|null} the rate, or null when a USDT rate is not configured
 */
export function rateForMerchant(merchant, config) {
  if (merchantTypeOf(merchant) === MERCHANT_CURRENCY.USDT) {
    return merchantToUserUsdtRate(config);
  }
  return INR_TOKEN_RATE;
}
