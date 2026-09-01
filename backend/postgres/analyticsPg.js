// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/analyticsPg.js — betting figures, derived from the bets themselves.
 *
 * ── Why these are not read from a transaction feed ──────────────────────────
 * The admin dashboard used to sum MongoDB `Transaction` documents: `BET_PLACED`
 * for stakes and `BET_WIN` for payouts.
 *
 * `BET_WIN` rows were written by `executeSettlementBatch`, which the engine no
 * longer calls now that settlement is one Postgres enumeration — so the payout
 * figures would have gone silently to zero, taking `netProfit` with them.
 * (`BET_PLACED` rows ARE written, on the placement route's success path. An
 * earlier version of this comment claimed otherwise, from a truncated grep.)
 *
 * Moving both sides here is not only about that. A denormalised feed can be
 * missing rows and still look healthy; a sum over `bets` cannot, because the
 * bets ARE the thing being counted — the same reasoning that put the cycle's
 * real pools and the settlement's counters on derived reads. It also fixes two
 * things the feed got wrong independently: REFUNDED stakes were counted as
 * turnover, and stakes and payouts were grouped by different timestamps.
 *
 * ── One deliberate difference from the old query ────────────────────────────
 * Payouts are grouped by `placed_at`, not by when the payout was written. The
 * Mongo version grouped stakes by the bet's day and payouts by the settlement's
 * day, so a cycle that closed either side of midnight put its stakes on one day
 * and its winnings on the next — and the daily net profit for both days was
 * wrong. Attributing both to the day the bet was placed keeps a cycle's money
 * on one line.
 */
import { pgQuery } from './pgClient.js';

/** REFUNDED stakes were returned, so they were never the house's to count. */
const COUNTED = `status <> 'REFUNDED'`;

const toRupees = (paise) => Number(paise ?? 0) / 100;

/**
 * Stakes, payouts and bet count over an optional window.
 *
 * `since` is inclusive; omit it for all time.
 */
export async function betTotals({ since = null } = {}) {
  const { rows } = await pgQuery(
    `SELECT COALESCE(SUM(stake_paise)  FILTER (WHERE ${COUNTED}), 0)        AS stake_paise,
            COUNT(*)                   FILTER (WHERE ${COUNTED})            AS bet_count,
            COALESCE(SUM(payout_paise) FILTER (WHERE status = 'WON'), 0)    AS payout_paise,
            COALESCE(SUM(platform_fee_paise) FILTER (WHERE status = 'WON'), 0) AS fee_paise
       FROM bets
      WHERE ($1::timestamptz IS NULL OR placed_at >= $1)`,
    [since ? new Date(since) : null], 'analytics_bet_totals',
  );
  const r = rows[0] || {};
  return {
    bets:     toRupees(r.stake_paise),
    betCount: Number(r.bet_count ?? 0),
    payouts:  toRupees(r.payout_paise),
    fees:     toRupees(r.fee_paise),
  };
}

/**
 * The same figures per calendar day in IST, oldest first.
 *
 * The timezone is named rather than offset so the grouping stays correct if
 * India ever observes a change; `+05:30` hard-codes today's answer.
 */
export async function betTotalsByDay({ since }) {
  const { rows } = await pgQuery(
    `SELECT to_char(placed_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD')     AS day,
            COALESCE(SUM(stake_paise)  FILTER (WHERE ${COUNTED}), 0)         AS stake_paise,
            COUNT(*)                   FILTER (WHERE ${COUNTED})             AS bet_count,
            COALESCE(SUM(payout_paise) FILTER (WHERE status = 'WON'), 0)     AS payout_paise
       FROM bets
      WHERE placed_at >= $1
      GROUP BY 1
      ORDER BY 1`,
    [new Date(since)], 'analytics_bet_totals_by_day',
  );
  return rows.map((r) => ({
    date:     r.day,
    bets:     toRupees(r.stake_paise),
    betCount: Number(r.bet_count ?? 0),
    payouts:  toRupees(r.payout_paise),
  }));
}
