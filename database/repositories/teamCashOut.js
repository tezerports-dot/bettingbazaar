// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A pool's cash out, and the pause after it (owner, 2026-10-21). The one
 * writer of `teams.cash_out_started_at`, `cash_out_by` and `paused_until`.
 *
 * A merchant (a team's supervisor, or a merchant account's owner) turns the
 * pool's tokens into cash by serving BUYS only: a sell adds tokens back, so
 * from the start no new sell is routed to the pool and its buys go first
 * (`teamRouting.js`). The sells and disputes it already has stay with it. The
 * cash out ends when the pool cannot cover the smallest buy it could be sent
 * and no buy of it is open (`finishCashOut`, from the cron), or when its
 * holder stops it; either way a pause of `CASH_OUT_PAUSE_HOURS` follows, in
 * which nothing new is routed to it and it buys no tokens. While a request to
 * buy tokens waits, a cash out is not started: one asks for tokens, the other
 * gives them up.
 *
 * Every guard is in the UPDATE's WHERE (trap 18); a refusal re-reads the row
 * only to say why.
 */
import { pgQuery, withTransaction } from '../client.js';

/** The pause after a cash out (owner, 2026-10-21: "then 48h pause"). */
export const CASH_OUT_PAUSE_HOURS = 48;

/** The states a buy is open in, for the end of a cash out (disputes do not hold it open). */
const OPEN_BUY_STATES = ['PROCESSING', 'PAID'];

const ownedBy = 'team_id = $1 AND (supervisor_id = $2 OR owner_merchant_id = $2)';

/** The team's cash-out state, as the panels draw it. */
export function toCashOut(row) {
  const pausedUntil = row?.paused_until ? new Date(row.paused_until) : null;
  const paused = pausedUntil !== null && pausedUntil.getTime() > Date.now();
  return {
    active: Boolean(row?.cash_out_started_at),
    startedAt: row?.cash_out_started_at ?? null,
    pausedUntil: paused ? pausedUntil.toISOString() : null,
    pauseHours: CASH_OUT_PAUSE_HOURS,
  };
}

async function whyNot(teamId, merchantId) {
  const { rows } = await pgQuery(
    `SELECT cash_out_started_at, paused_until,
            (paused_until IS NOT NULL AND paused_until > now()) AS paused,
            EXISTS (SELECT 1 FROM team_pool_requests r WHERE r.team_id = teams.team_id AND r.status = 'PENDING') AS pending
       FROM teams WHERE ${ownedBy}`,
    [String(teamId), String(merchantId)], 'team_cash_out_why');
  const r = rows[0];
  if (!r) return { ok: false, reason: 'team_not_found' };
  if (r.cash_out_started_at) return { ok: false, reason: 'cash_out_running' };
  if (r.paused) return { ok: false, reason: 'cash_out_paused', pausedUntil: new Date(r.paused_until).toISOString() };
  if (r.pending) return { ok: false, reason: 'request_pending' };
  return { ok: false, reason: 'cash_out_not_running' };
}

/**
 * Start a cash out of the pool `teamId`, as its supervisor or owner `merchantId`.
 * The team row is locked first, and the waiting request is asked in the
 * statement after, so a request to buy tokens (which takes the same lock,
 * `teamPools.createRequestWithin`) and a cash out never both get in (S6).
 */
export async function startCashOut({ teamId, merchantId }) {
  const out = await withTransaction(async (client) => {
    const { rows: own } = await client.query(`SELECT team_id FROM teams WHERE ${ownedBy} FOR UPDATE`,
      [String(teamId), String(merchantId)]);
    if (!own[0]) return null;
    const { rows } = await client.query(
      `UPDATE teams SET cash_out_started_at = now(), cash_out_by = $2, paused_until = NULL, updated_at = now()
        WHERE ${ownedBy}
          AND cash_out_started_at IS NULL
          AND (paused_until IS NULL OR paused_until <= now())
          AND NOT EXISTS (SELECT 1 FROM team_pool_requests r WHERE r.team_id = teams.team_id AND r.status = 'PENDING')
        RETURNING cash_out_started_at, paused_until`,
      [String(teamId), String(merchantId)]);
    return rows[0] ?? null;
  });
  if (!out) return whyNot(teamId, merchantId);
  return { ok: true, cashOut: toCashOut(out) };
}

/** Stop a running cash out early: the pause starts now. */
export async function stopCashOut({ teamId, merchantId }) {
  const { rows } = await pgQuery(
    `UPDATE teams SET cash_out_started_at = NULL, cash_out_by = NULL,
            paused_until = now() + make_interval(hours => $3), updated_at = now()
      WHERE ${ownedBy} AND cash_out_started_at IS NOT NULL
      RETURNING cash_out_started_at, paused_until`,
    [String(teamId), String(merchantId), CASH_OUT_PAUSE_HOURS], 'team_cash_out_stop');
  if (!rows[0]) return whyNot(teamId, merchantId);
  return { ok: true, cashOut: toCashOut(rows[0]) };
}

/**
 * The pools cashing out, with what the cron needs to judge them: the rail
 * (an agent team's supervisor's) and the kind, to find the smallest buy each
 * could be sent.
 */
export async function listCashingOut() {
  const { rows } = await pgQuery(
    `SELECT t.team_id, t.kind, s.supervisor_rail AS rail
       FROM teams t LEFT JOIN merchants s ON s.merchant_id = t.supervisor_id
      WHERE t.cash_out_started_at IS NOT NULL`,
    [], 'team_cash_out_list');
  return rows.map((r) => ({ teamId: r.team_id, kind: r.kind, rail: r.rail }));
}

/**
 * End the cash out of `teamId` if its pool can no longer cover `smallestBuyPaise`
 * (null: no buy could reach it at all) and no buy of it is open. The test is
 * the WHERE: a buy assigned a moment ago keeps it running.
 */
export async function finishCashOut(teamId, smallestBuyPaise) {
  const { rows } = await pgQuery(
    `UPDATE teams t SET cash_out_started_at = NULL, cash_out_by = NULL,
            paused_until = now() + make_interval(hours => $3), updated_at = now()
      WHERE t.team_id = $1 AND t.cash_out_started_at IS NOT NULL
        AND ($2::bigint IS NULL OR COALESCE((SELECT p.available_paise FROM team_pools p WHERE p.team_id = t.team_id), 0) < $2::bigint)
        AND NOT EXISTS (SELECT 1 FROM order_states o
                         WHERE o.team_id = t.team_id AND o.order_type = 'DEPOSIT' AND o.state = ANY($4))
      RETURNING paused_until`,
    [String(teamId), smallestBuyPaise ?? null, CASH_OUT_PAUSE_HOURS, OPEN_BUY_STATES], 'team_cash_out_finish');
  return rows[0] ? { ok: true, pausedUntil: new Date(rows[0].paused_until).toISOString() } : { ok: false };
}
