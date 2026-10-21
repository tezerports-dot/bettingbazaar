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
 *   pool          tokens bought from the platform and returned to it, with
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
 * less what was paid for them, the same for returns, plus commission, less
 * compensation paid. Player buys and sells move cash and pool tokens by the
 * same amount the other way, so they change the books but not the profit.
 *
 * Scoped in every WHERE to the merchant (trap 16): their orders by
 * `merchant_id`, their shares by `merchant_id`, their pool trades by the
 * requester (`supervisor_id`), their pools by the teams they own or run.
 */
import { pgQuery } from '../client.js';
import { reportRange, rangeSqlOn } from './merchantReports.js';

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
        WHERE r.supervisor_id = $1 AND r.status = 'FULFILLED' AND ${rangeSqlOn('r.decided_at')}
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
  const boughtPaise = sum(poolRows.filter((r) => r.direction === 'BUY'), 'tokensPaise');
  const paidToAdminPaise = sum(poolRows.filter((r) => r.direction === 'BUY'), 'inrPaise');
  const returnedPaise = sum(poolRows.filter((r) => r.direction === 'SELL'), 'tokensPaise');
  const receivedFromAdminPaise = sum(poolRows.filter((r) => r.direction === 'SELL'), 'inrPaise');
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
      // With the platform: tokens and the rupees they were bought or returned for.
      boughtPaise, paidToAdminPaise, returnedPaise, receivedFromAdminPaise,
      netWithAdminPaise: boughtPaise - returnedPaise,
      // With players.
      userBuys: buys.length, userBuysPaise, userSells: sells.length, userSellsPaise,
      netUserPaise: userBuysPaise - userSellsPaise,
      // Earned, less paid out on disputes.
      commissionPaise, compensationPaise, netCommissionPaise: commissionPaise - compensationPaise,
      netProfitPaise: (boughtPaise - paidToAdminPaise) - (returnedPaise - receivedFromAdminPaise)
        + commissionPaise - compensationPaise,
      // Now, not over the range: what the merchant's pools hold.
      pools: h.pools, poolAvailablePaise: n(h.available), poolHeldPaise: n(h.held),
    },
  };
}
