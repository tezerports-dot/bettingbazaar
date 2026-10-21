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
import { staffScopeSql } from './orders.record.js';

const IST_DAY = /^\d{4}-\d{2}-\d{2}$/;
const bad = (message) => Object.assign(new Error(message), { status: 400, code: 'INVALID_REPORT_RANGE' });

/**
 * The range as IST days, inclusive: `from` and `to` as YYYY-MM-DD, defaulting
 * to the last seven days ending today; at most 366 days when both are given.
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

/**
 * The range clause: `created_at` inside the IST days [from, to]. With one end
 * given the other is read from it: `to` alone is the seven days ending then,
 * `from` alone runs to today. Both were anchored on TODAY, so a `to` more than
 * a week back made a range ending before it started and every figure read 0
 * until the dates were cleared (owner, 2026-10-20).
 */
const RANGE_SQL = `
  created_at >= ((COALESCE($2::date, COALESCE($3::date, (now() AT TIME ZONE 'Asia/Kolkata')::date) - 6))::timestamp AT TIME ZONE 'Asia/Kolkata')
  AND created_at < ((COALESCE($3::date, (now() AT TIME ZONE 'Asia/Kolkata')::date) + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`;

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

/** What a report row says was done to the order. */
export const REPORT_RESULTS = Object.freeze({ CONFIRMED: 'CONFIRMED', REJECTED: 'REJECTED', NONE: 'NONE' });

/** Most rows one call returns: a page is at most 100, the CSV at most this. */
export const ORDER_REPORT_MAX_ROWS = 10_000;

/**
 * The orders behind the report, one row each (owner, 2026-10-16): the order,
 * the player's id, the reference, the amount, and the ✓ or ✗ pressed on it
 * with who pressed it. For every merchant, agent or merchant account; a
 * sub-member's rows are their slice (`staffScopeSql`, in the WHERE, trap 16).
 *
 * "Who" is the order transition's `actor` (`merchantActorTag`:
 * `merchant:<id>` for the member or the account's owner,
 * `merchant_staff:<staffId>` for a sub-member): the latest one by this
 * merchant's side into COMPLETED (a buy confirmed), PAID (a sell paid out) or
 * REJECTED (a buy not received). A row with none carries only its state
 * (expired, cancelled, in dispute, open).
 *
 * The totals count EVERY row the range matches, not the page (window
 * aggregates computed before LIMIT). Volume is in tokens (trap 15).
 */
export async function orderReport(merchantId, {
  range = {}, scope = null, orderType = null, limit = 50, offset = 0,
} = {}) {
  const { from, to } = reportRange(range);
  const params = [String(merchantId), from, to];
  const filters = [`o.state <> 'PENDING_QUEUE'`];
  if (orderType) { params.push(String(orderType)); filters.push(`o.order_type = $${params.length}`); }
  if (scope) filters.push(staffScopeSql(scope, params, 'o.'));
  const size = Math.min(Math.max(Number(limit) || 50, 1), ORDER_REPORT_MAX_ROWS);
  const skip = Math.max(Number(offset) || 0, 0);

  const { rows } = await pgQuery(
    `WITH mine AS (
       SELECT o.order_id, o.order_type, o.user_id, o.utr, o.state,
              o.token_amount_paise, o.created_at, o.updated_at
         FROM order_states o
        WHERE o.merchant_id = $1 AND ${RANGE_SQL.replaceAll('created_at', 'o.created_at')}
          AND ${filters.join(' AND ')}
     ), acts AS (
       SELECT DISTINCT ON (t.order_id) t.order_id, t.to_state, t.actor, t.created_at
         FROM order_transitions t
         JOIN mine m ON m.order_id = t.order_id
        WHERE t.to_state IN ('COMPLETED', 'PAID', 'REJECTED')
          AND (starts_with(t.actor, 'merchant:') OR starts_with(t.actor, 'merchant_staff:'))
        ORDER BY t.order_id, t.id DESC
     )
     SELECT m.*, a.to_state AS acted_to, a.actor AS acted_by, a.created_at AS acted_at,
            ms.name AS staff_name,
            count(*) OVER () AS total_count,
            count(a.order_id) FILTER (WHERE a.to_state <> 'REJECTED') OVER () AS confirmed_count,
            count(a.order_id) FILTER (WHERE a.to_state = 'REJECTED') OVER () AS rejected_count,
            COALESCE(SUM(m.token_amount_paise) FILTER (
              WHERE a.to_state <> 'REJECTED' AND m.order_type = 'DEPOSIT') OVER (), 0) AS confirmed_buy_paise,
            COALESCE(SUM(m.token_amount_paise) FILTER (
              WHERE a.to_state <> 'REJECTED' AND m.order_type = 'WITHDRAWAL') OVER (), 0) AS confirmed_sell_paise
       FROM mine m
       LEFT JOIN acts a ON a.order_id = m.order_id
       LEFT JOIN merchant_staff ms
              ON starts_with(a.actor, 'merchant_staff:') AND ms.staff_id = substr(a.actor, 16)
             AND ms.merchant_id = $1
      ORDER BY COALESCE(a.created_at, m.updated_at) DESC, m.order_id DESC
      LIMIT ${size} OFFSET ${skip}`,
    params, 'merchant_report_orders');

  const first = rows[0];
  return {
    range: { from, to },
    rows: rows.map(toReportRow),
    totals: {
      orders: first ? Number(first.total_count) : 0,
      confirmed: first ? Number(first.confirmed_count) : 0,
      rejected: first ? Number(first.rejected_count) : 0,
      confirmedBuyPaise: first ? Number(first.confirmed_buy_paise) : 0,
      confirmedSellPaise: first ? Number(first.confirmed_sell_paise) : 0,
    },
  };
}

function toReportRow(r) {
  let result = REPORT_RESULTS.NONE;
  if (r.acted_to === 'REJECTED') result = REPORT_RESULTS.REJECTED;
  else if (r.acted_to) result = REPORT_RESULTS.CONFIRMED;
  let actedBy = null;
  if (r.acted_by?.startsWith('merchant_staff:')) actedBy = { kind: 'STAFF', name: r.staff_name ?? null };
  else if (r.acted_by?.startsWith('merchant:')) actedBy = { kind: 'MERCHANT', name: null };
  return {
    orderId: r.order_id,
    type: r.order_type,
    userId: r.user_id,
    utr: r.utr ?? null,
    tokenPaise: Number(r.token_amount_paise),
    state: r.state,
    result,
    actedBy,
    at: r.acted_at ?? r.updated_at ?? r.created_at,
  };
}
