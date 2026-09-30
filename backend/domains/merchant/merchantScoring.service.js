// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * merchantScoring.service.js — which merchant is handed a player's money.
 *
 * §1: the sole authority for merchant selection. A pure read-and-score
 * function; every wallet mutation stays in the wallet authorities.
 *
 * ── A filter that never filtered, and a score component that was constant ───
 * The candidate query gated on `activeOrderCount < maxConcurrentOrders` with an
 * `$ifNull` default of 0. `activeOrderCount` is not a field on a merchant —
 * that number is DERIVED from the orders themselves — so the left side was
 * always 0 and the filter always passed. A merchant already at their
 * concurrency limit was offered every order anyway.
 *
 * `scoreMerchant` read the same absent field for its load component, so
 * `loadScore` was a constant 5 for every merchant on the platform: a quarter of
 * the ranking's dynamic range doing nothing.
 *
 * Both counts are computed from `order_states` now, per direction, in the same
 * query that selects the candidates.
 *
 * ── The token balance is read from the wallet, by name ──────────────────────
 * This function decides where a player's money goes, so the number it decides
 * with has to be the number the transfer will find. Filtering on a stored copy
 * is how an order came to be routed to a merchant with no tokens to serve it:
 * accepted, unfundable, and the player left waiting.
 */

import { db } from '#db';
import { MERCHANT_CURRENCY } from './merchantCurrency.js';
import { getSpendablePaiseFor } from '#db/repositories/merchantWallets.core.js';
import { rupeesToPaise } from '../../shared/money.js';
import { getSystemConfig } from '#db/repositories/config.js';
import {
  PAYMENT_MODES,
  getActivePolicy as getActivePaymentModePolicy,
  getPolicyVersion as getPaymentModePolicyVersion,
  concurrencyCapFor,
} from '#db/repositories/paymentModePolicy.js';

function scoreMerchant(merchant, maxOrders) {
  const successScore = (merchant.successRate ?? 1.0) * 40;
  const responseScore = Math.max(0, 25 - ((merchant.avgResponseMinutes ?? 2) * 2)); // schema default: 2
  const disputeScore = Math.max(0, 20 - ((merchant.disputeRate ?? 0) * 100));
  let onlineConsistency = 5;
  if (merchant.lastOnlineToggle) {
    const minutesAgo = (Date.now() - new Date(merchant.lastOnlineToggle).getTime()) / 60000;
    onlineConsistency = Math.max(0, 10 - (minutesAgo / 6));
  }
  // `activeOrderCount` is DERIVED and attached by the candidate query. It used
  // to be read off the merchant record, where no such field exists — so this
  // term was a constant 5 for everybody and the load component of the ranking
  // did nothing at all.
  // Passed in, from the same `concurrencyCapFor` the admission gate used. The
  // load term dividing by a DIFFERENT capacity than the gate admits by would
  // rank merchants against a limit they are not actually held to.
  const loadScore = Math.max(0, 5 - ((merchant.activeOrderCount ?? 0) / Math.max(maxOrders, 1)) * 5);
  return successScore + responseScore + disputeScore + onlineConsistency + loadScore;
}

async function getFundingLimits() {
  const cfg = await getSystemConfig();
  return {
    maxDepositOrders: cfg?.merchantOrderLimits?.maxConcurrentDepositOrders ?? 1, // schema default: 1
    maxWithdrawalOrders: cfg?.merchantOrderLimits?.maxConcurrentWithdrawalOrders ?? 1, // schema default: 1
  };
}

/**
 * How many orders a merchant may hold at once, from the rail this order is on.
 *
 * Read from the ORDER's policy version, not the active one, for the same reason
 * the order window is: an order assigned after a switch is still running the
 * process it was created under, and holding its merchant to a different
 * concurrency rule would change what that merchant was promised.
 *
 * On the cash rail the answer is ONE in either direction — the notes a merchant
 * is holding are the same notes, so two open orders promise them twice.
 */
async function totalOrderLimitFor(paymentModeVersion) {
  const policy = (paymentModeVersion != null
    ? await getPaymentModePolicyVersion(paymentModeVersion)
    : null) ?? await getActivePaymentModePolicy();
  // Through the one owner. This returned `policy.maxConcurrentOrders` directly
  // while the comment above it described the cash rail's rule — the notes are
  // the same notes, so the answer there is ONE. The column defaults to 3 and is
  // carried across a rail switch on purpose, so the comment was true and the
  // value was not.
  return concurrencyCapFor(policy);
}

/**
 * selectBestMerchant — find and return the highest-priority eligible merchant.
 *
 * DEPOSIT (user buys tokens): merchants must hold enough tokens; the largest
 * spendable inventory wins, so the biggest holder takes the biggest fit.
 * SPENDABLE means the wallet's available pocket MINUS the buy orders this
 * merchant is already serving — a commitment they have taken on and not yet
 * discharged. Ranking on the raw pocket handed the biggest holder every order
 * in the queue and left the last few unfundable (F-018).
 *
 * The token figure comes from `merchant_wallets`, which is where every token
 * movement actually happens — NOT from a field on the merchant record. This
 * function decides where a player's money goes, so the number it decides with
 * has to be the number the transfer will find. Filtering on a stored copy is
 * how an order came to be routed to a merchant with no tokens to serve it:
 * accepted, unfundable, and the player waiting.
 * WITHDRAWAL (user sells tokens): merchants with the largest 30-day completed
 * buy-minus-sell value are replenished first; if none are free, the order stays
 * in the open sell pool instead of burning retry attempts.
 */
export async function selectBestMerchant(orderType, tokenAmount, currency = MERCHANT_CURRENCY.INR, {
  // Merchants this order may not be given to. Defaulted to empty so every
  // existing caller keeps working, and supplied by `tryAssignMerchant`, which
  // is the only path that knows the order and the player.
  barredMerchantIds = [],
  // The rail this ORDER was created on, and the policy version that governs
  // it. Both come off the order row, never from the live policy: an order
  // assigned after a switch keeps the rules it was born under.
  paymentMode = null,
  paymentModeVersion = null,
  // The chain a USDT order will be paid on. A merchant with no address on it
  // cannot receive the money, so they are excluded by the candidate query
  // rather than ranked and then found unusable.
  usdtChain = null,
} = {}) {
  const defaults = await getFundingLimits();
  const totalLimit = await totalOrderLimitFor(paymentModeVersion);

  // On the cash rail an order is served at a fixed amount and a merchant is
  // approved for exactly ONE, so the order's own amount IS the denomination to
  // match. On the UPI rail amounts are a range and this plays no part.
  const cashDenominationPaise = paymentMode === PAYMENT_MODES.CASH_ATM
    ? rupeesToPaise(tokenAmount)
    : null;

  // Eligibility the ROW can decide — approved, active, online, accepting this
  // direction, and under both concurrency caps — in one query, with the active
  // counts and the 30-day funding imbalance the ranking needs attached.
  let candidates = await db.merchants.assignmentCandidates({
    currency,
    // Anybody who refused this order, or any order from this player. Passed to
    // the QUERY rather than filtered here, so an excluded merchant is never a
    // candidate at all — see `merchantsBarredFrom`.
    barredMerchantIds,
    direction: orderType === 'WITHDRAWAL' ? 'WITHDRAWAL' : 'DEPOSIT',
    defaultDepositLimit: defaults.maxDepositOrders,
    defaultWithdrawalLimit: defaults.maxWithdrawalOrders,
    defaultTotalLimit: totalLimit,
    cashDenominationPaise,
    usdtChain,
  });
  if (!candidates.length) return null;

  if (orderType === 'DEPOSIT') {
    // One batched read, so every candidate is judged against the same instant.
    // A read per candidate would be N round trips on the hot path of a money
    // movement, and would judge each at a slightly different moment.
    // SPENDABLE, not available: what the merchant holds MINUS the buy orders
    // already on their plate. The raw pocket says a merchant holding 10,000
    // who has just taken an 8,000 order can serve another 10,000, and the
    // player finds out otherwise after paying. See F-018.
    const spendablePaise = await getSpendablePaiseFor(candidates.map((m) => m.merchantId));
    const neededPaise = rupeesToPaise(tokenAmount);

    // A merchant with NO wallet row is EXCLUDED, not sorted last. No row means
    // the money system has never seen them, which is a different thing from
    // being empty and routes differently: an empty merchant may be topped up,
    // an unknown one should not be handed an order at all. `undefined` here is
    // that case; `-1` keeps it below every possible `neededPaise`.
    const paiseOf = (m) => spendablePaise.get(String(m.merchantId))?.spendable ?? -1;
    candidates = candidates.filter((m) => paiseOf(m) >= neededPaise);
    if (!candidates.length) return null;

    candidates.sort((a, b) => {
      // Ranked on the SAME number the filter used, so the merchant chosen is
      // the one that actually holds the most.
      if (paiseOf(b) !== paiseOf(a)) return paiseOf(b) - paiseOf(a);
      const scoreDiff = scoreMerchant(b, totalLimit) - scoreMerchant(a, totalLimit);
      if (scoreDiff !== 0) return scoreDiff;
      return a.activeDepositOrderCount - b.activeDepositOrderCount;
    });
  } else {
    // Merchants who have taken in more than they have paid out are replenished
    // first, so tokens flow back out of the merchants holding the most.
    candidates.sort((a, b) => {
      if (b.thirtyDayBuySellDelta !== a.thirtyDayBuySellDelta) {
        return b.thirtyDayBuySellDelta - a.thirtyDayBuySellDelta;
      }
      const scoreDiff = scoreMerchant(b, totalLimit) - scoreMerchant(a, totalLimit);
      if (scoreDiff !== 0) return scoreDiff;
      return a.activeWithdrawalOrderCount - b.activeWithdrawalOrderCount;
    });
  }

  return candidates[0];
}
