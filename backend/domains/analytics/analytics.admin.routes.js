// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * analytics.admin.routes.js — the dashboard, financial analytics, token flow.
 *
 * GET /stats was removed here: it was a SECOND platform-summary endpoint over
 * the same db.stats.* functions /analytics/dashboard already calls, no panel
 * called it, and two summaries of one platform are two answers waiting to
 * disagree. §1 — one owner per value.
 */
import {
  authenticate, express, hasPermission,
} from '../../routes/admin/_adminShared.js';
import { db } from '#db';
// Analytics Platform trends (Phase 012 — Enterprise Services tier)
import { growthTrend, businessTrend, revenueTrend, riskTrend } from './analyticsPlatform.service.js';
import { serverError, respondError, refusal } from '../../shared/httpError.js';
import { toCsv } from '../reporting/csv.util.js';
import { paiseToRupees } from '../../shared/money.js';

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
router.get('/analytics/trends', authenticate, hasPermission('canViewAnalytics'), async (req, res) => {
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
// The analytics group, every other route of which derives this from the
// screens that show it.
router.get('/analytics/dashboard', authenticate, hasPermission('canViewAnalytics'), async (req, res) => {
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
          blocked: core.users.blocked,
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

/** `YYYY-MM-DD` (an IST calendar day) or null; anything else is a 400. */
function istDay(v, name) {
  if (v == null || v === '') return null;
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
    throw refusal(400, 'BAD_DATE', `${name} must be a date (YYYY-MM-DD).`);
  }
  return s;
}

const pnlWindow = (q) => ({ from: istDay(q.startDate, 'startDate'), to: istDay(q.endDate, 'endDate') });

/**
 * Profit & Loss over the IST days startDate..endDate, both inclusive
 * (`stats.profitAndLoss`): revenue is what the house kept (board games and
 * casino), costs are bonuses and team commission, and deposits and
 * withdrawals are shown apart as money flow, never as revenue.
 */
router.get('/analytics/financials', authenticate, hasPermission('canViewAnalytics'), async (req, res) => {
  try {
    const window = pnlWindow(req.query);
    const [pnl, byProvider] = await Promise.all([
      db.stats.profitAndLoss(window),
      db.stats.providerRevenue({
        from: window.from ? new Date(`${window.from}T00:00:00+05:30`) : null,
        to: window.to ? new Date(new Date(`${window.to}T00:00:00+05:30`).getTime() + 86_400_000 - 1) : null,
      }),
    ]);
    res.json({ success: true, data: { ...pnl, byProvider } });
  } catch (error) {
    respondError(res, error, 'GET /admin/analytics/financials', { message: 'Failed to fetch financial data' });
  }
});

/** The same P&L as CSV, one line per item. */
router.get('/analytics/financials.csv', authenticate, hasPermission('canViewAnalytics'), async (req, res) => {
  try {
    const window = pnlWindow(req.query);
    const p = await db.stats.profitAndLoss(window);
    const line = (section, item, amount, count = '') => ({ section, item, amount, count });
    const csv = toCsv([
      line('Revenue', 'Board games: settled stakes', p.revenue.boardGames.settledStakes, p.revenue.boardGames.bets),
      line('Revenue', 'Board games: paid to winners', -p.revenue.boardGames.payouts, p.revenue.boardGames.wins),
      line('Revenue', 'Board games: kept', p.revenue.boardGames.amount),
      line('Revenue', 'of which winnings fee', p.revenue.winningsFees),
      line('Revenue', 'Casino games: kept', p.revenue.casino),
      line('Revenue', 'Total revenue', p.revenue.total),
      line('Costs', 'Referral bonuses', p.costs.referralBonuses.amount, p.costs.referralBonuses.count),
      line('Costs', 'First deposit bonuses', p.costs.firstDepositBonuses.amount, p.costs.firstDepositBonuses.count),
      line('Costs', 'Team commission', p.costs.teamCommission.amount, p.costs.teamCommission.count),
      line('Costs', 'Total costs', p.costs.total),
      line('Result', 'Net profit', p.netProfit),
      line('Not yet earned', 'Stakes still riding', p.openStakes),
      line('Money flow (not revenue)', 'Deposits', p.moneyFlow.deposits.amount, p.moneyFlow.deposits.count),
      line('Money flow (not revenue)', 'Withdrawals', p.moneyFlow.withdrawals.amount, p.moneyFlow.withdrawals.count),
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="profit-loss-${window.from || 'start'}-${window.to || 'now'}.csv"`);
    res.send(csv);
  } catch (error) {
    respondError(res, error, 'GET /admin/analytics/financials.csv', { message: 'Could not build the export.' });
  }
});

/**
 * The token supply (20 billion) and how much of it each kind of holder has
 * (`tokenHolders`): totals only, no individual account, so analytics is
 * enough to read it.
 */
router.get('/analytics/token-supply', authenticate, hasPermission('canViewAnalytics'), async (req, res) => {
  try {
    const t = await db.tokenHolders.tokenHolders({ limit: 1 });
    res.json({ success: true, supply: t.supply, accounted: t.accounted, accountedFor: t.accountedFor, kinds: t.kinds });
  } catch (error) {
    respondError(res, error, 'GET /admin/analytics/token-supply', { message: 'Could not read the token supply.' });
  }
});

/**
 * Every holder, largest first, with the same totals. Names each player and
 * their balance, so it asks the players area (canManageUsers), as the users
 * list does.
 */
router.get('/analytics/token-holders', authenticate, hasPermission('canManageUsers'), async (req, res) => {
  try {
    const { kind, search, page = 1, limit = 50 } = req.query;
    const t = await db.tokenHolders.tokenHolders({ kind, search, page, limit });
    res.json({
      success: true, ...t,
      pagination: { total: t.total, page: t.page, limit: t.limit, pages: Math.max(Math.ceil(t.total / t.limit), 1) },
    });
  } catch (error) {
    respondError(res, error, 'GET /admin/analytics/token-holders', { message: 'Could not read the token holders.' });
  }
});

router.get('/analytics/token-holders.csv', authenticate, hasPermission('canManageUsers'), async (req, res) => {
  try {
    const { kind, search } = req.query;
    const t = await db.tokenHolders.tokenHolders({ kind, search, exportAll: true });
    const csv = toCsv(t.holders.map((h) => ({
      kind: h.kind,
      holder_id: h.holderId,
      name: h.name,
      supervisor_or_owner: h.owner || '',
      approved_members: h.members ?? '',
      tokens: h.tokens,
      held_or_riding: h.held,
      share_of_supply_percent: h.sharePercent,
    })));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="token-holders-${kind || 'all'}.csv"`);
    res.send(csv);
  } catch (error) {
    respondError(res, error, 'GET /admin/analytics/token-holders.csv', { message: 'Could not build the export.' });
  }
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 👥 USER MANAGEMENT
 * ════════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────────
router.get('/analytics/deposit-dashboard', authenticate, hasPermission('canViewAnalytics'), async (req, res) => {
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
    return serverError(res, err, 'GET /analytics/deposit-dashboard');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/analytics/withdrawal-dashboard
// Shows ONLY TOKEN_REDEMPTION transactions (real user token→INR sells).
// EXCLUDES merchant reserve/liquidity movements.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/analytics/withdrawal-dashboard', authenticate, hasPermission('canViewAnalytics'), async (req, res) => {
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
    return serverError(res, err, 'GET /analytics/withdrawal-dashboard');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/analytics/merchant-funding
// What the platform received and paid for team pool tokens. Separate from the
// user deposit/withdrawal dashboards.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/analytics/merchant-funding', authenticate, hasPermission('canViewAnalytics'), async (req, res) => {
  try {
    // Merchants hold no tokens any more (PROJECT_STATUS §3.10 2c): a team's
    // pool does, and every pool movement is a supervisor's request fulfilled
    // with what the platform received or paid. So the funding picture is the
    // money side of those movements, plus the merchant count.
    const [merchants, trade] = await Promise.all([
      db.stats.merchantStats(),
      db.adminTokenConsiderations.platformConsiderationTotals(),
    ]);
    res.json({
      success: true,
      data: {
        activeMerchants:   merchants.total,
        // Rupees. `receivedInr` is the INR-EQUIVALENT across every settlement
        // currency and is the only figure that may be added up; `byCurrency`
        // keeps what merchants actually sent apart, because summing 500 USDT
        // with 500 INR as 1,000 of anything is trap 15.
        tokenTrade: {
          receivedInr:      paiseToRupees(trade.receivedInrPaise),
          paidInr:          paiseToRupees(trade.paidInrPaise),
          netInr:           paiseToRupees(trade.netInrPaise),
          tokensSold:       paiseToRupees(trade.tokensSoldPaise),
          tokensBoughtBack: paiseToRupees(trade.tokensBoughtBackPaise),
          movements:        trade.movements,
          byCurrency:       Object.fromEntries(
            Object.entries(trade.byCurrency).map(([code, v]) => [code, {
              received:  paiseToRupees(v.receivedMinor),
              paid:      paiseToRupees(v.paidMinor),
              movements: v.movements,
            }]),
          ),
        },
      },
    });
  } catch (err) {
    console.error('[merchant-funding]', err.message);
    return serverError(res, err, 'GET /analytics/merchant-funding');
  }
});

export default router;
