// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Merchant Platform (BBEPS Phase 008).
//
// Read-only analytics over merchant activity: leaderboards, funding
// statistics, and performance history. Everything here is DERIVED from
// source records (PaymentOrders, the merchant-wallet ledger, the settlement
// ledger's bonus events) — this service stores nothing and mutates nothing.

import mongoose from 'mongoose';

/**
 * getMerchantLeaderboard — merchants ranked by completed volume over a
 * window, with success rate, order counts, and issued bonus totals.
 * sortBy: 'volume' | 'orders' | 'successRate' | 'bonus'
 */
export async function getMerchantLeaderboard({ days = 30, limit = 20, sortBy = 'volume' } = {}) {
  const PaymentOrder = mongoose.model('PaymentOrder');
  const AccountingEvent = mongoose.model('AccountingEvent');
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [orderRows, bonusRows, merchants] = await Promise.all([
    PaymentOrder.aggregate([
      { $match: { merchantId: { $ne: null }, createdAt: { $gte: since } } },
      { $group: {
          _id: '$merchantId',
          totalOrders:     { $sum: 1 },
          completedOrders: { $sum: { $cond: [{ $in: ['$status', ['COMPLETED', 'PAID']] }, 1, 0] } },
          failedOrders:    { $sum: { $cond: [{ $in: ['$status', ['FAILED', 'CANCELLED', 'REJECTED']] }, 1, 0] } },
          completedVolume: { $sum: { $cond: [{ $in: ['$status', ['COMPLETED', 'PAID']] }, '$fiatAmount', 0] } },
      } },
    ]),
    AccountingEvent.aggregate([
      { $match: { eventType: 'MERCHANT_BONUS_ISSUED', createdAt: { $gte: since } } },
      { $unwind: '$postings' },
      { $match: { 'postings.account': 'MERCHANT_FUNDS' } },
      { $group: { _id: '$refId', bonusMinor: { $sum: { $abs: '$postings.amountMinor' } } } },
    ]),
    mongoose.model('Merchant').find({}, 'username status isOnline tokenBalance successRate avgResponseMinutes').lean(),
  ]);

  const bonusByMerchant = Object.fromEntries(bonusRows.map(r => [String(r._id), r.bonusMinor / 100]));
  const merchantById = Object.fromEntries(merchants.map(m => [String(m._id), m]));

  const rows = orderRows.map(r => {
    const id = String(r._id);
    const m = merchantById[id] || {};
    return {
      merchantId: id,
      username: m.username || 'unknown',
      isOnline: !!m.isOnline,
      tokenBalance: m.tokenBalance ?? 0,
      totalOrders: r.totalOrders,
      completedOrders: r.completedOrders,
      failedOrders: r.failedOrders,
      completedVolume: r.completedVolume,
      successRate: r.totalOrders > 0 ? +((r.completedOrders / r.totalOrders) * 100).toFixed(2) : 0,
      bonusIssued: bonusByMerchant[id] || 0,
    };
  });

  const sorters = {
    volume:      (a, b) => b.completedVolume - a.completedVolume,
    orders:      (a, b) => b.completedOrders - a.completedOrders,
    successRate: (a, b) => b.successRate - a.successRate,
    bonus:       (a, b) => b.bonusIssued - a.bonusIssued,
  };
  rows.sort(sorters[sortBy] || sorters.volume);
  return rows.slice(0, limit);
}

/**
 * getMerchantFundingStats — one merchant's funding picture: completed
 * deposit/withdrawal volume (all-time), matched buy→sell cycle volume,
 * bonuses issued, current wallet balance, and admin top-up history totals.
 */
export async function getMerchantFundingStats(merchantId) {
  const PaymentOrder = mongoose.model('PaymentOrder');
  const AccountingEvent = mongoose.model('AccountingEvent');
  const MerchantWalletLedger = mongoose.model('MerchantWalletLedger');
  const Merchant = mongoose.model('Merchant');

  const oid = new mongoose.Types.ObjectId(String(merchantId));
  const [merchant, orderRows, bonusRow, topupRow] = await Promise.all([
    Merchant.findById(oid, 'username tokenBalance status isOnline successRate avgResponseMinutes').lean(),
    PaymentOrder.aggregate([
      { $match: { merchantId: oid, status: 'COMPLETED' } },
      { $group: { _id: '$type', fiat: { $sum: '$fiatAmount' }, count: { $sum: 1 } } },
    ]),
    AccountingEvent.aggregate([
      { $match: { eventType: 'MERCHANT_BONUS_ISSUED', refId: String(merchantId) } },
      { $unwind: '$postings' },
      { $match: { 'postings.account': 'MERCHANT_FUNDS' } },
      { $group: { _id: null, bonusMinor: { $sum: { $abs: '$postings.amountMinor' } }, count: { $sum: 1 } } },
    ]),
    MerchantWalletLedger.aggregate([
      { $match: { merchantId: oid, txId: { $regex: '^mw_topup_' } } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
  ]);
  if (!merchant) return null;

  const dep = orderRows.find(r => r._id === 'DEPOSIT')    || { fiat: 0, count: 0 };
  const wd  = orderRows.find(r => r._id === 'WITHDRAWAL') || { fiat: 0, count: 0 };

  return {
    merchantId: String(merchantId),
    username: merchant.username,
    tokenBalance: merchant.tokenBalance ?? 0,
    isOnline: !!merchant.isOnline,
    depositsCompleted: dep.count,
    depositVolume: dep.fiat,
    withdrawalsCompleted: wd.count,
    withdrawalVolume: wd.fiat,
    matchedCycleVolume: Math.min(dep.fiat, wd.fiat),
    bonusesIssued: bonusRow[0]?.count || 0,
    bonusTotal: (bonusRow[0]?.bonusMinor || 0) / 100,
    adminTopups: topupRow[0]?.count || 0,
    adminTopupTotal: topupRow[0]?.total || 0,
  };
}

/**
 * getMerchantPerformanceHistory — daily completed order counts + volume for
 * one merchant over a window (chart-ready).
 */
export async function getMerchantPerformanceHistory(merchantId, { days = 30 } = {}) {
  const PaymentOrder = mongoose.model('PaymentOrder');
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return PaymentOrder.aggregate([
    { $match: {
        merchantId: new mongoose.Types.ObjectId(String(merchantId)),
        status: 'COMPLETED',
        completedAt: { $gte: since },
    } },
    { $group: {
        _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt' } }, type: '$type' },
        orders: { $sum: 1 },
        volume: { $sum: '$fiatAmount' },
    } },
    { $group: {
        _id: '$_id.day',
        byType: { $push: { type: '$_id.type', orders: '$orders', volume: '$volume' } },
        totalOrders: { $sum: '$orders' },
        totalVolume: { $sum: '$volume' },
    } },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, day: '$_id', byType: 1, totalOrders: 1, totalVolume: 1 } },
  ]);
}
