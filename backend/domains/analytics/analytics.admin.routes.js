// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** analytics.admin.routes.js — Dashboard, financial analytics, stats */
import { express, mongoose, authenticate, isAdmin, isAdminOrSubAdmin, getModels } from '../../routes/admin/_adminShared.js';
import { betTotals, betTotalsByDay } from '../../postgres/analyticsPg.js';
// Analytics Platform trends (Phase 012 — Enterprise Services tier)
import { growthTrend, businessTrend, revenueTrend, riskTrend } from './analyticsPlatform.service.js';

const router = express.Router();

// GET /api/admin/analytics/trends?days=30 — platform-level trend bundle:
// growth (signups, first-time depositors), business (betting + funding
// volume), revenue (from the settlement ledger), risk (order failure/
// dispute signals). All derived, read-only, day-bucketed.
router.get('/analytics/trends', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
    const [growth, business, revenue, risk] = await Promise.all([
      growthTrend({ days }), businessTrend({ days }), revenueTrend({ days }), riskTrend({ days }),
    ]);
    res.json({ success: true, days, trends: { growth, business, revenue, risk } });
  } catch (error) {
    console.error('Analytics trends error:', error);
    res.status(500).json({ success: false, message: 'Failed to build analytics trends' });
  }
});

router.get('/analytics/dashboard', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { User, Transaction, Bet, Cycle, PaymentOrder } = getModels();
    
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // ── Users ──────────────────────────────────────────────────────────────
    const [totalUsers, activeUsers, blockedUsers, kycPending] = await Promise.all([
      // Exclude merchant-role users from player count (merchants are separate entity)
      User.countDocuments({ roles: { $ne: 'merchant' }, isAdmin: false }),
      User.countDocuments({ roles: { $ne: 'merchant' }, isAdmin: false, status: 'ACTIVE' }),
      User.countDocuments({ status: 'BLOCKED' }),
      User.countDocuments({ kycStatus: { $in: ['PENDING_SUBMISSION', 'PENDING_APPROVAL'] } }),
    ]);

    // ── Merchants ──────────────────────────────────────────────────────────
    const [totalMerchants, activeMerchants, pendingMerchants, onlineMerchants] = await Promise.all([
      mongoose.model('Merchant').countDocuments({}),
      mongoose.model('Merchant').countDocuments({ merchantApprovalStatus: 'APPROVED' }),
      mongoose.model('Merchant').countDocuments({ merchantApprovalStatus: 'PENDING' }),
      // ✅ FIXED BUG-5: isOnline lives on Merchant doc not User doc → was always 0
      mongoose.model('Merchant').countDocuments({ status: 'ACTIVE', isOnline: true }),
    ]);

    // Deposits and withdrawals still come from the Transaction feed — those rows
    // ARE written, by the payment flows, and that domain has not moved yet.
    const [depositAgg, withdrawalAgg] = await Promise.all([
      Transaction.aggregate([
        { $match: { type: 'DEPOSIT', status: 'SUCCESS' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Transaction.aggregate([
        { $match: { type: 'WITHDRAWAL', status: 'SUCCESS' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
    ]);
    const totalDeposits    = depositAgg[0]?.total    || 0;
    const totalWithdrawals = withdrawalAgg[0]?.total || 0;

    // Stakes and payouts are SUMMED FROM THE BETS rather than from `Transaction`
    // rows of type BET_PLACED and BET_WIN. The BET_WIN rows came from a
    // settlement helper the engine no longer calls, so the payout side would
    // have gone silently to zero. Both sides move because a feed can be missing
    // rows and still look healthy, while a sum over `bets` cannot — and because
    // the feed counted REFUNDED stakes as turnover and grouped stakes and
    // payouts by different timestamps.
    const allTime = await betTotals();
    const totalPayouts    = allTime.payouts;
    const totalBetsAmount = allTime.bets;
    const netProfit       = totalBetsAmount - totalPayouts;

    // ── Finance TODAY (IST) ───────────────────────────────────────────────
    const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
    const [todayBetting, todayDepositsAgg] = await Promise.all([
      betTotals({ since: today }),
      Transaction.aggregate([{ $match: { type: 'DEPOSIT', status: 'SUCCESS', createdAt: { $gte: today } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    ]);
    const todayBets      = todayBetting.bets;
    const todayBetCount  = todayBetting.betCount;
    const todayPayouts   = todayBetting.payouts;
    const todayDeposits  = todayDepositsAgg[0]?.total || 0;
    const todayNetProfit = todayBets - todayPayouts;

    // ── Daily report: last 7 days (IST timezone) ──────────────────────────
    // One query, one grouping. The two Mongo aggregations grouped stakes by the
    // bet's day and payouts by the SETTLEMENT's day, so a cycle that closed
    // either side of midnight put its stakes on one line and its winnings on the
    // next — and both days' net profit was wrong. Both now key off `placed_at`,
    // which keeps a cycle's money together.
    const dailyReport = (await betTotalsByDay({ since: weekAgo })).map((d) => ({
      date:      d.date,
      bets:      d.bets,
      betCount:  d.betCount,
      payouts:   d.payouts,
      netProfit: d.bets - d.payouts,
    }));

    // ── Cycles ─────────────────────────────────────────────────────────────
    const [activeCycles, todayCycles, totalBetCount] = await Promise.all([
      Cycle.countDocuments({ status: { $in: ['OPEN', 'PAUSED'] } }),
      Cycle.countDocuments({ status: 'COMPLETED', updatedAt: { $gte: today } }),
      Bet.countDocuments(),
    ]);

    // ── Queue ──────────────────────────────────────────────────────────────
    const pendingOrders = await PaymentOrder.countDocuments({ status: 'PENDING_QUEUE' });

    res.json({
      success: true,
      metrics: {
        users:     { total: totalUsers, active: activeUsers, blocked: blockedUsers, kycPending },
        merchants: { total: totalMerchants, active: activeMerchants, pending: pendingMerchants, online: onlineMerchants },
        finance: {
          totalDeposits, totalWithdrawals, totalBets: totalBetsAmount, totalPayouts, netProfit,
          today: { bets: todayBets, betCount: todayBetCount, payouts: todayPayouts, deposits: todayDeposits, netProfit: todayNetProfit },
        },
        cycles:      { activeCount: activeCycles, todayCount: todayCycles, totalBets: totalBetCount },
        queue:       { pendingOrders, avgWaitTime: 0 },
        dailyReport,
      },
    });
  } catch (error) {
    console.error('Dashboard metrics error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch dashboard metrics' });
  }
});

// Get financial data
router.get('/analytics/financials', authenticate, isAdmin, async (req, res) => {
  try {
    const { Transaction, Bet } = getModels();
    const GameTransaction = mongoose.model('GameTransaction');
    const { startDate, endDate } = req.query;
    
    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);

    // FIX DATA 3.2: was status 'COMPLETED' (invalid) and createdAt (wrong field — schema uses 'timestamp')
    const deposits = await Transaction.aggregate([
      { $match: { type: 'DEPOSIT', status: 'SUCCESS', ...(Object.keys(dateFilter).length && { timestamp: dateFilter }) } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);

    const withdrawals = await Transaction.aggregate([
      { $match: { type: 'WITHDRAWAL', status: 'SUCCESS', ...(Object.keys(dateFilter).length && { timestamp: dateFilter }) } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);

    // FIX 11: Exclude phantom bets so P&L only reflects real user activity
    const betsData = await Bet.aggregate([
      { $match: { isPhantom: { $ne: true }, ...(Object.keys(dateFilter).length && { createdAt: dateFilter }) } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);

    const payoutsData = await Bet.aggregate([
      { $match: { isPhantom: { $ne: true }, status: 'WON', payout: { $exists: true }, ...(Object.keys(dateFilter).length && { settledAt: dateFilter }) } },
      { $group: { _id: null, total: { $sum: '$payout' }, count: { $sum: 1 } } }
    ]);

    const depositsTotal    = deposits[0]?.total    || 0;
    const withdrawalsTotal = withdrawals[0]?.total || 0;
    const betsTotal        = betsData[0]?.total    || 0;
    const payoutsTotal     = payoutsData[0]?.total || 0;
    // FIX 5: Use betsTotal - payoutsTotal (same formula as dashboard).
    // Cycle.netProfit is unreliable — it was 0 for many historical cycles.
    const netProfit = betsTotal - payoutsTotal;

    // Per-provider GGR from GameTransaction wallet callbacks
    const providerBets = await GameTransaction.aggregate([
      { $match: { type: 'BET', ...(Object.keys(dateFilter).length && { createdAt: dateFilter }) } },
      { $group: { _id: '$providerKey', bets: { $sum: '$amount' }, betCount: { $sum: 1 } } },
    ]);
    const providerWins = await GameTransaction.aggregate([
      { $match: { type: 'WIN', ...(Object.keys(dateFilter).length && { createdAt: dateFilter }) } },
      { $group: { _id: '$providerKey', wins: { $sum: '$amount' }, winCount: { $sum: 1 } } },
    ]);
    const winsMap = Object.fromEntries(providerWins.map(w => [w._id, w]));
    const byProvider = providerBets.map(b => {
      const w = winsMap[b._id] || { wins: 0, winCount: 0 };
      return { key: b._id, bets: b.bets, betCount: b.betCount, wins: w.wins, winCount: w.winCount, ggr: b.bets - w.wins };
    }).sort((a, b) => b.ggr - a.ggr);

    res.json({
      success: true,
      data: {
        totalRevenue:  depositsTotal + betsTotal,
        totalExpenses: withdrawalsTotal + payoutsTotal,
        netProfit,
        profitMargin:  depositsTotal > 0 ? (netProfit / depositsTotal) * 100 : 0,
        deposits:    { amount: depositsTotal,    count: deposits[0]?.count    || 0 },
        withdrawals: { amount: withdrawalsTotal, count: withdrawals[0]?.count || 0 },
        bets:        { amount: betsTotal,        count: betsData[0]?.count    || 0 },
        payouts:     { amount: payoutsTotal,     count: payoutsData[0]?.count || 0 },
        byProvider,
      }
    });
  } catch (error) {
    console.error('Financial data error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch financial data' });
  }
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 👥 USER MANAGEMENT
 * ════════════════════════════════════════════════════════════════════════════
 */

// Get all users with filters
router.get('/stats', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { User, Merchant, PaymentOrder, Transaction, Bet } = getModels();
    const now = new Date();
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(now); weekStart.setDate(now.getDate() - 7);
    const monthStart = new Date(now); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

    const [
      totalUsers, activeUsers, totalMerchants,
      pendingOrders, completedOrders, disputedOrders,
      dailyVolume, monthlyVolume, totalBets
    ] = await Promise.all([
      User.countDocuments({ isAdmin: false, roles: { $ne: 'merchant' } }),
      User.countDocuments({ status: 'ACTIVE', isAdmin: false, roles: { $ne: 'merchant' } }),
      Merchant.countDocuments({ merchantApprovalStatus: 'APPROVED' }),
      PaymentOrder.countDocuments({ status: { $in: ['PENDING_QUEUE', 'ASSIGNED', 'PROCESSING', 'PAID'] } }),
      PaymentOrder.countDocuments({ status: 'COMPLETED', updatedAt: { $gte: monthStart } }),
      PaymentOrder.countDocuments({ status: 'DISPUTED' }),
      PaymentOrder.aggregate([{ $match: { status: 'COMPLETED', completedAt: { $gte: dayStart } } }, { $group: { _id: null, total: { $sum: '$fiatAmount' } } }]),
      PaymentOrder.aggregate([{ $match: { status: 'COMPLETED', completedAt: { $gte: monthStart } } }, { $group: { _id: null, total: { $sum: '$fiatAmount' } } }]),
      Bet.countDocuments({ timestamp: { $gte: weekStart }, isPhantom: false }),
    ]);

    res.json({
      success: true,
      stats: {
        users: { total: totalUsers, active: activeUsers },
        merchants: { total: totalMerchants },
        orders: { pending: pendingOrders, completedThisMonth: completedOrders, disputed: disputedOrders },
        volume: {
          daily: dailyVolume[0]?.total || 0,
          monthly: monthlyVolume[0]?.total || 0,
        },
        bets: { weeklyCount: totalBets },
      },
    });
  } catch (error) {
    console.error('GET /stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 📢 FIX (Audit #24) — PROMO CONTENT MANAGEMENT
 * Frontend admin panel calls: GET/POST/PUT/DELETE /api/admin/promo
 * ════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/analytics/deposit-dashboard
// Shows ONLY TOKEN_PURCHASE transactions (real user INR→token purchases).
// EXCLUDES merchant funding (MERCHANT_TOPUP / MERCHANT_RESERVE / MERCHANT_LIQUIDITY).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/analytics/deposit-dashboard', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { Transaction } = getModels();
    const { startDate, endDate } = req.query;

    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate)   dateFilter.$lte = new Date(endDate);
    const match = {
      type:   'TOKEN_PURCHASE',
      status: 'SUCCESS',
      ...(Object.keys(dateFilter).length && { timestamp: dateFilter }),
    };

    const [agg, daily] = await Promise.all([
      Transaction.aggregate([
        { $match: match },
        { $group: {
          _id:           null,
          totalINR:      { $sum: { $multiply: ['$amount', { $ifNull: ['$rateUsed', 1] }] } },
          totalTokens:   { $sum: '$amount' },
          uniqueBuyers:  { $addToSet: '$userId' },
          count:         { $sum: 1 },
        }},
      ]),
      Transaction.aggregate([
        { $match: match },
        { $group: {
          _id:    { $dateToString: { format: '%Y-%m-%d', date: '$timestamp', timezone: '+05:30' } },
          tokens: { $sum: '$amount' },
          count:  { $sum: 1 },
        }},
        { $sort: { _id: 1 } },
      ]),
    ]);

    const summary = agg[0] || { totalINR: 0, totalTokens: 0, uniqueBuyers: [], count: 0 };
    res.json({
      success: true,
      data: {
        totalINRDeposited:    summary.totalINR    || 0,
        totalTokensPurchased: summary.totalTokens || 0,
        numberOfBuyers:       (summary.uniqueBuyers || []).length,
        transactionCount:     summary.count        || 0,
        dailyBreakdown:       daily,
      },
    });
  } catch (err) {
    console.error('[deposit-dashboard]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/analytics/withdrawal-dashboard
// Shows ONLY TOKEN_REDEMPTION transactions (real user token→INR sells).
// EXCLUDES merchant reserve/liquidity movements.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/analytics/withdrawal-dashboard', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { Transaction } = getModels();
    const { startDate, endDate } = req.query;

    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate)   dateFilter.$lte = new Date(endDate);
    const match = {
      type:   'TOKEN_REDEMPTION',
      status: { $in: ['SUCCESS', 'PENDING'] },
      ...(Object.keys(dateFilter).length && { timestamp: dateFilter }),
    };

    const [agg, daily] = await Promise.all([
      Transaction.aggregate([
        { $match: match },
        { $group: {
          _id:           null,
          totalTokens:   { $sum: '$amount' },
          totalINR:      { $sum: { $multiply: ['$amount', { $ifNull: ['$rateUsed', 1] }] } },
          uniqueSellers: { $addToSet: '$userId' },
          count:         { $sum: 1 },
        }},
      ]),
      Transaction.aggregate([
        { $match: match },
        { $group: {
          _id:    { $dateToString: { format: '%Y-%m-%d', date: '$timestamp', timezone: '+05:30' } },
          tokens: { $sum: '$amount' },
          count:  { $sum: 1 },
        }},
        { $sort: { _id: 1 } },
      ]),
    ]);

    const summary = agg[0] || { totalTokens: 0, totalINR: 0, uniqueSellers: [], count: 0 };
    res.json({
      success: true,
      data: {
        totalTokensSold:    summary.totalTokens     || 0,
        totalINRWithdrawn:  summary.totalINR        || 0,
        numberOfSellers:    (summary.uniqueSellers || []).length,
        transactionCount:   summary.count           || 0,
        dailyBreakdown:     daily,
      },
    });
  } catch (err) {
    console.error('[withdrawal-dashboard]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/analytics/merchant-funding
// Shows ONLY MERCHANT_TOPUP / MERCHANT_RESERVE / MERCHANT_LIQUIDITY.
// Completely separate from user deposit/withdrawal dashboards.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/analytics/merchant-funding', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { Transaction } = getModels();
    const Merchant = mongoose.model('Merchant');

    const agg = await Transaction.aggregate([
      { $match: { type: { $in: ['MERCHANT_TOPUP', 'MERCHANT_RESERVE', 'MERCHANT_LIQUIDITY'] } } },
      { $group: {
        _id:    '$type',
        total:  { $sum: '$amount' },
        count:  { $sum: 1 },
      }},
    ]);

    const byType = Object.fromEntries(agg.map(a => [a._id, { total: a.total, count: a.count }]));
    const activeMerchants = await Merchant.countDocuments({ merchantApprovalStatus: 'APPROVED' });

    res.json({
      success: true,
      data: {
        merchantTopup:     byType['MERCHANT_TOPUP']     || { total: 0, count: 0 },
        merchantReserve:   byType['MERCHANT_RESERVE']   || { total: 0, count: 0 },
        merchantLiquidity: byType['MERCHANT_LIQUIDITY'] || { total: 0, count: 0 },
        activeMerchants,
      },
    });
  } catch (err) {
    console.error('[merchant-funding]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
