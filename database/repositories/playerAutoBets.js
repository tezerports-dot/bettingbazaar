// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Player auto bets (owner, 2026-10-22): the one writer of `player_auto_bets`
 * (schema.sql "PLAYER AUTO BETS"). The rules are
 * backend/domains/markets/autoBets.js; the bets themselves are ordinary
 * player bets, placed through playerBet.service.js with `auto_plan_id`.
 *
 * A plan's standing (step, net, rounds played) is counted from its bets on
 * every read, never kept (trap 6): net = what its settled bets paid back less
 * what every bet staked (a pending stake counts as spent; a void or refunded
 * bet as nothing), and the step = losses in a row since its last win, modulo
 * its steps (`stepOf`).
 */
import { randomUUID } from 'node:crypto';
import { pgQuery } from '../client.js';
import { AUDIENCES } from './markets.js';
import { stepOf, AUTO_STOP_REASONS } from '../../backend/domains/markets/autoBets.js';

const STANDING_SQL = `
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE b.status IN ('WON','LOST'))::int        AS played,
           COUNT(*) FILTER (WHERE b.status = 'WON')::int                  AS won,
           COUNT(*) FILTER (WHERE b.status = 'PENDING')::int              AS pending,
           COALESCE(SUM(CASE WHEN b.status IN ('WON','LOST','PENDING')
                             THEN b.payout_paise - b.stake_paise ELSE 0 END), 0)::bigint AS net_paise,
           COALESCE(SUM(b.stake_paise) FILTER (WHERE b.status IN ('WON','LOST','PENDING')), 0)::bigint AS staked_paise,
           MAX(b.placed_at) FILTER (WHERE b.status = 'WON')               AS last_win_at,
           MAX(b.placed_at)                                               AS last_bet_at
      FROM bets b WHERE b.auto_plan_id = p.plan_id
  ) s ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS losses_in_a_row
      FROM bets b
     WHERE b.auto_plan_id = p.plan_id AND b.status = 'LOST'
       AND (s.last_win_at IS NULL OR b.placed_at > s.last_win_at)
  ) t ON TRUE`;

const toPlan = (r) => {
  const stakesPaise = r.stakes_paise.map(Number);
  const step = stepOf(Number(r.losses_in_a_row ?? 0), stakesPaise.length);
  return {
    planId: r.plan_id,
    userId: r.user_id,
    boardKey: r.board_key,
    audience: r.audience,
    side: r.side,
    factor: r.factor_x100 / 100,
    stakesPaise,
    stakes: stakesPaise.map((p) => p / 100),
    budgetPaise: Number(r.budget_paise),
    stopLossPaise: Number(r.stop_loss_paise),
    takeProfitPaise: Number(r.take_profit_paise),
    startedAt: r.started_at,
    stoppedAt: r.stopped_at,
    stopReason: r.stop_reason,
    running: r.stopped_at === null,
    // Standing, from the bets.
    played: Number(r.played ?? 0),
    won: Number(r.won ?? 0),
    pending: Number(r.pending ?? 0),
    netPaise: Number(r.net_paise ?? 0),
    stakedPaise: Number(r.staked_paise ?? 0),
    lastBetAt: r.last_bet_at ?? null,
    step,
    nextStakePaise: stakesPaise[step],
  };
};

/**
 * Start a plan. Answers { ok: true, plan } or { ok: false, reason:
 * 'already_running' } when this player already runs one on this board and
 * profile (`player_auto_bets_one_running`).
 */
export async function startPlan({
  userId, boardKey, audience, side, startPaise, factorX100, stakesPaise, budgetPaise, stopLossPaise, takeProfitPaise,
}) {
  if (!AUDIENCES.includes(audience)) {
    throw Object.assign(new Error('Pick VIP or General for this plan.'), { status: 400, code: 'AUTO_BETS_INVALID' });
  }
  const planId = `ap_${randomUUID().replace(/-/g, '')}`;
  try {
    await pgQuery(
      `INSERT INTO player_auto_bets
         (plan_id, user_id, board_key, audience, side, start_paise, factor_x100, stakes_paise,
          budget_paise, stop_loss_paise, take_profit_paise)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint[], $9, $10, $11)`,
      [planId, String(userId), String(boardKey), audience, side, startPaise, factorX100, stakesPaise,
        budgetPaise, stopLossPaise, takeProfitPaise],
      'player_auto_start',
    );
  } catch (e) {
    if (e.code === '23505' && /player_auto_bets_one_running/.test(e.constraint || e.message)) {
      return { ok: false, reason: 'already_running' };
    }
    throw e;
  }
  return { ok: true, plan: await planOf(planId) };
}

/**
 * Stop a running plan, once. `userId` scopes it to its owner (the player's
 * Stop); the runner passes the plan's own. Answers whether this call stopped it.
 */
export async function stopPlan({ planId, userId, reason }) {
  if (!AUTO_STOP_REASONS.includes(reason)) throw new TypeError(`stopPlan: unknown reason ${reason}`);
  const { rowCount } = await pgQuery(
    `UPDATE player_auto_bets SET stopped_at = now(), stop_reason = $3
      WHERE plan_id = $1 AND user_id = $2 AND stopped_at IS NULL`,
    [String(planId), String(userId), reason],
    'player_auto_stop',
  );
  return rowCount === 1;
}

/** One plan with its standing, or null. */
export async function planOf(planId) {
  const { rows } = await pgQuery(
    `SELECT p.*, s.*, t.* FROM player_auto_bets p ${STANDING_SQL} WHERE p.plan_id = $1`,
    [String(planId)], 'player_auto_plan_of',
  );
  return rows[0] ? toPlan(rows[0]) : null;
}

/** This player's running plans and their latest stopped ones, newest first. */
export async function plansOf(userId, { stoppedLimit = 10 } = {}) {
  const { rows } = await pgQuery(
    `SELECT p.*, s.*, t.* FROM (
        (SELECT * FROM player_auto_bets WHERE user_id = $1 AND stopped_at IS NULL)
        UNION ALL
        (SELECT * FROM player_auto_bets WHERE user_id = $1 AND stopped_at IS NOT NULL
          ORDER BY stopped_at DESC LIMIT $2)
     ) p ${STANDING_SQL}
     ORDER BY p.stopped_at DESC NULLS FIRST, p.started_at DESC`,
    [String(userId), stoppedLimit], 'player_auto_plans_of',
  );
  return rows.map(toPlan);
}

/** Every running plan's id, board and profile: the runner's cheap first read each tick. */
export async function runningPlanKeys() {
  const { rows } = await pgQuery(
    'SELECT plan_id, board_key, audience FROM player_auto_bets WHERE stopped_at IS NULL',
    [], 'player_auto_running_keys',
  );
  return rows.map((r) => ({ planId: r.plan_id, boardKey: r.board_key, audience: r.audience }));
}

/**
 * The named plans that are still running and whose player may still bet (an
 * open, unblocked player account: what authenticatePlayer asks), with their
 * standing and whether the player tests during maintenance. Asked on every
 * tick the runner has a round to bet, so blocking a player stops their bets
 * at once.
 */
export async function runnablePlans(planIds) {
  if (!planIds.length) return [];
  const { rows } = await pgQuery(
    `SELECT p.*, s.*, t.*, u.maintenance_tester FROM player_auto_bets p
       JOIN users u ON u.user_id = p.user_id
       ${STANDING_SQL}
      WHERE p.plan_id = ANY($1::text[]) AND p.stopped_at IS NULL
        AND u.account_type = 'PLAYER' AND u.status <> 'DELETED' AND NOT u.is_blocked`,
    [planIds], 'player_auto_runnable',
  );
  return rows.map((r) => ({ ...toPlan(r), maintenanceTester: r.maintenance_tester === true }));
}
