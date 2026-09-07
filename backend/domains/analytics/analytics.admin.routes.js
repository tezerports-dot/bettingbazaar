// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * analytics.admin.routes.js — the dashboard, financial analytics, token flow.
 *
 * GET /stats was removed here: it was a SECOND platform-summary endpoint over
 * the same db.stats.* functions /analytics/dashboard already calls, no panel
 * called it, and two summaries of one platform are two answers waiting to
 * disagree. §1 — one owner per value.
 */
import { express, authenticate, isAdmin, isAdminOrSubAdmin } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
// Analytics Platform trends (Phase 012 — Enterprise Services tier)
import { growthTrend, businessTrend, revenueTrend, riskTrend } from './analyticsPlatform.service.js';

const router = express.Router();

/**
 * One direction of token flow, with the query string's window applied.
 *
 * The deposit and withdrawal dashboards were two near-identical handlers whose
 * only difference was a transaction type; they are one function and two
 * response shapes now.
 */
async function tokenFlowFor(direction, query = {}) {
  const from = query.startDate ? new Date(query.startDate) : null;
  const to   = query.endDate   ? new Date(query.endDate)   : null;
  // An unparseable date used to become `Invalid Date` and match nothing, so a
  // typo in the admin's date picker showed an empty dashboard rather than an
  // error. It is rejected here instead.
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
    throw new Error('startDate and endDate must be dates');
  }
  return db.stats.tokenFlow({ direction, from, to });
}

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

/**
 * The admin dashboard.
 *
 * ── What it was reading ─────────────────────────────────────────────────────
 * Twelve separate aggregates over a `transactions` collection nothing has
 * written to since the money moved to PostgreSQL. Every finance figure on this
 * page was a frozen total from before the migration, and the page reported them
 * with no indication that they had stopped moving.
 *
 * Each panel below is now one statement over the rows that actually carry the
 * thing it counts, so the figures within a panel cannot contradict each other.
 */
router.get('/analytics/dashboard', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const [core, finance, daily, counts] = await Promise.all([
      db.stats.dashboard(),
      db.stats.platformFinance({}),
      db.stats.dailyFinance({ days: 7 }),
      db.stats.cycleAndQueueCounts({}),
    ]);

    // Today is the last bucket of the seven-day series, not a thirteenth query
    // with its own idea of when today started. The route this replaced computed
    // its day boundary from the SERVER's local midnight while bucketing the
    // series in IST, so on a UTC host the two disagreed by five and a half
    // hours and "today" on the tiles never matched "today" on the chart.
    const today = daily[daily.length - 1] ?? { bets: 0, betCount: 0, payouts: 0, deposits: 0, netProfit: 0 };

    res.json({
      success: true,
      metrics: {
        users: {
          total: core.users.total, active: core.users.active,
          blocked: core.users.blocked, kycPending: core.users.pendingKYC,
        },
        merchants: {
          total: core.merchants.total, active: core.merchants.active,
          pending: core.merchants.pendingApproval, online: core.merchants.active,
        },
        finance: {
          totalDeposits:    finance.deposits.amount,
          totalWithdrawals: finance.withdrawals.amount,
          totalBets:        finance.bets.amount,
          totalPayouts:     finance.payouts.amount,
          netProfit:        finance.netProfit,
          today: {
            bets: today.bets, betCount: today.betCount,
            payouts: today.payouts, deposits: today.deposits,
            netProfit: today.netProfit,
          },
        },
        cycles: { ...counts.cycles, totalBets: core.betting.totalBets },
        queue: { pendingOrders: counts.queue.pendingOrders, avgWaitTime: 0 },
        dailyReport: daily,
      },
    });
  } catch (error) {
    console.error('Dashboard metrics error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch dashboard metrics' });
  }
});

/**
 * Financial analytics over an optional date window.
 *
 * `profitMargin` divides by deposits, and deposits of zero would make it
 * Infinity — the guard is kept from the original. The rest is derived from the
 * order and bet rows rather than from the abandoned transaction collection.
 */
router.get('/analytics/financials', authenticate, isAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const from = startDate ? new Date(startDate) : null;
    const to   = endDate   ? new Date(endDate)   : null;
    if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
      return res.status(400).json({ success: false, message: 'startDate and endDate must be dates' });
    }

    const [finance, byProvider] = await Promise.all([
      db.stats.platformFinance({ from, to }),
      db.stats.providerRevenue({ from, to }),
    ]);

    res.json({
      success: true,
      data: {
        totalRevenue:  finance.deposits.amount + finance.bets.amount,
        totalExpenses: finance.withdrawals.amount + finance.payouts.amount,
        netProfit:     finance.netProfit,
        profitMargin:  finance.deposits.amount > 0
          ? (finance.netProfit / finance.deposits.amount) * 100 : 0,
        deposits:    finance.deposits,
        withdrawals: finance.withdrawals,
        bets:        finance.bets,
        payouts:     finance.payouts,
        byProvider,
      },
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

// ─────────────────────────────────────────────────────────────────────────────
router.get('/analytics/deposit-dashboard', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const flow = await tokenFlowFor('DEPOSIT', req.query);
    res.json({
      success: true,
      data: {
        totalINRDeposited:    flow.fiat,
        totalTokensPurchased: flow.tokens,
        numberOfBuyers:       flow.parties,
        transactionCount:     flow.orders,
        dailyBreakdown:       flow.daily,
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
    const flow = await tokenFlowFor('WITHDRAWAL', req.query);
    res.json({
      success: true,
      data: {
        totalTokensSold:   flow.tokens,
        totalINRWithdrawn: flow.fiat,
        numberOfSellers:   flow.parties,
        transactionCount:  flow.orders,
        dailyBreakdown:    flow.daily,
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
    // Merchant funding is merchant WALLET movement, which is where it has
    // always actually been recorded. The aggregate this replaced grouped a
    // player transaction collection by three type strings that were never
    // written to it, so all three tiles read zero on a platform that had funded
    // merchants every day.
    const [funding, merchants] = await Promise.all([
      db.merchantWallets.fundingTotals(),
      db.stats.merchantStats(),
    ]);
    res.json({
      success: true,
      data: {
        merchantTopup:     funding.topup,
        merchantReserve:   funding.reserve,
        merchantLiquidity: funding.liquidity,
        activeMerchants:   merchants.total,
      },
    });
  } catch (err) {
    console.error('[merchant-funding]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
