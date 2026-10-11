// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant account's reports (owner, 2026-10-11 — Phase B). READ-ONLY.
 *
 * Over a range of IST days (the database clock), the merchant's own orders,
 * per payment account and direction: how many, how many completed and for how
 * many tokens, how many were disputed and how many disputes it lost. A buy
 * counts against the account it was paid INTO (`pay_account_id`), a sell
 * against the account it was paid FROM (`paid_from_account_id`); an order with
 * neither yet (a sell not marked paid, an agent-era order) is under "none".
 * Tokens, never fiat (trap 15). Scoped by `merchant_id` in every WHERE
 * (trap 16). Nothing here carries a player's detail (§24).
 */
import { pgQuery } from '../client.js';

const IST_DAY = /^\d{4}-\d{2}-\d{2}$/;
const bad = (message) => Object.assign(new Error(message), { status: 400, code: 'INVALID_REPORT_RANGE' });

/**
 * The range as IST days, inclusive: `from` and `to` as YYYY-MM-DD, defaulting
 * to the last seven days ending today; at most 366 days.
 */
export function reportRange({ from = null, to = null } = {}) {
  for (const d of [from, to]) {
    if (d !== null && d !== undefined && d !== '' && !IST_DAY.test(String(d))) {
      throw bad('Dates are YYYY-MM-DD (IST days).');
    }
  }
  if (from && to) {
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    if (!Number.isFinite(days) || days < 0) throw bad('The range ends before it starts.');
    if (days > 365) throw bad('A report covers at most 366 days.');
  }
  return { from: from || null, to: to || null };
}

/** The range clause: `created_at` inside the IST days [from, to], defaults applied in SQL. */
const RANGE_SQL = `
  created_at >= ((COALESCE($2::date, (now() AT TIME ZONE 'Asia/Kolkata')::date - 6))::timestamp AT TIME ZONE 'Asia/Kolkata')
  AND created_at < ((COALESCE($3::date, (now() AT TIME ZONE 'Asia/Kolkata')::date) + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
  AND COALESCE($3::date, (now() AT TIME ZONE 'Asia/Kolkata')::date)
      - COALESCE($2::date, (now() AT TIME ZONE 'Asia/Kolkata')::date - 6) BETWEEN 0 AND 365`;

/** Per account and direction, over the range. */
export async function accountTotals(merchantId, range) {
  const { from, to } = reportRange(range);
  const { rows } = await pgQuery(
    `SELECT COALESCE(o.pay_account_id, o.paid_from_account_id) AS account_id,
            o.order_type,
            count(*)::int AS orders,
            count(*) FILTER (WHERE o.state = 'COMPLETED')::int AS completed,
            COALESCE(SUM(o.token_amount_paise) FILTER (WHERE o.state = 'COMPLETED'), 0)::bigint AS completed_paise,
            count(*) FILTER (WHERE o.dispute_raised_at IS NOT NULL)::int AS disputed,
            count(f.order_id) FILTER (WHERE f.party = 'MERCHANT')::int AS disputes_lost
       FROM order_states o
       LEFT JOIN dispute_faults f ON f.order_id = o.order_id
      WHERE o.merchant_id = $1 AND ${RANGE_SQL.replaceAll('created_at', 'o.created_at')}
      GROUP BY 1, 2
      ORDER BY 1 NULLS LAST, 2`,
    [String(merchantId), from, to], 'merchant_report_account_totals');
  return rows.map((r) => ({
    accountId: r.account_id ?? null,
    direction: r.order_type,
    orders: r.orders,
    completed: r.completed,
    completedPaise: Number(r.completed_paise),
    disputed: r.disputed,
    disputesLost: r.disputes_lost,
  }));
}

/** The orders themselves, for the CSV export: the merchant's view, no player detail. */
export async function ordersForExport(merchantId, range, { limit = 10000 } = {}) {
  const { from, to } = reportRange(range);
  const { rows } = await pgQuery(
    `SELECT o.order_id, o.order_type, o.state, o.token_amount_paise, o.utr,
            o.pay_account_id, o.paid_from_account_id,
            a.label AS account_label,
            o.created_at, o.completed_at, o.dispute_raised_at,
            (f.party = 'MERCHANT') AS dispute_lost
       FROM order_states o
       LEFT JOIN merchant_payment_accounts a
              ON a.account_id = COALESCE(o.pay_account_id, o.paid_from_account_id)
       LEFT JOIN dispute_faults f ON f.order_id = o.order_id
      WHERE o.merchant_id = $1 AND ${RANGE_SQL.replaceAll('created_at', 'o.created_at')}
      ORDER BY o.created_at, o.order_id
      LIMIT $4`,
    [String(merchantId), from, to, Math.min(Math.max(Number(limit) || 10000, 1), 50000)],
    'merchant_report_orders_export');
  return rows;
}
