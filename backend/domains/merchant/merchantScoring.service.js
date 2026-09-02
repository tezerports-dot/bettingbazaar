// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * merchantScoring.service.js — Merchant auto-assignment scoring algorithm.
 *
 * GOVERNANCE §1: This service is the sole authority for merchant selection.
 * It is a pure read + score function — no wallet mutations here.
 * All wallet mutations remain exclusively in walletAuthority.service.js.
 */

import mongoose from 'mongoose';
import { db } from '#db';
import { MERCHANT_CURRENCY } from './merchantCurrency.js';
import { getAvailablePaiseFor } from '#db/repositories/merchantWallets.core.js';
import { rupeesToPaise } from '../../shared/money.js';
import { getSystemConfig } from '#db/repositories/config.js';

const ACTIVE_ASSIGNMENT_STATUSES = ['ASSIGNED', 'PROCESSING', 'PAID'];

function scoreMerchant(merchant) {
  const successScore = (merchant.successRate ?? 1.0) * 40;
  const responseScore = Math.max(0, 25 - ((merchant.avgResponseMinutes ?? 2) * 2)); // schema default: 2
  const disputeScore = Math.max(0, 20 - ((merchant.disputeRate ?? 0) * 100));
  let onlineConsistency = 5;
  if (merchant.lastOnlineToggle) {
    const minutesAgo = (Date.now() - new Date(merchant.lastOnlineToggle).getTime()) / 60000;
    onlineConsistency = Math.max(0, 10 - (minutesAgo / 6));
  }
  const maxOrders = merchant.maxConcurrentOrders ?? 3; // schema default: 3
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

async function attachActiveTypeCounts(merchants) {
  if (!merchants.length) return merchants;
  const PaymentOrder = mongoose.model('PaymentOrder');
  const ids = merchants.map((m) => m._id);
  const rows = await PaymentOrder.aggregate([
    { $match: { merchantId: { $in: ids }, status: { $in: ACTIVE_ASSIGNMENT_STATUSES } } },
    { $group: { _id: { merchantId: '$merchantId', type: '$type' }, count: { $sum: 1 } } },
  ]);
  const counts = new Map(rows.map((r) => [`${r._id.merchantId}:${r._id.type}`, r.count]));
  return merchants.map((m) => ({
    ...m,
    activeDepositOrderCount: counts.get(`${m._id}:DEPOSIT`) || 0,
    activeWithdrawalOrderCount: counts.get(`${m._id}:WITHDRAWAL`) || 0,
  }));
}

async function attachThirtyDayFundingImbalance(merchants) {
  if (!merchants.length) return merchants;
  const PaymentOrder = mongoose.model('PaymentOrder');
  const ids = merchants.map((m) => m._id);
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await PaymentOrder.aggregate([
    { $match: { merchantId: { $in: ids }, status: 'COMPLETED', completedAt: { $gte: since }, type: { $in: ['DEPOSIT', 'WITHDRAWAL'] } } },
    { $group: { _id: { merchantId: '$merchantId', type: '$type' }, total: { $sum: '$tokenAmount' } } },
  ]);
  const totals = new Map();
  for (const r of rows) {
    const id = String(r._id.merchantId);
    const entry = totals.get(id) || { deposit: 0, withdrawal: 0 };
    if (r._id.type === 'DEPOSIT') entry.deposit = r.total || 0;
    if (r._id.type === 'WITHDRAWAL') entry.withdrawal = r.total || 0;
    totals.set(id, entry);
  }
  return merchants.map((m) => {
    const t = totals.get(String(m._id)) || { deposit: 0, withdrawal: 0 };
    return { ...m, thirtyDayDepositValue: t.deposit, thirtyDayWithdrawalValue: t.withdrawal, thirtyDayBuySellDelta: t.deposit - t.withdrawal };
  });
}

function typeLimitFor(merchant, orderType, defaults) {
  if (orderType === 'DEPOSIT') {
    return merchant.maxConcurrentDepositOrders ?? defaults.maxDepositOrders;
  }
  return merchant.maxConcurrentWithdrawalOrders ?? defaults.maxWithdrawalOrders;
}

/**
 * selectBestMerchant — find and return the highest-priority eligible merchant.
 *
 * DEPOSIT (user buys tokens): merchants must hold enough tokens; the largest
 * spendable inventory wins, so the biggest holder takes the biggest fit.
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
export async function selectBestMerchant(orderType, tokenAmount, currency = MERCHANT_CURRENCY.INR) {
  const Merchant = mongoose.model('Merchant');
  const defaults = await getFundingLimits();

  const baseQuery = {
    isOnline:               true,
    merchantApprovalStatus: 'APPROVED',
    status:                 'ACTIVE',
    acceptedCurrencies:     currency,
    $expr: {
      $lt: [
        { $ifNull: ['$activeOrderCount', 0] },
        { $ifNull: ['$maxConcurrentOrders', 3] },
      ],
    },
  };

  if (orderType === 'DEPOSIT') {
    baseQuery.acceptsDeposits = true;
    // The token criterion is NOT in this query, and cannot be: the balance it
    // would filter on lives in another system. It is applied below, against the
    // wallet, after the candidates are fetched.
  } else {
    baseQuery.acceptsWithdrawals = true;
  }

  let candidates = await Merchant.find(baseQuery).lean();
  candidates = await attachActiveTypeCounts(candidates);
  candidates = candidates.filter((m) => {
    const limit = typeLimitFor(m, orderType, defaults);
    const activeForType = orderType === 'DEPOSIT' ? m.activeDepositOrderCount : m.activeWithdrawalOrderCount;
    return activeForType < limit;
  });
  if (!candidates.length) return null;

  if (orderType === 'DEPOSIT') {
    // One batched read, so every candidate is judged against the same instant.
    // A read per candidate would be N round trips on the hot path of a money
    // movement, and would judge each one at a slightly different moment.
    const availablePaise = await getAvailablePaiseFor(candidates.map((m) => m._id));
    const neededPaise = rupeesToPaise(tokenAmount);

    // A merchant with NO wallet row is EXCLUDED, not sorted last. No row means
    // the money system has never seen them, which is a different thing from
    // being empty and routes differently: an empty merchant may be topped up,
    // an unknown one should not be handed an order at all.
    candidates = candidates.filter((m) => (availablePaise.get(String(m._id)) ?? -1) >= neededPaise);
    if (!candidates.length) return null;

    const paiseOf = (m) => availablePaise.get(String(m._id)) ?? 0;
    candidates.sort((a, b) => {
      // Ranked on the SAME number the filter used, so the merchant chosen is
      // the one that actually holds the most.
      if (paiseOf(b) !== paiseOf(a)) return paiseOf(b) - paiseOf(a);
      const scoreDiff = scoreMerchant(b) - scoreMerchant(a);
      if (scoreDiff !== 0) return scoreDiff;
      return (a.activeDepositOrderCount || 0) - (b.activeDepositOrderCount || 0);
    });
  } else {
    candidates = await attachThirtyDayFundingImbalance(candidates);
    candidates.sort((a, b) => {
      if ((b.thirtyDayBuySellDelta || 0) !== (a.thirtyDayBuySellDelta || 0)) return (b.thirtyDayBuySellDelta || 0) - (a.thirtyDayBuySellDelta || 0);
      const scoreDiff = scoreMerchant(b) - scoreMerchant(a);
      if (scoreDiff !== 0) return scoreDiff;
      return (a.activeWithdrawalOrderCount || 0) - (b.activeWithdrawalOrderCount || 0);
    });
  }

  return db.merchants.getMerchant(candidates[0]._id);
}
