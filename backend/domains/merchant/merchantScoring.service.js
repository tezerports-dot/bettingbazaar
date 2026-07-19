// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * merchantScoring.service.js — Merchant auto-assignment scoring algorithm.
 *
 * GOVERNANCE §1: This service is the sole authority for merchant selection.
 * It is a pure read + score function — no wallet mutations here.
 * All wallet mutations remain exclusively in walletAuthority.service.js.
 */

import mongoose from 'mongoose';

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
  const SystemConfig = mongoose.model('SystemConfig');
  const cfg = await SystemConfig.findOne({ key: 'main' }).lean();
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
 * DEPOSIT (user buys tokens): merchants must hold enough tokens; highest
 * current tokenBalance wins so the largest inventory takes the largest fit.
 * WITHDRAWAL (user sells tokens): merchants with the largest 30-day completed
 * buy-minus-sell value are replenished first; if none are free, the order stays
 * in the open sell pool instead of burning retry attempts.
 */
export async function selectBestMerchant(orderType, tokenAmount, currency = 'INR') {
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
    baseQuery.tokenBalance = { $gte: tokenAmount };
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
    candidates.sort((a, b) => {
      if ((b.tokenBalance || 0) !== (a.tokenBalance || 0)) return (b.tokenBalance || 0) - (a.tokenBalance || 0);
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

  return Merchant.findById(candidates[0]._id);
}
