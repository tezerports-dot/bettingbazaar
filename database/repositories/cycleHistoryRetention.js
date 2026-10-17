// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * cycleHistoryRetention.js — round history kept to the newest
 * CYCLE_HISTORY_KEEP rounds of each board and audience (owner, 2026-10-17:
 * "only keep history until 1440 total cycles for each type of cycle in VIP
 * and General"), the one writer of `cycle_history_rollups`.
 *
 * A round past the window is deleted only once it is finished with: settled
 * (or cancelled) and no bet on it still PENDING. Before it goes, its figures
 * are added to its board, audience and IST day in `cycle_history_rollups`, in
 * the SAME transaction, so the totals never lose a round and never count one
 * twice.
 *
 * What is NOT deleted: the bets, their transitions and the ledger. They are the
 * money record, append-only by the schema (CLAUDE.md §19); a bet keeps its
 * `cycle_id` and its `cycle_type` after its round row is gone.
 */
import { withTransaction, pgQuery } from '../client.js';
import { paiseToRupees } from '../../backend/shared/money.js';

/** Rounds kept per board and audience (owner, 2026-10-17). */
export const CYCLE_HISTORY_KEEP = 1440;

/**
 * Delete the rounds past the window, oldest first, at most `batch` per call,
 * after adding them to the daily summaries. `cycleType` narrows it to one
 * board (the hourly job passes none).
 * @returns {Promise<{pruned: number}>}
 */
export async function pruneCycleHistory({ keep = CYCLE_HISTORY_KEEP, batch = 2000, cycleType = null } = {}) {
  if (!Number.isInteger(keep) || keep < 1) throw new TypeError(`pruneCycleHistory: keep must be a positive whole number, got ${keep}`);
  return withTransaction(async (client) => {
    // SKIP LOCKED: a round the generator or the settlement engine holds is
    // left for the next run, never waited on.
    const { rows } = await client.query(
      `WITH ranked AS (
         SELECT cycle_id,
                row_number() OVER (PARTITION BY cycle_type, audience ORDER BY start_time DESC) AS rn
           FROM cycles WHERE ($3::text IS NULL OR cycle_type = $3)
       )
       SELECT c.cycle_id FROM cycles c JOIN ranked r ON r.cycle_id = c.cycle_id
        WHERE r.rn > $1
          AND (c.is_settled OR c.status = 'CANCELLED')
          AND NOT EXISTS (SELECT 1 FROM bets b WHERE b.cycle_id = c.cycle_id AND b.status = 'PENDING')
        ORDER BY c.start_time
        LIMIT $2
        FOR UPDATE OF c SKIP LOCKED`,
      [keep, batch, cycleType],
    );
    const ids = rows.map((r) => r.cycle_id);
    if (!ids.length) return { pruned: 0 };

    await client.query(
      `WITH gone AS (
         SELECT c.*, (c.start_time AT TIME ZONE 'Asia/Kolkata')::date AS ist_day,
                COALESCE((SELECT SUM(b.stake_paise) FROM bets b
                           WHERE b.cycle_id = c.cycle_id AND NOT b.is_phantom
                             AND b.status NOT IN ('REFUNDED', 'VOID')), 0) AS real_staked
           FROM cycles c WHERE c.cycle_id = ANY($1::text[])
       )
       INSERT INTO cycle_history_rollups AS r
         (cycle_type, audience, ist_day, rounds, delhi_wins, bombay_wins, cancelled,
          real_staked_paise, house_staked_paise, paid_out_paise, net_profit_paise, fees_paise)
       SELECT cycle_type, audience, ist_day,
              COUNT(*),
              COUNT(*) FILTER (WHERE status <> 'CANCELLED' AND winner = 'DELHI'),
              COUNT(*) FILTER (WHERE status <> 'CANCELLED' AND winner = 'BOMBAY'),
              COUNT(*) FILTER (WHERE status = 'CANCELLED'),
              SUM(real_staked), SUM(phantom_delhi_paise + phantom_bombay_paise),
              SUM(total_paid_out_paise), SUM(net_profit_paise), SUM(total_platform_fees_paise)
         FROM gone GROUP BY cycle_type, audience, ist_day
       ON CONFLICT (cycle_type, audience, ist_day) DO UPDATE SET
         rounds             = r.rounds             + EXCLUDED.rounds,
         delhi_wins         = r.delhi_wins         + EXCLUDED.delhi_wins,
         bombay_wins        = r.bombay_wins        + EXCLUDED.bombay_wins,
         cancelled          = r.cancelled          + EXCLUDED.cancelled,
         real_staked_paise  = r.real_staked_paise  + EXCLUDED.real_staked_paise,
         house_staked_paise = r.house_staked_paise + EXCLUDED.house_staked_paise,
         paid_out_paise     = r.paid_out_paise     + EXCLUDED.paid_out_paise,
         net_profit_paise   = r.net_profit_paise   + EXCLUDED.net_profit_paise,
         fees_paise         = r.fees_paise         + EXCLUDED.fees_paise,
         updated_at         = now()`,
      [ids],
    );
    await client.query('DELETE FROM cycle_settlements WHERE cycle_id = ANY($1::text[])', [ids]);
    const { rowCount } = await client.query('DELETE FROM cycles WHERE cycle_id = ANY($1::text[])', [ids]);
    return { pruned: rowCount };
  });
}

/**
 * The daily summaries, newest day first, for Admin › Cycle History.
 * @returns {Promise<Array<object>>} figures in rupees
 */
export async function listRollups({ cycleType = null, audience = null, limit = 90 } = {}) {
  const { rows } = await pgQuery(
    `SELECT *, ist_day::text AS day FROM cycle_history_rollups
      WHERE ($1::text IS NULL OR cycle_type = $1) AND ($2::text IS NULL OR audience = $2)
      ORDER BY ist_day DESC, cycle_type, audience
      LIMIT $3`,
    [cycleType, audience, Math.min(Math.max(Number(limit) || 90, 1), 1000)], 'cycle_rollups_list',
  );
  return rows.map((r) => ({
    cycleType: r.cycle_type,
    audience: r.audience,
    day: r.day,
    rounds: r.rounds,
    delhiWins: r.delhi_wins,
    bombayWins: r.bombay_wins,
    cancelled: r.cancelled,
    realStaked: paiseToRupees(Number(r.real_staked_paise)),
    houseStaked: paiseToRupees(Number(r.house_staked_paise)),
    paidOut: paiseToRupees(Number(r.paid_out_paise)),
    netProfit: paiseToRupees(Number(r.net_profit_paise)),
    fees: paiseToRupees(Number(r.fees_paise)),
  }));
}
