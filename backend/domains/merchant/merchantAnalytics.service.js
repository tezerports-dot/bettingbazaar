// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
 * The funding picture read a stored `tokenBalance` off the merchant record.
 * That figure is not where a merchant's money lives, so an operator reviewing
 * whether to top somebody up saw a number no transfer would have found. The
 * balance now comes from `merchant_wallets`, read by name.
 *
 * The performance history grouped by a UTC date. This platform operates in IST,
 * which is UTC+5:30, so every order placed after 18:30 local was charted on the
 * following day. Days are cut in the platform's own timezone, and a day with no
 * orders is a zero rather than a gap the chart interpolates across.
 */
import { db } from '#db';
import { getMerchantTokenBalance } from '#db/repositories/merchantWallets.js';

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
 * One merchant's funding picture: completed deposit and withdrawal volume,
 * matched buy→sell cycle volume, bonuses issued, current wallet balance, and
 * admin top-up totals.
 *
 * Returns null for a merchant that does not exist, so a caller can answer 404
 * rather than render a page of zeroes for a typo'd id.
 */
export async function getMerchantFundingStats(merchantId) {
  const merchant = await db.merchants.getMerchant(merchantId);
  if (!merchant) return null;

  const [stats, tokenBalance] = await Promise.all([
    db.stats.merchantFundingStats(merchantId),
    // From the wallet, by name. See the header.
    getMerchantTokenBalance(merchantId),
  ]);

  return {
    ...stats,
    username: merchant.username,
    status: merchant.status,
    isOnline: merchant.isOnline,
    successRate: merchant.successRate,
    avgResponseMinutes: merchant.avgResponseMinutes,
    tokenBalance,
  };
}

/**
 * Daily completed order counts and volume for one merchant over a window,
 * chart-ready.
 */
export function getMerchantPerformanceHistory(merchantId, options = {}) {
  return db.stats.merchantPerformanceHistory(merchantId, options);
}
