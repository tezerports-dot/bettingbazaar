// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A merchant's business ledger (owner, 2026-10-21). READ-ONLY; owns no value.
 *
 * Over a range of IST days, one labelled table per kind of business, every
 * figure read from its owner, and a closing block of totals:
 *
 *   buys          completed buys this merchant served (players paid them INR)
 *   sells         sells they paid players: completed, or PAID and still in
 *                 the hold window (`withdrawalHoldMinutes`), each row saying which
 *   commission    their commission shares (`team_commission_shares`)
 *   pool          tokens bought from the platform (nothing is sold back), with
 *                 what was paid (`team_pool_requests` FULFILLED, priced by
 *                 `admin_token_considerations`)
 *   disputes      disputes raised on their orders: the decision, who lost,
 *                 and the compensation paid out of the pool
 *
 * Cancelled, expired and refused orders are not business and are left out.
 * Tokens are paise of a token, rupees at the peg (₹1 a token, §2): a player's
 * INR equals the tokens (trap 15 holds: no fiat column is summed). Money with
 * the platform is `inr_equivalent_paise`, never `fiat_amount_minor`.
 *
 * Net profit is what the business kept: the tokens bought from the platform
 * less what was paid for them, plus commission, less compensation paid. Player buys and sells move cash and pool tokens by the
 * same amount the other way, so they change the books but not the profit.
 *
 * Scoped in every WHERE to the merchant (trap 16): their orders by
 * `merchant_id`, their shares by `merchant_id`, their pool trades by the
 * requester (`supervisor_id`), their pools by the teams they own or run.
 */
import { pgQuery } from '../client.js';
import { reportRange, rangeSqlOn, RANGE_BOUNDS_SQL } from './merchantReports.js';

/** At most this many rows per table; the totals count every row regardless. */
export const LEDGER_MAX_ROWS = 5_000;

const n = (v) => Number(v ?? 0);

export async function businessLedger(merchantId, range = {}) {
  const { from, to } = reportRange(range);
  const p = [String(merchantId), from, to];
  const lim = LEDGER_MAX_ROWS;

  const [orders, commission, pool, disputes, holdings] = await Promise.all([
    pgQuery(
      `SELECT o.order_id, o.order_type, o.state, o.token_amount_paise, o.created_at, o.payment_mode,
              a.label AS account_label
         FROM order_states o
         LEFT JOIN merchant_payment_accounts a
                ON a.account_id = COALESCE(o.pay_account_id, o.paid_from_account_id) AND a.merchant_id = o.merchant_id
        WHERE o.merchant_id = $1 AND ${rangeSqlOn('o.created_at')}
          AND (o.state = 'COMPLETED' OR (o.order_type = 'WITHDRAWAL' AND o.state = 'PAID'))
        ORDER BY o.created_at, o.order_id`, p, 'merchant_ledger_orders'),
    pgQuery(
      `SELECT s.commission_id, s.role, s.share_paise, s.created_at, t.name AS team_name
         FROM team_commission_shares s
         JOIN team_commissions c ON c.commission_id = s.commission_id
         JOIN teams t ON t.team_id = c.team_id
        WHERE s.merchant_id = $1 AND ${rangeSqlOn('s.created_at')}
        ORDER BY s.created_at, s.commission_id`, p, 'merchant_ledger_commission'),
    pgQuery(
      `SELECT r.request_id, r.direction, r.token_amount_paise, r.decided_at, t.name AS team_name,
              c.currency, c.fiat_amount_minor, c.inr_equivalent_paise
         FROM team_pool_requests r
         JOIN teams t ON t.team_id = r.team_id
         LEFT JOIN admin_token_considerations c ON c.movement_id = 'team_pool_' || r.request_id
        WHERE r.supervisor_id = $1 AND r.status = 'FULFILLED' AND r.direction = 'BUY' AND ${rangeSqlOn('r.decided_at')}
        ORDER BY r.decided_at, r.request_id`, p, 'merchant_ledger_pool'),
    pgQuery(
      `SELECT o.order_id, o.order_type, o.token_amount_paise, o.dispute_raised_at, o.state,
              o.dispute_decision, f.party AS lost_by, dc.amount_paise AS compensation_paise
         FROM order_states o
         LEFT JOIN dispute_faults f ON f.order_id = o.order_id
         LEFT JOIN dispute_compensations dc ON dc.order_id = o.order_id
        WHERE o.merchant_id = $1 AND o.dispute_raised_at IS NOT NULL AND ${rangeSqlOn('o.dispute_raised_at')}
        ORDER BY o.dispute_raised_at, o.order_id`, p, 'merchant_ledger_disputes'),
    pgQuery(
      `SELECT COALESCE(SUM(pl.available_paise), 0) AS available, COALESCE(SUM(pl.held_paise), 0) AS held,
              count(t.team_id)::int AS pools
         FROM teams t
         LEFT JOIN team_pools pl ON pl.team_id = t.team_id
        WHERE t.owner_merchant_id = $1 OR t.supervisor_id = $1`, [String(merchantId)], 'merchant_ledger_pools'),
  ]);

  const row = (r) => ({
    orderId: r.order_id, at: r.created_at, tokensPaise: n(r.token_amount_paise), state: r.state,
    rail: r.payment_mode === 'CASH_ATM' ? 'CASH' : 'UPI / bank', account: r.account_label ?? null,
  });
  const buys = orders.rows.filter((r) => r.order_type === 'DEPOSIT').map(row);
  const sells = orders.rows.filter((r) => r.order_type === 'WITHDRAWAL').map(row);
  const commissionRows = commission.rows.map((r) => ({
    commissionId: r.commission_id, at: r.created_at, role: r.role, team: r.team_name, sharePaise: n(r.share_paise),
  }));
  const poolRows = pool.rows.map((r) => ({
    requestId: r.request_id, at: r.decided_at, direction: r.direction, team: r.team_name,
    tokensPaise: n(r.token_amount_paise),
    // What changed hands for it: in its own currency (hundredths), and in rupees.
    currency: r.currency ?? null, amountMinor: r.fiat_amount_minor === null ? null : n(r.fiat_amount_minor),
    inrPaise: n(r.inr_equivalent_paise),
  }));
  const disputeRows = disputes.rows.map((r) => ({
    orderId: r.order_id, at: r.dispute_raised_at, type: r.order_type === 'DEPOSIT' ? 'BUY' : 'SELL',
    tokensPaise: n(r.token_amount_paise), state: r.state, decision: r.dispute_decision ?? null,
    lostBy: r.lost_by ?? null, compensationPaise: n(r.compensation_paise),
  }));

  const sum = (rows, key) => rows.reduce((s, r) => s + r[key], 0);
  const boughtPaise = sum(poolRows, 'tokensPaise');
  const paidToAdminPaise = sum(poolRows, 'inrPaise');
  const userBuysPaise = sum(buys, 'tokensPaise');
  const userSellsPaise = sum(sells, 'tokensPaise');
  const commissionPaise = sum(commissionRows, 'sharePaise');
  const compensationPaise = sum(disputeRows, 'compensationPaise');
  const h = holdings.rows[0];

  const cap = (rows) => rows.slice(0, lim);
  return {
    range: { from, to },
    buys: cap(buys), sells: cap(sells), commission: cap(commissionRows), pool: cap(poolRows), disputes: cap(disputeRows),
    truncated: [buys, sells, commissionRows, poolRows, disputeRows].some((r) => r.length > lim),
    totals: {
      // With the platform: tokens and the rupees they were bought for. Nothing
      // is sold back to it (owner, 2026-10-21).
      boughtPaise, paidToAdminPaise,
      // With players.
      userBuys: buys.length, userBuysPaise, userSells: sells.length, userSellsPaise,
      netUserPaise: userBuysPaise - userSellsPaise,
      // Earned, less paid out on disputes.
      commissionPaise, compensationPaise, netCommissionPaise: commissionPaise - compensationPaise,
      netProfitPaise: (boughtPaise - paidToAdminPaise) + commissionPaise - compensationPaise,
      // Now, not over the range: what the merchant's pools hold.
      pools: h.pools, poolAvailablePaise: n(h.available), poolHeldPaise: n(h.held),
    },
  };
}

// ── The pool statement (owner, 2026-10-22) ───────────────────────────────────
//
// Over a range of IST days, every order with what it did to the pool and the
// commission it brought, between the pool's opening and closing balance, like
// a bank statement. The balance is the pool's tokens, free and held for buys
// (`available_after_paise + held_after_paise` on `team_pool_entries`, the
// pool's own append-only record), so closing = opening + every change listed.
//
// The pools are the ones the merchant owns (a merchant account) or runs (a
// supervisor's teams). An agent's pool is the team's, and a member never sees
// a teammate's row (§2 "What a member sees of the team"): an agent gets their
// own orders, their share of commission (the total over every team order,
// the rows only on their own), and no balance.

/** The pool entries that belong to an order (`ref_id` is its id); COMMISSION's is the commission's. */
const ORDER_ENTRY_KINDS = ['BUY_HOLD', 'BUY_RELEASE', 'BUY_PAID', 'SELL_SETTLED', 'SELL_REVERSED', 'DISPUTE_COMPENSATION'];
/** What a statement row that is not an order is. */
const STATEMENT_ENTRY_LABEL = Object.freeze({ ADMIN_SALE: 'TOKEN_BUY', ADMIN_BUYBACK: 'TOKEN_SELL_BACK' });

export async function poolStatement(merchantId, range = {}) {
  const { from, to } = reportRange(range);
  const id = String(merchantId);
  const { rows: pools } = await pgQuery(
    `SELECT team_id, name FROM teams WHERE owner_merchant_id = $1 OR supervisor_id = $1 ORDER BY created_at, team_id`,
    [id], 'merchant_statement_pools');
  const teamIds = pools.map((t) => t.team_id);
  const ownsPools = teamIds.length > 0;
  const kinds = ORDER_ENTRY_KINDS.map((k) => `'${k}'`).join(', ');
  // `$1` typed here, so a query that asks nothing else of the merchant still plans (§32 S53).
  const bounds = `SELECT r.*, $1::text AS merchant_id FROM (${RANGE_BOUNDS_SQL}) r`;

  // Owner or supervisor: the pools' orders and every entry. Agent: their own
  // orders, the entries of those orders, and their own share of commission.
  const p = ownsPools ? [id, from, to, teamIds] : [id, from, to];
  const entries = ownsPools
    ? `SELECT e.*, COALESCE(c.order_id, CASE WHEN e.kind IN (${kinds}) THEN e.ref_id END) AS order_id
         FROM team_pool_entries e
         LEFT JOIN team_commissions c ON e.kind = 'COMMISSION' AND c.commission_id = e.ref_id, b
        WHERE e.team_id = ANY($4) AND e.created_at >= b.lo AND e.created_at < b.hi`
    : `SELECT e.*, e.ref_id AS order_id
         FROM team_pool_entries e
         JOIN order_states mo ON mo.order_id = e.ref_id AND mo.merchant_id = $1, b
        WHERE e.kind IN (${kinds}) AND e.created_at >= b.lo AND e.created_at < b.hi`;
  const commission = ownsPools
    ? `COALESCE(sum(e.available_delta_paise) FILTER (WHERE e.kind = 'COMMISSION'), 0)`
    : `COALESCE((SELECT sum(s.share_paise) FROM team_commission_shares s
                  JOIN team_commissions c ON c.commission_id = s.commission_id, b
                 WHERE c.order_id = o.order_id AND s.merchant_id = $1
                   AND s.created_at >= b.lo AND s.created_at < b.hi), 0)`;
  const [orderRows, otherRows, balances, shares] = await Promise.all([
    pgQuery(
      `WITH b AS (${bounds}), e AS (${entries}),
       ords AS (
         SELECT o.order_id FROM order_states o, b
          WHERE ${ownsPools ? 'o.team_id = ANY($4)' : 'o.merchant_id = $1'}
            AND o.created_at >= b.lo AND o.created_at < b.hi
         UNION SELECT order_id FROM e WHERE order_id IS NOT NULL
       )
       SELECT o.order_id, o.order_type, o.state, o.token_amount_paise, o.created_at,
              -- The player and the reference only on an order of the merchant's
              -- own: a merchant account's, or an agent's; a supervisor reads
              -- their members' orders without player detail (SUPERVISOR_ORDER_FIELDS).
              CASE WHEN o.merchant_id = $1 OR t.owner_merchant_id = $1 THEN o.user_id END AS user_id_shown,
              CASE WHEN o.merchant_id = $1 OR t.owner_merchant_id = $1 THEN o.utr END AS utr,
              t.name AS team_name,
              COALESCE(sum(e.available_delta_paise + e.held_delta_paise) FILTER (WHERE e.kind <> 'COMMISSION'), 0) AS pool_change,
              ${commission} AS commission,
              ${ownsPools ? '(array_agg(e.available_after_paise + e.held_after_paise ORDER BY e.created_at DESC, e.id DESC))[1]' : 'NULL'} AS balance_after,
              COALESCE(max(e.created_at), o.created_at) AS at
         FROM ords JOIN order_states o ON o.order_id = ords.order_id
         LEFT JOIN teams t ON t.team_id = o.team_id
         LEFT JOIN e ON e.order_id = o.order_id
        GROUP BY o.order_id, t.name, t.owner_merchant_id
        ORDER BY COALESCE(max(e.created_at), o.created_at), o.order_id
        LIMIT ${LEDGER_MAX_ROWS + 1}`, p, 'merchant_statement_orders'),
    ownsPools ? pgQuery(
      `WITH b AS (${bounds}), e AS (${entries})
       SELECT e.kind, e.ref_id, e.created_at, e.available_delta_paise + e.held_delta_paise AS change,
              e.available_after_paise + e.held_after_paise AS balance_after, t.name AS team_name
         FROM e JOIN teams t ON t.team_id = e.team_id
        WHERE e.order_id IS NULL
        ORDER BY e.created_at, e.id`, p, 'merchant_statement_other') : { rows: [] },
    ownsPools ? pgQuery(
      `WITH b AS (${bounds})
       SELECT COALESCE(sum((SELECT x.available_after_paise + x.held_after_paise FROM team_pool_entries x
                              WHERE x.team_id = t AND x.created_at < b.lo ORDER BY x.created_at DESC, x.id DESC LIMIT 1)), 0) AS opening,
              COALESCE(sum((SELECT x.available_after_paise + x.held_after_paise FROM team_pool_entries x
                              WHERE x.team_id = t AND x.created_at < b.hi ORDER BY x.created_at DESC, x.id DESC LIMIT 1)), 0) AS closing
         FROM unnest($4::text[]) AS t, b`, p, 'merchant_statement_balances') : { rows: [] },
    // An agent's commission is a share of every order the team completed,
    // theirs or a teammate's; the total is theirs, the teammates' rows are not.
    ownsPools ? { rows: [] } : pgQuery(
      `WITH b AS (${bounds})
       SELECT COALESCE(sum(s.share_paise), 0) AS paise FROM team_commission_shares s, b
        WHERE s.merchant_id = $1 AND s.created_at >= b.lo AND s.created_at < b.hi`, p, 'merchant_statement_shares'),
  ]);

  const rows = orderRows.rows.map((r) => ({
    kind: r.order_type === 'DEPOSIT' ? 'BUY' : 'SELL',
    ref: r.order_id, at: r.at, userId: r.user_id_shown ?? null, utr: r.utr ?? null, state: r.state,
    tokensPaise: n(r.token_amount_paise), poolChangePaise: n(r.pool_change), commissionPaise: n(r.commission),
    balanceAfterPaise: r.balance_after === null ? null : n(r.balance_after), team: r.team_name ?? null,
  }));
  const others = otherRows.rows.map((r) => ({
    kind: STATEMENT_ENTRY_LABEL[r.kind] ?? r.kind, ref: r.ref_id, at: r.created_at, userId: null, utr: null, state: null,
    tokensPaise: Math.abs(n(r.change)), poolChangePaise: n(r.change), commissionPaise: 0,
    balanceAfterPaise: n(r.balance_after), team: r.team_name,
  }));
  const all = [...rows.slice(0, LEDGER_MAX_ROWS), ...others]
    .sort((a, b) => new Date(a.at) - new Date(b.at) || String(a.ref).localeCompare(String(b.ref)));

  const sum = (list, key) => list.reduce((s, r) => s + r[key], 0);
  const buys = rows.filter((r) => r.kind === 'BUY' && r.state === 'COMPLETED');
  const sells = rows.filter((r) => r.kind === 'SELL' && (r.state === 'COMPLETED' || r.state === 'PAID'));
  const b = balances.rows[0];
  const ledger = await businessLedger(merchantId, range);
  return {
    range: { from, to },
    pools: pools.map((t) => ({ teamId: t.team_id, name: t.name })),
    rows: all,
    truncated: orderRows.rows.length > LEDGER_MAX_ROWS,
    totals: {
      // Null for an agent: the team's pool is not theirs to read row by row.
      openingPaise: b ? n(b.opening) : null,
      closingPaise: b ? n(b.closing) : null,
      buysProcessed: buys.length, buysProcessedPaise: sum(buys, 'tokensPaise'),
      sellsProcessed: sells.length, sellsProcessedPaise: sum(sells, 'tokensPaise'),
      commissionPaise: ownsPools ? sum(rows, 'commissionPaise') : n(shares.rows[0]?.paise),
      tokensBoughtPaise: sum(others.filter((r) => r.kind === 'TOKEN_BUY'), 'poolChangePaise'),
      // The business ledger's own figure: what the merchant kept.
      netProfitPaise: ledger.totals.netProfitPaise,
    },
  };
}
