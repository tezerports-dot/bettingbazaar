// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Analytics Platform (BBEPS Phase 012 — Enterprise Services tier).
//
// Platform-level trend analytics EXTENDING the existing analytics domain
// (dashboard/financials/deposit/withdrawal endpoints stay as-is — Phase 011
// rule: extend, don't redesign). Everything here is derived, read-only,
// day-bucketed and chart-ready: growth (users), business (betting +
// funding volume), revenue (from the settlement ledger — the financial
// truth), and risk (rejection/dispute signals).

import mongoose from 'mongoose';

function sinceDays(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
const DAY = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };

/** Growth: daily new registrations + first-time depositors. */
export async function growthTrend({ days = 30 } = {}) {
  const User = mongoose.model('User');
  const PaymentOrder = mongoose.model('PaymentOrder');
  const since = sinceDays(days);

  const [signups, firstDeposits] = await Promise.all([
    User.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: DAY, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    PaymentOrder.aggregate([
      { $match: { type: 'DEPOSIT', status: 'COMPLETED' } },
      { $sort: { userId: 1, completedAt: 1 } },
      { $group: { _id: '$userId', firstAt: { $first: '$completedAt' } } },
      { $match: { firstAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$firstAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
  ]);
  return {
    signups: signups.map(r => ({ day: r._id, count: r.count })),
    firstTimeDepositors: firstDeposits.map(r => ({ day: r._id, count: r.count })),
  };
}

/** Business: daily betting volume/count + funding volume by direction. */
export async function businessTrend({ days = 30 } = {}) {
  const Bet = mongoose.model('Bet');
  const PaymentOrder = mongoose.model('PaymentOrder');
  const since = sinceDays(days);

  const [betting, funding] = await Promise.all([
    Bet.aggregate([
      { $match: { createdAt: { $gte: since }, isPhantom: { $ne: true } } },
      { $group: { _id: DAY, bets: { $sum: 1 }, volume: { $sum: '$amount' }, bettors: { $addToSet: '$userId' } } },
      { $project: { bets: 1, volume: 1, uniqueBettors: { $size: '$bettors' } } },
      { $sort: { _id: 1 } },
    ]),
    PaymentOrder.aggregate([
      { $match: { status: 'COMPLETED', completedAt: { $gte: since } } },
      { $group: {
          _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt' } }, type: '$type' },
          orders: { $sum: 1 }, volume: { $sum: '$fiatAmount' },
      } },
      { $sort: { '_id.day': 1 } },
    ]),
  ]);

  const fundingByDay = {};
  for (const r of funding) {
    const d = fundingByDay[r._id.day] = fundingByDay[r._id.day] || { day: r._id.day, depositVolume: 0, deposits: 0, withdrawalVolume: 0, withdrawals: 0 };
    if (r._id.type === 'DEPOSIT') { d.depositVolume = r.volume; d.deposits = r.orders; }
    else { d.withdrawalVolume = r.volume; d.withdrawals = r.orders; }
  }
  return {
    betting: betting.map(r => ({ day: r._id, bets: r.bets, volume: r.volume, uniqueBettors: r.uniqueBettors })),
    funding: Object.values(fundingByDay).sort((a, b) => a.day.localeCompare(b.day)),
  };
}

/** Revenue: daily PLATFORM_REVENUE movement from the settlement ledger. */
export async function revenueTrend({ days = 30 } = {}) {
  const AccountingEvent = mongoose.model('AccountingEvent');
  const rows = await AccountingEvent.aggregate([
    { $match: { occurredAt: { $gte: sinceDays(days) } } },
    { $unwind: '$postings' },
    { $match: { 'postings.account': 'PLATFORM_REVENUE' } },
    { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$occurredAt' } },
        // credit-normal account: negate so positive = revenue earned that day
        netMinor: { $sum: { $multiply: ['$postings.amountMinor', -1] } },
    } },
    { $sort: { _id: 1 } },
  ]);
  return rows.map(r => ({ day: r._id, revenue: r.netMinor / 100 }));
}

/** Risk: daily rejected/cancelled/disputed order signals. */
export async function riskTrend({ days = 30 } = {}) {
  const PaymentOrder = mongoose.model('PaymentOrder');
  const rows = await PaymentOrder.aggregate([
    { $match: { createdAt: { $gte: sinceDays(days) }, status: { $in: ['REJECTED', 'CANCELLED', 'FAILED', 'DISPUTED'] } } },
    { $group: { _id: { day: DAY, status: '$status' }, count: { $sum: 1 } } },
    { $group: { _id: '$_id.day', byStatus: { $push: { status: '$_id.status', count: '$count' } }, total: { $sum: '$count' } } },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, day: '$_id', byStatus: 1, total: 1 } },
  ]);
  return rows;
}
