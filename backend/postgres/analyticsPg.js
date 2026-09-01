// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/analyticsPg.js — betting figures, derived from the bets themselves.
 *
 * ── Why these are not read from a transaction feed ──────────────────────────
 * The admin dashboard used to sum MongoDB `Transaction` documents: `BET_PLACED`
 * for stakes and `BET_WIN` for payouts. Two things were wrong with that, and
 * only one of them was mine.
 *
 *   - `BET_PLACED` transactions are never written. Nothing in the bet route
 *     creates one — the strings that look like it are `reason` text on ledger
 *     rows — so `totalBetsAmount` has been reading ZERO, and `netProfit`, which
 *     is bets minus payouts, has been reporting minus-the-payouts as though the
 *     house had taken nothing all year.
 *   - `BET_WIN` rows were written by `executeSettlementBatch`, which the engine
 *     no longer calls now that settlement is one Postgres enumeration. Left
 *     alone, the payout figures would have silently joined the stake figures at
 *     zero.
 *
 * A denormalised feed can be missing rows and still look healthy; a sum over
 * `bets` cannot, because the bets ARE the thing being counted. The same
 * reasoning put the cycle's real pools and the settlement's counters on derived
 * reads rather than stored ones.
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
