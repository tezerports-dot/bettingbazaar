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
 * What a player pays a USDT merchant per token.
 *
 * Returns null when it has never been set. The schema default is 0, and 0 is
 * not a rate — pricing an order with it divides by zero, and quietly
 * substituting 1 would sell tokens at the INR peg to a merchant settling in
 * USDT. A caller that cannot price an order must refuse it, not guess.
 */
export function merchantToUserUsdtRate(config) {
  const rate = config?.usdtPricing?.userMerchantBuyInr;
  return isUsableRate(rate) ? Number(rate) : null;
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
