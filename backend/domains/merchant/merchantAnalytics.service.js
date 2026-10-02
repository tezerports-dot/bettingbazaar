// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/merchant/merchantAnalytics.service.js — read-only analytics over
 * merchant activity: leaderboards, funding statistics, performance history.
 *
 * Everything here is DERIVED from source rows — orders, the merchant wallet
 * ledger, the accounting events a bonus produced. This service stores nothing
 * and mutates nothing, which is why the aggregates live in the repository and
 * this file is the vocabulary over them.
 *
 * ── What the rewrite changed ────────────────────────────────────────────────
 * The leaderboard ran three queries in parallel — an order aggregate, a bonus
 * aggregate, and a scan of EVERY merchant on the platform — then joined them in
 * JavaScript with a lookup per row. It is one statement now, and the merchant
 * join is a join.
 *
 * A merchant holds no tokens (PROJECT_STATUS §3.10 2c): their team's pool
 * does, so there is no balance in the funding picture.
 *
 * The performance history grouped by a UTC date. This platform operates in IST,
 * which is UTC+5:30, so every order placed after 18:30 local was charted on the
 * following day. Days are cut in the platform's own timezone, and a day with no
 * orders is a zero rather than a gap the chart interpolates across.
 */
import { db } from '#db';
import { merchantTypeOf } from './merchantCurrency.js';

/**
 * Merchants ranked by completed volume over a window, with success rate, order
 * counts and issued bonus totals.
 *
 * @param {{days?:number, limit?:number, sortBy?:'volume'|'orders'|'successRate'|'bonus'}} options
 */
export function getMerchantLeaderboard(options = {}) {
  return db.stats.merchantLeaderboard(options);
}

/**
 * One merchant's funding picture: completed deposit and withdrawal volume
 * and matched buy→sell cycle volume.
 *
 * Returns null for a merchant that does not exist, so a caller can answer 404
 * rather than render a page of zeroes for a typo'd id.
 */
export async function getMerchantFundingStats(merchantId) {
  const merchant = await db.merchants.getMerchant(merchantId);
  if (!merchant) return null;

  const stats = await db.stats.merchantFundingStats(merchantId);

  return {
    ...stats,
    username: merchant.username,
    status: merchant.status,
    isOnline: merchant.isOnline,
    successRate: merchant.successRate,
    avgResponseMinutes: merchant.avgResponseMinutes,
    // The volumes above are summed in the ORDER's currency, which for one
    // merchant is their one rail (§2) — so a screen must say WHICH: a USDT
    // merchant's 555.56 is USDT, and "₹555.56" beside it is trap 15's display
    // mouth. Named here so the screen never has to guess.
    currency: merchantTypeOf(merchant),
  };
}

/**
 * Daily completed order counts and volume for one merchant over a window,
 * chart-ready.
 */
export function getMerchantPerformanceHistory(merchantId, options = {}) {
  return db.stats.merchantPerformanceHistory(merchantId, options);
}
