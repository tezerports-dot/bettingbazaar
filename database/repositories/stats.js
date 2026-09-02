// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * repositories/stats.js — the aggregates the admin panels read.
 *
 * ── Why these are queries and not counters ──────────────────────────────────
 * Every figure here is COMPUTED FROM ROWS at the moment it is asked for. None
 * of them is a stored total that something increments.
 *
 * That is the rule for counters throughout this folder, and it is worth the
 * cost here specifically: a stored total counts PASSES rather than rows, so a
 * crash between the money moving and the total being bumped leaves the money
 * correct and the dashboard permanently wrong — with no way to tell which
 * number is the lie. Recomputing is a few milliseconds against an index and
 * cannot drift.
 *
 * ── One statement per panel, not one per figure ─────────────────────────────
 * The document version issued twelve queries for one dashboard, each seeing the
 * database at a slightly different moment, so the numbers could contradict each
 * other — an active-user count taken after a block was applied, beside a
 * blocked count taken before. `FILTER (WHERE …)` gathers a panel's figures in
 * ONE pass over ONE snapshot.
 */
import { pgQuery } from '../client.js';
import { paiseToRupees } from '../../backend/shared/money.js';

const rupees = (v) => paiseToRupees(Number(v ?? 0));
const int = (v) => Number(v ?? 0);

/**
 * The admin dashboard, in four statements — one per subject area, each
 * internally consistent.
 */
export async function dashboard() {
  const [users, merchants, betting, operations] = await Promise.all([
    userStats(), merchantStats(), bettingStats(), operationStats(),
  ]);
  return { users, merchants, betting, operations };
}

export async function userStats() {
  const { rows } = await pgQuery(
    `SELECT
       COUNT(*)::int                                                        AS total,
       COUNT(*) FILTER (WHERE status = 'ACTIVE' AND NOT is_blocked)::int    AS active,
       COUNT(*) FILTER (WHERE is_blocked)::int                              AS blocked,
       COUNT(*) FILTER (WHERE kyc_status = 'PENDING_APPROVAL')::int         AS pending_kyc,
       COUNT(*) FILTER (WHERE joined_at >= CURRENT_DATE)::int               AS today,
       COUNT(*) FILTER (WHERE is_admin)::int                                AS admins,
       COUNT(*) FILTER (WHERE is_sub_admin)::int                            AS sub_admins
     FROM users`, [], 'stats_users',
  );
  const r = rows[0];
  return {
    total: r.total, active: r.active, blocked: r.blocked,
    pendingKYC: r.pending_kyc, today: r.today,
    admins: r.admins, subAdmins: r.sub_admins,
  };
}

export async function merchantStats() {
  const { rows } = await pgQuery(
    `SELECT
       COUNT(*)::int                                                     AS total,
       COUNT(*) FILTER (WHERE status = 'ACTIVE' AND is_online)::int      AS active,
       COUNT(*) FILTER (WHERE status = 'SUSPENDED')::int                 AS suspended,
       COUNT(*) FILTER (WHERE merchant_approval_status = 'PENDING')::int AS pending_approval,
       COUNT(*) FILTER (WHERE merchant_type = 'INR')::int                AS inr,
       COUNT(*) FILTER (WHERE merchant_type = 'USDT')::int               AS usdt
     FROM merchants`, [], 'stats_merchants',
  );
  const r = rows[0];
  return {
    total: r.total, active: r.active, suspended: r.suspended,
    pendingApproval: r.pending_approval, inr: r.inr, usdt: r.usdt,
  };
}

/** Bet counts and staked volume. Volume is summed in paise and shown in rupees. */
export async function bettingStats() {
  const { rows } = await pgQuery(
    `SELECT
       COUNT(*)::int                                          AS total_bets,
       COUNT(*) FILTER (WHERE placed_at >= CURRENT_DATE)::int  AS today_bets,
       COALESCE(SUM(stake_paise), 0)                          AS total_volume,
       COALESCE(SUM(stake_paise) FILTER (WHERE placed_at >= CURRENT_DATE), 0) AS today_volume,
       COUNT(*) FILTER (WHERE status = 'WON')::int             AS won,
       COUNT(*) FILTER (WHERE status = 'LOST')::int            AS lost,
       COALESCE(SUM(payout_paise), 0)                          AS total_paid_out
     FROM bets`, [], 'stats_betting',
  );
  const r = rows[0];
  return {
    totalBets: r.total_bets, todayBets: r.today_bets,
    totalVolume: rupees(r.total_volume), todayVolume: rupees(r.today_volume),
    won: r.won, lost: r.lost, totalPaidOut: rupees(r.total_paid_out),
  };
}

export async function operationStats() {
  const { rows } = await pgQuery(
    `SELECT
       COUNT(*) FILTER (WHERE state IN ('ASSIGNED', 'PROCESSING'))::int AS pending_orders,
       COUNT(*) FILTER (WHERE state = 'PENDING_QUEUE')::int             AS queued_orders,
       COUNT(*) FILTER (WHERE state = 'DISPUTED')::int                  AS active_disputes,
       COUNT(*) FILTER (WHERE red_flagged AND state <> 'COMPLETED')::int AS flagged,
       COUNT(*) FILTER (WHERE requires_review)::int                     AS awaiting_review
     FROM order_states`, [], 'stats_operations',
  );
  const r = rows[0];
  return {
    pendingOrders: r.pending_orders, queuedOrders: r.queued_orders,
    activeDisputes: r.active_disputes, flagged: r.flagged,
    awaitingReview: r.awaiting_review,
  };
}

/**
 * One player's activity totals — what an admin sees on their profile.
 *
 * One statement per table rather than one per figure, for the same reason as
 * the dashboard: two counts taken a moment apart can contradict each other, and
 * a support agent reading them cannot tell which is stale.
 */
export async function userActivity(userId) {
  const uid = String(userId);
  const [bets, orders, ledger] = await Promise.all([
    pgQuery(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(stake_paise), 0) AS staked,
              COALESCE(SUM(payout_paise), 0) AS won
         FROM bets WHERE user_id = $1`, [uid], 'stats_user_bets'),
    pgQuery(
      `SELECT COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE state = 'COMPLETED')::int AS completed,
              COUNT(*) FILTER (WHERE state IN ('ASSIGNED','PROCESSING','PAID'))::int AS open,
              COALESCE(SUM(token_amount_paise) FILTER (WHERE state = 'COMPLETED' AND order_type = 'DEPOSIT'), 0) AS deposited,
              COALESCE(SUM(token_amount_paise) FILTER (WHERE state = 'COMPLETED' AND order_type = 'WITHDRAWAL'), 0) AS withdrawn
         FROM order_states WHERE user_id = $1`, [uid], 'stats_user_orders'),
    pgQuery(
      'SELECT COUNT(*)::int AS n FROM wallet_ledger WHERE user_id = $1', [uid], 'stats_user_ledger'),
  ]);
  return {
    totalBets: bets.rows[0].n,
    totalStaked: rupees(bets.rows[0].staked),
    totalWon: rupees(bets.rows[0].won),
    totalOrders: orders.rows[0].n,
    completedOrders: orders.rows[0].completed,
    openOrders: orders.rows[0].open,
    totalDeposited: rupees(orders.rows[0].deposited),
    totalWithdrawn: rupees(orders.rows[0].withdrawn),
    totalTransactions: ledger.rows[0].n,
  };
}

/**
 * Money movement per day, by kind.
 *
 * `date_trunc` in the query rather than grouping in the application: pulling
 * every row back to bucket it in JavaScript is the same work done further from
 * the data, and it fails on the day the table is large enough to matter.
 */
export async function financialSeries({ from, to }) {
  const { rows } = await pgQuery(
    `SELECT date_trunc('day', created_at)::date AS day,
            tx_type,
            COUNT(*)::int AS count,
            COALESCE(SUM(ABS(amount_paise)), 0) AS total
       FROM wallet_ledger
      WHERE created_at >= $1 AND created_at <= $2
      GROUP BY 1, 2
      ORDER BY 1 ASC`,
    [from, to], 'stats_financial_series',
  );
  return rows.map((r) => ({
    date: r.day, type: r.tx_type, count: r.count, totalAmount: rupees(r.total),
  }));
}

/** Staked and paid out per day — the betting half of the same picture. */
export async function bettingSeries({ from, to }) {
  const { rows } = await pgQuery(
    `SELECT date_trunc('day', placed_at)::date AS day,
            COUNT(*)::int AS bets,
            COALESCE(SUM(stake_paise), 0)  AS staked,
            COALESCE(SUM(payout_paise), 0) AS paid_out
       FROM bets
      WHERE placed_at >= $1 AND placed_at <= $2
      GROUP BY 1 ORDER BY 1 ASC`,
    [from, to], 'stats_betting_series',
  );
  return rows.map((r) => ({
    date: r.day, bets: r.bets,
    staked: rupees(r.staked), paidOut: rupees(r.paid_out),
  }));
}

/**
 * The players who staked the most in a window — the leaderboard's source.
 *
 * Ranked on `bets`, which is where a stake actually is. A stored per-user total
 * would be a second copy of this number waiting to disagree with it.
 */
export async function topPlayers({ from = null, to = null, limit = 20 } = {}) {
  const where = [];
  const params = [];
  if (from) { params.push(from); where.push(`placed_at >= $${params.length}`); }
  if (to) { params.push(to); where.push(`placed_at <= $${params.length}`); }
  const { rows } = await pgQuery(
    `SELECT user_id,
            COUNT(*)::int AS bets,
            COALESCE(SUM(stake_paise), 0)  AS staked,
            COALESCE(SUM(payout_paise), 0) AS won
       FROM bets ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY user_id
      ORDER BY staked DESC
      LIMIT ${Math.min(Math.max(Number(limit) || 20, 1), 200)}`,
    params, 'stats_top_players',
  );
  return rows.map((r) => ({
    userId: r.user_id, bets: r.bets,
    staked: rupees(r.staked), won: rupees(r.won),
    net: rupees(Number(r.won) - Number(r.staked)),
  }));
}

/**
 * The leaderboard, computed from settled bets.
 *
 * ── Three things the document aggregate got wrong ───────────────────────────
 * 1. It summed `betAmount` on winning bets and called the result `totalWon` —
 *    the amount STAKED on bets that won, not the amount won. The leaderboard
 *    then showed it in a column labelled winnings.
 * 2. It computed `winRate` as `totalWon / totalBets * 100`: rupees divided by a
 *    count. A player with one ₹5,000 winning bet ranked at 500,000% and the
 *    figure was rendered as a percentage.
 * 3. It ranked on every bet including PENDING ones, whose payout is zero, so an
 *    open position dragged a player down the board until it settled and then
 *    jumped them back up.
 *
 * Only SETTLED bets count. A pending bet has no outcome yet, and VOID and
 * REFUNDED ones never had one — including them would let a player improve
 * their standing by placing bets that get cancelled.
 *
 * The username comes from a JOIN. The document version fetched the top fifty
 * ids and then looked each one up, matching them in JavaScript with
 * `users.find(...)` inside the map — fifty linear scans, and a silent 'Player'
 * for anyone the second query missed.
 */
export async function leaderboard({ since = null, limit = 50 } = {}) {
  const params = [];
  const where = ["b.status IN ('WON', 'LOST')"];
  if (since) { params.push(since); where.push(`b.settled_at >= $${params.length}`); }
  const { rows } = await pgQuery(
    `SELECT b.user_id,
            COALESCE(u.username, 'Player')                      AS username,
            COUNT(*)::int                                       AS bets,
            COUNT(*) FILTER (WHERE b.status = 'WON')::int       AS wins,
            COALESCE(SUM(b.stake_paise), 0)                     AS staked,
            COALESCE(SUM(b.payout_paise), 0)                    AS won,
            COALESCE(SUM(b.payout_paise) - SUM(b.stake_paise), 0) AS net
       FROM bets b
       LEFT JOIN users u ON u.user_id = b.user_id
      WHERE ${where.join(' AND ')}
      GROUP BY b.user_id, u.username
      ORDER BY net DESC, staked DESC
      LIMIT ${Math.min(Math.max(Number(limit) || 50, 1), 500)}`,
    params, 'stats_leaderboard',
  );
  return rows.map((r, i) => ({
    rank: i + 1,
    userId: r.user_id,
    username: r.username,
    totalBets: r.bets,
    wins: r.wins,
    totalStaked: rupees(r.staked),
    totalWon: rupees(r.won),
    netProfit: rupees(r.net),
    // A share of settled bets, which is what the word means.
    winRate: r.bets ? Math.round((r.wins / r.bets) * 100) : 0,
  }));
}

/**
 * Per-merchant funding and bonus activity over a period.
 *
 * ── One query, and a merchant with only bonuses still appears ───────────────
 * The document version ran an order aggregate, a bonus aggregate and a scan of
 * every merchant on the platform, then merged them into a keyed object by
 * mutating rows in two loops. A merchant who received a bonus in the period but
 * completed no orders got a row from the second loop with the first loop's
 * fields defaulted — which worked, and is exactly the kind of thing that stops
 * working when somebody adds a third source and forgets one of the loops.
 *
 * A FULL OUTER JOIN says it once: a merchant appears if either side has
 * anything for them.
 */
export async function merchantActivityReport({ from = null, to = null } = {}) {
  const params = [];
  const orderWhere = ["state = 'COMPLETED'", 'merchant_id IS NOT NULL'];
  const bonusWhere = ["e.event_type = 'MERCHANT_BONUS_ISSUED'"];
  if (from) {
    params.push(new Date(from));
    orderWhere.push(`completed_at >= $${params.length}`);
    bonusWhere.push(`e.created_at >= $${params.length}`);
  }
  if (to) {
    params.push(new Date(to));
    orderWhere.push(`completed_at <= $${params.length}`);
    bonusWhere.push(`e.created_at <= $${params.length}`);
  }

  const { rows } = await pgQuery(
    `WITH orders AS (
       SELECT merchant_id,
              COUNT(*) FILTER (WHERE order_type = 'DEPOSIT')::int    AS deposits,
              COALESCE(SUM(fiat_amount_paise) FILTER (WHERE order_type = 'DEPOSIT'), 0)    AS deposit_volume,
              COUNT(*) FILTER (WHERE order_type = 'WITHDRAWAL')::int AS withdrawals,
              COALESCE(SUM(fiat_amount_paise) FILTER (WHERE order_type = 'WITHDRAWAL'), 0) AS withdrawal_volume
         FROM order_states
        WHERE ${orderWhere.join(' AND ')}
        GROUP BY merchant_id
     ), bonuses AS (
       SELECT e.ref_id AS merchant_id,
              COUNT(DISTINCT e.id)::int AS issuances,
              COALESCE(SUM(ABS((p->>'amountPaise')::BIGINT)), 0) AS bonus_paise
         FROM accounting_events e
         CROSS JOIN LATERAL jsonb_array_elements(e.postings) p
        WHERE ${bonusWhere.join(' AND ')} AND p->>'account' = 'MERCHANT_FUNDS'
        GROUP BY e.ref_id
     )
     SELECT COALESCE(o.merchant_id, b.merchant_id) AS merchant_id,
            COALESCE(m.username, m.name, 'unknown') AS username,
            COALESCE(o.deposits, 0)          AS deposits,
            COALESCE(o.deposit_volume, 0)    AS deposit_volume,
            COALESCE(o.withdrawals, 0)       AS withdrawals,
            COALESCE(o.withdrawal_volume, 0) AS withdrawal_volume,
            COALESCE(b.issuances, 0)         AS bonuses,
            COALESCE(b.bonus_paise, 0)       AS bonus_paise
       FROM orders o
       FULL OUTER JOIN bonuses b ON b.merchant_id = o.merchant_id
       LEFT JOIN merchants m ON m.merchant_id = COALESCE(o.merchant_id, b.merchant_id)
      ORDER BY (COALESCE(o.deposit_volume, 0) + COALESCE(o.withdrawal_volume, 0)) DESC`,
    params, 'stats_merchant_activity_report',
  );

  return rows.map((r) => ({
    merchantId: r.merchant_id,
    username: r.username,
    deposits: r.deposits,
    depositVolume: rupees(r.deposit_volume),
    withdrawals: r.withdrawals,
    withdrawalVolume: rupees(r.withdrawal_volume),
    bonuses: r.bonuses,
    bonusTotal: rupees(r.bonus_paise),
  }));
}

// ── Platform trends ─────────────────────────────────────────────────────────
//
// Day-bucketed, chart-ready, all derived. Every one of these cuts its days in
// the platform's own timezone and fills the gaps with `generate_series`.
//
// ── Why the gap-filling matters more than it looks ──────────────────────────
// The document aggregates emitted only days that HAD activity. A chart drawn
// from that draws a straight line across a quiet weekend — so an outage looks
// like a gentle slope rather than a cliff, and the day the deposits stopped is
// invisible. A zero is a fact; a missing day is an absence of one.

/** The day series a trend is drawn on, in the platform's timezone. */
const DAY_SPAN = `
  SELECT generate_series(
    (CAST(now() AT TIME ZONE $1 AS DATE) - ($2::int - 1)),
    CAST(now() AT TIME ZONE $1 AS DATE),
    '1 day'::interval
  )::date AS day`;

const isoDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));
const spanOf = (days) => Math.min(Math.max(Number(days) || 30, 1), 365);

/** Growth: daily new registrations and first-time depositors. */
export async function growthTrend({ days = 30, timezone = 'Asia/Kolkata' } = {}) {
  const span = spanOf(days);
  const { rows } = await pgQuery(
    `WITH span AS (${DAY_SPAN}), signups AS (
       -- joined_at, not created_at: the users table names the column for what
       -- it records, and the aggregate this replaced was written against the
       -- document field name.
       SELECT CAST(joined_at AT TIME ZONE $1 AS DATE) AS day, COUNT(*)::int AS n
         FROM users GROUP BY 1
     ), first_deposits AS (
       -- The FIRST completed deposit per player. DISTINCT ON picks it in one
       -- pass; the document version sorted every completed deposit on the
       -- platform and took the first of each group to get the same answer.
       SELECT CAST(first_at AT TIME ZONE $1 AS DATE) AS day, COUNT(*)::int AS n
         FROM (
           SELECT DISTINCT ON (user_id) user_id, completed_at AS first_at
             FROM order_states
            WHERE order_type = 'DEPOSIT' AND state = 'COMPLETED' AND completed_at IS NOT NULL
            ORDER BY user_id, completed_at ASC
         ) f
        GROUP BY 1
     )
     SELECT s.day, COALESCE(g.n, 0) AS signups, COALESCE(d.n, 0) AS first_depositors
       FROM span s
       LEFT JOIN signups g ON g.day = s.day
       LEFT JOIN first_deposits d ON d.day = s.day
      ORDER BY s.day`,
    [timezone, span], 'stats_growth_trend',
  );
  return {
    signups: rows.map((r) => ({ day: isoDay(r.day), count: Number(r.signups) })),
    firstTimeDepositors: rows.map((r) => ({ day: isoDay(r.day), count: Number(r.first_depositors) })),
  };
}

/** Business: daily betting volume and count, plus funding volume by direction. */
export async function businessTrend({ days = 30, timezone = 'Asia/Kolkata' } = {}) {
  const span = spanOf(days);
  const { rows } = await pgQuery(
    `WITH span AS (${DAY_SPAN}), betting AS (
       SELECT CAST(placed_at AT TIME ZONE $1 AS DATE) AS day,
              COUNT(*)::int AS bets,
              COALESCE(SUM(stake_paise), 0) AS volume,
              COUNT(DISTINCT user_id)::int AS bettors
         FROM bets GROUP BY 1
     ), funding AS (
       SELECT CAST(completed_at AT TIME ZONE $1 AS DATE) AS day, order_type,
              COUNT(*)::int AS orders,
              COALESCE(SUM(fiat_amount_paise), 0) AS volume
         FROM order_states
        WHERE state = 'COMPLETED' AND completed_at IS NOT NULL
        GROUP BY 1, 2
     )
     SELECT s.day,
            COALESCE(b.bets, 0)    AS bets,
            COALESCE(b.volume, 0)  AS bet_volume,
            COALESCE(b.bettors, 0) AS bettors,
            COALESCE(SUM(f.orders) FILTER (WHERE f.order_type = 'DEPOSIT'), 0)::int    AS deposits,
            COALESCE(SUM(f.volume) FILTER (WHERE f.order_type = 'DEPOSIT'), 0)         AS deposit_volume,
            COALESCE(SUM(f.orders) FILTER (WHERE f.order_type = 'WITHDRAWAL'), 0)::int AS withdrawals,
            COALESCE(SUM(f.volume) FILTER (WHERE f.order_type = 'WITHDRAWAL'), 0)      AS withdrawal_volume
       FROM span s
       LEFT JOIN betting b ON b.day = s.day
       LEFT JOIN funding f ON f.day = s.day
      GROUP BY s.day, b.bets, b.volume, b.bettors
      ORDER BY s.day`,
    [timezone, span], 'stats_business_trend',
  );
  return {
    betting: rows.map((r) => ({
      day: isoDay(r.day), bets: Number(r.bets),
      volume: rupees(r.bet_volume), uniqueBettors: Number(r.bettors),
    })),
    funding: rows.map((r) => ({
      day: isoDay(r.day),
      deposits: r.deposits, depositVolume: rupees(r.deposit_volume),
      withdrawals: r.withdrawals, withdrawalVolume: rupees(r.withdrawal_volume),
    })),
  };
}

/**
 * Revenue: daily PLATFORM_REVENUE movement from the settlement ledger.
 *
 * PLATFORM_REVENUE is a CREDIT-NORMAL account, so revenue earned arrives as a
 * negative posting and is negated here to read as a positive figure on a chart.
 * Getting that backwards renders a profitable week as a loss.
 */
export async function revenueTrend({ days = 30, timezone = 'Asia/Kolkata' } = {}) {
  const span = spanOf(days);
  const { rows } = await pgQuery(
    `WITH span AS (${DAY_SPAN}), revenue AS (
       SELECT CAST(e.created_at AT TIME ZONE $1 AS DATE) AS day,
              COALESCE(SUM(-(p->>'amountPaise')::BIGINT), 0) AS net_paise
         FROM accounting_events e
         CROSS JOIN LATERAL jsonb_array_elements(e.postings) p
        WHERE p->>'account' = 'PLATFORM_REVENUE'
        GROUP BY 1
     )
     SELECT s.day, COALESCE(r.net_paise, 0) AS net_paise
       FROM span s LEFT JOIN revenue r ON r.day = s.day
      ORDER BY s.day`,
    [timezone, span], 'stats_revenue_trend',
  );
  return rows.map((r) => ({ day: isoDay(r.day), revenue: rupees(r.net_paise) }));
}

/** Risk: daily rejected, cancelled, failed and disputed order counts. */
export async function riskTrend({ days = 30, timezone = 'Asia/Kolkata' } = {}) {
  const span = spanOf(days);
  const { rows } = await pgQuery(
    `WITH span AS (${DAY_SPAN}), risky AS (
       SELECT CAST(created_at AT TIME ZONE $1 AS DATE) AS day, state, COUNT(*)::int AS n
         FROM order_states
        WHERE state IN ('REJECTED', 'CANCELLED', 'FAILED', 'DISPUTED')
        GROUP BY 1, 2
     )
     SELECT s.day,
            COALESCE(SUM(r.n), 0)::int AS total,
            COALESCE(SUM(r.n) FILTER (WHERE r.state = 'REJECTED'), 0)::int  AS rejected,
            COALESCE(SUM(r.n) FILTER (WHERE r.state = 'CANCELLED'), 0)::int AS cancelled,
            COALESCE(SUM(r.n) FILTER (WHERE r.state = 'FAILED'), 0)::int    AS failed,
            COALESCE(SUM(r.n) FILTER (WHERE r.state = 'DISPUTED'), 0)::int  AS disputed
       FROM span s LEFT JOIN risky r ON r.day = s.day
      GROUP BY s.day ORDER BY s.day`,
    [timezone, span], 'stats_risk_trend',
  );
  return rows.map((r) => ({
    day: isoDay(r.day),
    total: r.total,
    byStatus: [
      { status: 'REJECTED', count: r.rejected },
      { status: 'CANCELLED', count: r.cancelled },
      { status: 'FAILED', count: r.failed },
      { status: 'DISPUTED', count: r.disputed },
    ],
  }));
}

// ── Merchant analytics ──────────────────────────────────────────────────────
//
// Everything here is DERIVED from source rows — orders, the merchant wallet
// ledger, the accounting events a bonus produced. Nothing is stored and nothing
// is accumulated, for the reason at the top of this file.

/**
 * Merchants ranked over a window, with the bonuses they were issued.
 *
 * ── Three queries became one ────────────────────────────────────────────────
 * The document version ran an order aggregate, a bonus aggregate and a full
 * merchant scan in parallel, then joined them in JavaScript with
 * `Object.fromEntries` and a lookup per row. The merchant scan had no filter at
 * all — every merchant on the platform, to attach a username to the handful
 * that appear in the results.
 *
 * The bonus total is read out of the double-entry postings, which is where a
 * bonus actually lands: `jsonb_array_elements` over the MERCHANT_FUNDS leg,
 * rather than a stored per-merchant total that nothing keeps correct.
 */
export async function merchantLeaderboard({ days = 30, limit = 20, sortBy = 'volume' } = {}) {
  const ORDER_BY = {
    volume:      'completed_volume DESC',
    orders:      'completed_orders DESC',
    successRate: 'success_rate DESC',
    bonus:       'bonus_paise DESC',
  }[sortBy] || 'completed_volume DESC';

  const since = new Date(Date.now() - Math.max(Number(days) || 30, 1) * 86_400_000);
  const { rows } = await pgQuery(
    `WITH orders AS (
       SELECT merchant_id,
              COUNT(*)::int AS total_orders,
              COUNT(*) FILTER (WHERE state IN ('COMPLETED','PAID'))::int AS completed_orders,
              COUNT(*) FILTER (WHERE state IN ('FAILED','CANCELLED','REJECTED'))::int AS failed_orders,
              COALESCE(SUM(fiat_amount_paise) FILTER (WHERE state IN ('COMPLETED','PAID')), 0) AS completed_volume
         FROM order_states
        WHERE merchant_id IS NOT NULL AND created_at >= $1
        GROUP BY merchant_id
     ), bonuses AS (
       SELECT e.ref_id AS merchant_id,
              COALESCE(SUM(ABS((p->>'amountPaise')::BIGINT)), 0) AS bonus_paise
         FROM accounting_events e
         CROSS JOIN LATERAL jsonb_array_elements(e.postings) p
        WHERE e.event_type = 'MERCHANT_BONUS_ISSUED'
          AND e.created_at >= $1
          AND p->>'account' = 'MERCHANT_FUNDS'
        GROUP BY e.ref_id
     )
     SELECT o.merchant_id, o.total_orders, o.completed_orders, o.failed_orders,
            o.completed_volume,
            COALESCE(b.bonus_paise, 0) AS bonus_paise,
            COALESCE(m.username, m.name, 'unknown') AS username,
            COALESCE(m.is_online, FALSE) AS is_online,
            CASE WHEN o.total_orders > 0
                 THEN ROUND((o.completed_orders::numeric / o.total_orders) * 100, 2)
                 ELSE 0 END AS success_rate
       FROM orders o
       LEFT JOIN bonuses b ON b.merchant_id = o.merchant_id
       LEFT JOIN merchants m ON m.merchant_id = o.merchant_id
      ORDER BY ${ORDER_BY}
      LIMIT ${Math.min(Math.max(Number(limit) || 20, 1), 200)}`,
    [since], 'stats_merchant_leaderboard',
  );

  return rows.map((r) => ({
    merchantId: r.merchant_id,
    username: r.username,
    isOnline: r.is_online,
    totalOrders: r.total_orders,
    completedOrders: r.completed_orders,
    failedOrders: r.failed_orders,
    completedVolume: rupees(r.completed_volume),
    successRate: Number(r.success_rate),
    bonusIssued: rupees(r.bonus_paise),
  }));
}

/**
 * One merchant's funding picture.
 *
 * `matchedCycleVolume` is the smaller of the deposit and withdrawal volumes —
 * the amount that actually went round a buy→sell cycle, which is what the
 * performance bonus is calculated from.
 *
 * The wallet balance comes from `merchant_wallets`, not from a copy on the
 * merchant row. The document version read a stored `tokenBalance`, so an
 * operator reviewing a merchant's funding saw a figure that no transfer would
 * have found.
 */
export async function merchantFundingStats(merchantId) {
  const { rows } = await pgQuery(
    `SELECT
       (SELECT COUNT(*)::int FROM order_states
         WHERE merchant_id = $1 AND state = 'COMPLETED' AND order_type = 'DEPOSIT')    AS deposits,
       (SELECT COALESCE(SUM(fiat_amount_paise), 0) FROM order_states
         WHERE merchant_id = $1 AND state = 'COMPLETED' AND order_type = 'DEPOSIT')    AS deposit_volume,
       (SELECT COUNT(*)::int FROM order_states
         WHERE merchant_id = $1 AND state = 'COMPLETED' AND order_type = 'WITHDRAWAL') AS withdrawals,
       (SELECT COALESCE(SUM(fiat_amount_paise), 0) FROM order_states
         WHERE merchant_id = $1 AND state = 'COMPLETED' AND order_type = 'WITHDRAWAL') AS withdrawal_volume,
       (SELECT COUNT(*)::int FROM merchant_wallet_entries
         WHERE merchant_id = $1 AND tx_id LIKE 'mw_topup_%')                           AS topups,
       (SELECT COALESCE(SUM(amount_paise), 0) FROM merchant_wallet_entries
         WHERE merchant_id = $1 AND tx_id LIKE 'mw_topup_%')                           AS topup_total,
       (SELECT COALESCE(SUM(ABS((p->>'amountPaise')::BIGINT)), 0)
          FROM accounting_events e
          CROSS JOIN LATERAL jsonb_array_elements(e.postings) p
         WHERE e.event_type = 'MERCHANT_BONUS_ISSUED' AND e.ref_id = $1
           AND p->>'account' = 'MERCHANT_FUNDS')                                       AS bonus_paise,
       (SELECT COUNT(*)::int FROM accounting_events
         WHERE event_type = 'MERCHANT_BONUS_ISSUED' AND ref_id = $1)                   AS bonus_count`,
    [String(merchantId)], 'stats_merchant_funding',
  );
  const r = rows[0];
  const depositVolume = rupees(r.deposit_volume);
  const withdrawalVolume = rupees(r.withdrawal_volume);
  return {
    merchantId: String(merchantId),
    depositsCompleted: r.deposits,
    depositVolume,
    withdrawalsCompleted: r.withdrawals,
    withdrawalVolume,
    matchedCycleVolume: Math.min(depositVolume, withdrawalVolume),
    bonusesIssued: r.bonus_count,
    bonusTotal: rupees(r.bonus_paise),
    adminTopups: r.topups,
    adminTopupTotal: rupees(r.topup_total),
  };
}

/**
 * Daily completed orders and volume for one merchant, chart-ready.
 *
 * `generate_series` supplies the days, so a day with no orders is a zero rather
 * than a gap the chart interpolates across — which is the difference between
 * "this merchant did nothing on Tuesday" and "Tuesday is missing".
 *
 * Days are cut in IST, the timezone the platform operates in. Grouping by a UTC
 * date puts every order after 18:30 local on the following day.
 */
export async function merchantPerformanceHistory(merchantId, { days = 30, timezone = 'Asia/Kolkata' } = {}) {
  const span = Math.min(Math.max(Number(days) || 30, 1), 365);
  const { rows } = await pgQuery(
    `WITH span AS (
       SELECT generate_series(
         (CAST(now() AT TIME ZONE $2 AS DATE) - ($3::int - 1)),
         CAST(now() AT TIME ZONE $2 AS DATE),
         '1 day'::interval
       )::date AS day
     ), completed AS (
       SELECT CAST(completed_at AT TIME ZONE $2 AS DATE) AS day, order_type,
              COUNT(*)::int AS orders,
              COALESCE(SUM(fiat_amount_paise), 0) AS volume
         FROM order_states
        WHERE merchant_id = $1 AND state = 'COMPLETED' AND completed_at IS NOT NULL
        GROUP BY 1, 2
     )
     SELECT s.day,
            COALESCE(SUM(c.orders), 0)::int AS total_orders,
            COALESCE(SUM(c.volume), 0)      AS total_volume,
            COALESCE(SUM(c.orders) FILTER (WHERE c.order_type = 'DEPOSIT'), 0)::int    AS deposit_orders,
            COALESCE(SUM(c.volume) FILTER (WHERE c.order_type = 'DEPOSIT'), 0)         AS deposit_volume,
            COALESCE(SUM(c.orders) FILTER (WHERE c.order_type = 'WITHDRAWAL'), 0)::int AS withdrawal_orders,
            COALESCE(SUM(c.volume) FILTER (WHERE c.order_type = 'WITHDRAWAL'), 0)      AS withdrawal_volume
       FROM span s
       LEFT JOIN completed c ON c.day = s.day
      GROUP BY s.day
      ORDER BY s.day`,
    [String(merchantId), timezone, span], 'stats_merchant_history',
  );

  return rows.map((r) => ({
    day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
    totalOrders: r.total_orders,
    totalVolume: rupees(r.total_volume),
    byType: [
      { type: 'DEPOSIT', orders: r.deposit_orders, volume: rupees(r.deposit_volume) },
      { type: 'WITHDRAWAL', orders: r.withdrawal_orders, volume: rupees(r.withdrawal_volume) },
    ],
  }));
}

/** Per-merchant throughput, derived from the orders they actually settled. */
export async function merchantThroughput({ from = null, to = null, limit = 50 } = {}) {
  const where = ["state = 'COMPLETED'", 'merchant_id IS NOT NULL'];
  const params = [];
  if (from) { params.push(from); where.push(`completed_at >= $${params.length}`); }
  if (to) { params.push(to); where.push(`completed_at <= $${params.length}`); }
  const { rows } = await pgQuery(
    `SELECT merchant_id,
            COUNT(*)::int AS orders,
            COUNT(*) FILTER (WHERE order_type = 'DEPOSIT')::int    AS deposits,
            COUNT(*) FILTER (WHERE order_type = 'WITHDRAWAL')::int AS withdrawals,
            COALESCE(SUM(token_amount_paise), 0) AS volume,
            AVG(merchant_response_minutes)       AS avg_response
       FROM order_states WHERE ${where.join(' AND ')}
      GROUP BY merchant_id
      ORDER BY volume DESC
      LIMIT ${Math.min(Math.max(Number(limit) || 50, 1), 200)}`,
    params, 'stats_merchant_throughput',
  );
  return rows.map((r) => ({
    merchantId: r.merchant_id, orders: r.orders,
    deposits: r.deposits, withdrawals: r.withdrawals,
    volume: rupees(r.volume),
    avgResponseMinutes: r.avg_response === null ? null : Number(r.avg_response),
  }));
}

/**
 * One merchant's earnings — today, over a range, and split by direction.
 *
 * ONE STATEMENT for both windows. It was two aggregations issued together, so
 * "today" and "lifetime" could describe the database at different instants and
 * a merchant watching the dashboard during a settlement saw today's figure
 * outrun the lifetime one it is part of.
 *
 * Every figure is derived from the orders that actually completed. The merchant
 * record carries lifetime counters as well, and they are a convenience for
 * ranking — this is what a payout is reconciled against.
 */
export async function merchantEarnings(merchantId, { from = null, to = null } = {}) {
  const params = [String(merchantId), from, to];
  const { rows } = await pgQuery(
    `SELECT
       -- today
       COUNT(*) FILTER (WHERE completed_at >= CURRENT_DATE AND order_type = 'DEPOSIT')::int AS today_deposit_count,
       COALESCE(SUM(merchant_profit_paise) FILTER (WHERE completed_at >= CURRENT_DATE AND order_type = 'DEPOSIT'), 0) AS today_deposit_fees,
       COALESCE(SUM(fiat_amount_paise)     FILTER (WHERE completed_at >= CURRENT_DATE AND order_type = 'DEPOSIT'), 0) AS today_deposit_amount,
       COUNT(*) FILTER (WHERE completed_at >= CURRENT_DATE AND order_type = 'WITHDRAWAL')::int AS today_withdrawal_count,
       COALESCE(SUM(merchant_profit_paise) FILTER (WHERE completed_at >= CURRENT_DATE AND order_type = 'WITHDRAWAL'), 0) AS today_withdrawal_fees,
       COALESCE(SUM(fiat_amount_paise)     FILTER (WHERE completed_at >= CURRENT_DATE AND order_type = 'WITHDRAWAL'), 0) AS today_withdrawal_amount,
       -- the requested range, or everything when none was given
       COUNT(*) FILTER (WHERE ($2::timestamptz IS NULL OR completed_at >= $2)
                          AND ($3::timestamptz IS NULL OR completed_at <= $3))::int AS range_orders,
       COALESCE(SUM(merchant_profit_paise) FILTER (WHERE ($2::timestamptz IS NULL OR completed_at >= $2)
                          AND ($3::timestamptz IS NULL OR completed_at <= $3)), 0) AS range_earnings,
       COALESCE(SUM(fiat_amount_paise)     FILTER (WHERE ($2::timestamptz IS NULL OR completed_at >= $2)
                          AND ($3::timestamptz IS NULL OR completed_at <= $3)), 0) AS range_volume
     FROM order_states
     WHERE merchant_id = $1 AND state IN ('PAID', 'COMPLETED')`,
    params, 'stats_merchant_earnings',
  );
  const r = rows[0];
  return {
    today: {
      deposits: {
        count: r.today_deposit_count,
        totalFees: rupees(r.today_deposit_fees),
        totalAmount: rupees(r.today_deposit_amount),
      },
      withdrawals: {
        count: r.today_withdrawal_count,
        totalFees: rupees(r.today_withdrawal_fees),
        totalAmount: rupees(r.today_withdrawal_amount),
      },
    },
    lifetime: {
      totalOrders: r.range_orders,
      totalEarnings: rupees(r.range_earnings),
      totalVolume: rupees(r.range_volume),
    },
  };
}

/**
 * A merchant's last N days, one row per day.
 *
 * The days are generated by `generate_series` and LEFT JOINed, so a day with no
 * orders comes back as a zero rather than being absent — a chart that silently
 * drops empty days draws a week that looks busier than it was.
 */
export async function merchantDailyEarnings(merchantId, { days = 7, timezone = 'Asia/Kolkata' } = {}) {
  const span = Math.min(Math.max(Number(days) || 7, 1), 90);
  const { rows } = await pgQuery(
    `WITH span AS (
       SELECT generate_series(
         (now() AT TIME ZONE $2)::date - ($3::int - 1),
         (now() AT TIME ZONE $2)::date,
         interval '1 day')::date AS day
     )
     SELECT span.day,
            COUNT(o.order_id)::int AS orders,
            COALESCE(SUM(o.merchant_profit_paise), 0) AS earnings,
            COALESCE(SUM(o.fiat_amount_paise), 0)     AS volume
       FROM span
       LEFT JOIN order_states o
         ON (o.completed_at AT TIME ZONE $2)::date = span.day
        AND o.merchant_id = $1
        AND o.state IN ('PAID', 'COMPLETED')
      GROUP BY span.day
      ORDER BY span.day ASC`,
    [String(merchantId), String(timezone), span], 'stats_merchant_daily',
  );
  return rows.map((r) => ({
    label: r.day instanceof Date ? r.day.toISOString().split('T')[0] : String(r.day),
    orders: r.orders,
    earnings: rupees(r.earnings),
    volume: rupees(r.volume),
  }));
}

/**
 * A merchant's profit picture, derived from the orders they settled.
 *
 * ── One statement, and no fetch-then-sum ────────────────────────────────────
 * This was three separate `find()` calls pulling EVERY order the merchant had
 * ever touched — deposits, withdrawals, and all of them again for a status
 * breakdown — to add up in JavaScript. It works on a new merchant and stops
 * working on a busy one, and the three reads could see the table at three
 * different moments, so revenue and exposure need not describe the same set of
 * orders.
 *
 * Every figure here comes from one pass over one snapshot.
 */
export async function merchantProfitEngine(merchantId) {
  const { rows } = await pgQuery(
    `SELECT
       COUNT(*) FILTER (WHERE order_type = 'DEPOSIT'    AND state IN ('COMPLETED','PAID'))::int AS deposits,
       COUNT(*) FILTER (WHERE order_type = 'WITHDRAWAL' AND state IN ('COMPLETED','PAID'))::int AS withdrawals,
       COALESCE(SUM(token_amount_paise) FILTER (WHERE order_type = 'DEPOSIT'    AND state IN ('COMPLETED','PAID')), 0) AS tokens_out,
       COALESCE(SUM(token_amount_paise) FILTER (WHERE order_type = 'WITHDRAWAL' AND state IN ('COMPLETED','PAID')), 0) AS tokens_back,
       COALESCE(SUM(fiat_amount_paise)  FILTER (WHERE order_type = 'DEPOSIT'    AND state IN ('COMPLETED','PAID')), 0) AS revenue,
       COALESCE(SUM(fiat_amount_paise)  FILTER (WHERE order_type = 'WITHDRAWAL' AND state IN ('COMPLETED','PAID')), 0) AS exposure,
       jsonb_object_agg(state, cnt) FILTER (WHERE state IS NOT NULL) AS status_map
     FROM (
       SELECT order_type, state, token_amount_paise, fiat_amount_paise,
              COUNT(*) OVER (PARTITION BY state)::int AS cnt
         FROM order_states WHERE merchant_id = $1
     ) o`,
    [String(merchantId)], 'stats_merchant_profit',
  );
  const r = rows[0];
  return {
    deposits: r.deposits,
    withdrawals: r.withdrawals,
    tokensDispensed: rupees(r.tokens_out),
    tokensReturned: rupees(r.tokens_back),
    revenue: rupees(r.revenue),
    withdrawalExposure: rupees(r.exposure),
    orderStatus: r.status_map ?? {},
  };
}

/** A merchant's live queue counts, in one pass. */
export async function merchantQueueCounts(merchantId) {
  const { rows } = await pgQuery(
    `SELECT
       COUNT(*) FILTER (WHERE state = 'PENDING_QUEUE')::int AS pending,
       COUNT(*) FILTER (WHERE state = 'ASSIGNED')::int      AS assigned,
       COUNT(*) FILTER (WHERE state = 'PROCESSING')::int    AS processing,
       COUNT(*) FILTER (WHERE state = 'DISPUTED')::int      AS disputed,
       COUNT(*) FILTER (WHERE state IN ('PAID','COMPLETED')
                          AND completed_at >= CURRENT_DATE)::int AS completed_today
     FROM order_states WHERE merchant_id = $1`,
    [String(merchantId)], 'stats_merchant_queue',
  );
  return rows[0];
}

/** How many rows each table holds — the operator's "is anything there?" view. */
export async function tableCounts(tables = []) {
  const out = {};
  for (const table of tables) {
    // The name comes from a caller-supplied list, so it is validated against
    // the catalogue rather than interpolated on trust.
    const { rows: exists } = await pgQuery(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1`, [table], 'stats_table_check',
    );
    if (!exists.length) { out[table] = null; continue; }
    const { rows } = await pgQuery(`SELECT COUNT(*)::int AS n FROM "${table}"`, [], 'stats_table_count');
    out[table] = int(rows[0].n);
  }
  return out;
}
