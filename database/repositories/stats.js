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
