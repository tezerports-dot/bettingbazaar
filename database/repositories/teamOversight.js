// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Oversight of teams (owner, 2026-10-02 — PROJECT_STATUS §3.10, Step 2f).
 *
 * What a member did, read one way for every screen and for the daily red
 * flags (§32 S11):
 *   COMPLETED ORDERS — orders of the team assigned to the member whose
 *                      `completed_at` falls in the window. Every path that
 *                      completes an order stamps it (the member's confirm,
 *                      the sell settlement, an admin's approval or dispute
 *                      decision); a sell settled by the hold worker writes no
 *                      COMPLETED transition, so the transitions cannot be
 *                      the measure;
 *   ONLINE TIME      — the stretches the member's Online switch was on
 *                      (`merchant_online_sessions`, written by a trigger on
 *                      `merchants.is_online`), clipped to the window.
 *
 * ── Red flags are prompts, never actions ─────────────────────────────────────
 * `evaluateRedFlags` is the one writer of `team_red_flags`. It runs once per
 * IST day: the INSERT of the day's `team_red_flag_days` row is the once-only
 * guard, in the same transaction as the flags (§32 S6). Nothing reads a flag to
 * block, pause, route or pay (owner: "flag only — the supervisor decides").
 *
 *   LOW_ACTIVITY  a member whose completed orders AND online time were both
 *                 below the team's average by `lowActivityPercent`.
 *
 * There is no commission-farming flag (owner, 2026-10-04): the 90:10
 * deposit/reserve split and the 1% winnings fee make a farming round cost
 * more than the commission it earns.
 */
import { pgQuery, withTransaction } from '../client.js';

export const RED_FLAG_KINDS = Object.freeze({
  LOW_ACTIVITY: 'LOW_ACTIVITY',
});

/**
 * The red-flag settings, with the schema defaults (config.spec.js redFlags)
 * for any key absent from the stored document.
 */
export function redFlagSettings(cfg) {
  const r = cfg?.redFlags ?? {};
  return {
    lowActivityPercent: Number(r.lowActivityPercent ?? 25), // schema default: 25
  };
}

/** The bounds of an IST day ('YYYY-MM-DD'), as instants, by the database's clock. */
const DAY_BOUNDS = `SELECT ($1::date)::timestamp AT TIME ZONE 'Asia/Kolkata' AS d0,
                           ($1::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata' AS d1`;


/**
 * Each approved member of a team with what they did between $2 and $3:
 * completed orders, their tokens, and seconds online. A member approved after
 * the window ended is not in it. `now()` closes a stretch still open.
 */
const ACTIVITY_SQL = `
  WITH done AS (
    SELECT os.merchant_id, count(*)::int AS completed_orders, SUM(os.token_amount_paise) AS completed_paise
      FROM order_states os
     WHERE os.team_id = $1 AND os.completed_at >= $2 AND os.completed_at < $3
     GROUP BY os.merchant_id),
  online AS (
    SELECT s.merchant_id,
           SUM(GREATEST(0, EXTRACT(EPOCH FROM LEAST(COALESCE(s.ended_at, now()), $3) - GREATEST(s.started_at, $2))))
             AS online_seconds
      FROM merchant_online_sessions s
     WHERE s.merchant_id IN (SELECT merchant_id FROM team_members WHERE team_id = $1)
       AND s.started_at < $3 AND COALESCE(s.ended_at, now()) > $2
     GROUP BY s.merchant_id)
  SELECT tm.merchant_id, m.name, m.public_ref, m.is_online,
         COALESCE(d.completed_orders, 0) AS completed_orders,
         COALESCE(d.completed_paise, 0)  AS completed_paise,
         COALESCE(o.online_seconds, 0)   AS online_seconds
    FROM team_members tm
    JOIN merchants m ON m.merchant_id = tm.merchant_id
    LEFT JOIN done d ON d.merchant_id = tm.merchant_id
    LEFT JOIN online o ON o.merchant_id = tm.merchant_id
   WHERE tm.team_id = $1 AND tm.status = 'APPROVED' AND tm.approved_at < $3
   ORDER BY m.name, tm.merchant_id`;

function toActivity(r) {
  return {
    merchantId: r.merchant_id,
    name: r.name,
    publicRef: r.public_ref,
    isOnline: r.is_online,
    completedOrders: Number(r.completed_orders),
    // BIGINT and NUMERIC arrive as strings (trap 5).
    completedPaise: Number(r.completed_paise),
    onlineSeconds: Number(r.online_seconds),
  };
}

async function activityWith(q, teamId, from, to) {
  const { rows } = await q(ACTIVITY_SQL, [String(teamId), from, to]);
  return rows.map(toActivity);
}

/**
 * What each approved member of a team did over the last `days` IST days,
 * today included (so `days: 1` is today so far).
 */
export async function teamActivity(teamId, { days = 7 } = {}) {
  const span = Math.min(Math.max(Math.trunc(Number(days)) || 7, 1), 31);
  const { rows: [b] } = await pgQuery(
    `SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date - ($1::int - 1))::timestamp AT TIME ZONE 'Asia/Kolkata' AS d0,
            now() AS d1`, [span], 'oversight_window');
  const q = (sql, params) => pgQuery(sql, params, 'oversight_activity');
  return { days: span, from: b.d0, members: await activityWith(q, teamId, b.d0, b.d1) };
}

/**
 * The low-activity rule, on one team's day (owner: below the team's average
 * by the threshold, in BOTH completed orders and online time). Fewer than two
 * members is no average to fall below. A team that did nothing flags nobody:
 * nothing is below an average of zero.
 */
export function lowActivityFlags(members, percent) {
  if (members.length < 2) return [];
  const avg = (key) => members.reduce((s, m) => s + m[key], 0) / members.length;
  const keep = (100 - Number(percent)) / 100;
  const orderCut = avg('completedOrders') * keep;
  const onlineCut = avg('onlineSeconds') * keep;
  return members
    .filter((m) => m.completedOrders < orderCut && m.onlineSeconds < onlineCut)
    .map((m) => ({
      merchantId: m.merchantId,
      details: {
        completedOrders: m.completedOrders,
        onlineSeconds: Math.round(m.onlineSeconds),
        teamAverageOrders: Number(avg('completedOrders').toFixed(2)),
        teamAverageOnlineSeconds: Math.round(avg('onlineSeconds')),
        members: members.length,
        percent: Number(percent),
      },
    }));
}

/**
 * Evaluate one IST day ('YYYY-MM-DD') for every team, once. Returns
 * `{ evaluated: false }` when the day was already evaluated (here or by
 * another instance), else what was flagged.
 */
export async function evaluateRedFlags(flagDay, settings) {
  const day = String(flagDay);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw Object.assign(new Error('flagDay is YYYY-MM-DD'), { status: 400 });
  const s = redFlagSettings({ redFlags: settings });
  return withTransaction(async (client) => {
    const claimed = await client.query(
      `INSERT INTO team_red_flag_days (flag_day, settings) VALUES ($1, $2)
       ON CONFLICT (flag_day) DO NOTHING RETURNING flag_day`, [day, JSON.stringify(s)]);
    if (!claimed.rowCount) return { evaluated: false };
    const { rows: [b] } = await client.query(DAY_BOUNDS, [day]);
    const insert = (kind, teamId, merchantId, details) => client.query(
      `INSERT INTO team_red_flags (kind, flag_day, team_id, merchant_id, details) VALUES ($1, $2, $3, $4, $5)`,
      [kind, day, teamId, merchantId, JSON.stringify(details)]);

    let lowActivity = 0;
    const { rows: teamRows } = await client.query('SELECT team_id FROM teams ORDER BY team_id');
    const q = (sql, params) => client.query(sql, params);
    for (const { team_id: teamId } of teamRows) {
      const members = await activityWith(q, teamId, b.d0, b.d1);
      for (const f of lowActivityFlags(members, s.lowActivityPercent)) {
        await insert(RED_FLAG_KINDS.LOW_ACTIVITY, teamId, f.merchantId, f.details);
        lowActivity += 1;
      }
    }
    return { evaluated: true, lowActivity };
  });
}

/**
 * The IST days that have ended (ten minutes past midnight, so an order that
 * completed at 23:59 has committed) and were not evaluated, the last three at
 * most, oldest first — so a missed night is caught up.
 */
export async function daysToEvaluate() {
  const { rows } = await pgQuery(
    `WITH t AS (SELECT ((now() - interval '10 minutes') AT TIME ZONE 'Asia/Kolkata')::date AS today)
     SELECT to_char(d, 'YYYY-MM-DD') AS day
       FROM t, generate_series(t.today - 3, t.today - 1, interval '1 day') d
      WHERE NOT EXISTS (SELECT 1 FROM team_red_flag_days f WHERE f.flag_day = d::date)
      ORDER BY d`, [], 'oversight_days_due');
  return rows.map((r) => r.day);
}

function toFlag(r) {
  return {
    flagId: String(r.flag_id),
    kind: r.kind,
    flagDay: r.flag_day,
    teamId: r.team_id,
    teamName: r.team_name,
    supervisorId: r.supervisor_id,
    merchantId: r.merchant_id,
    merchantName: r.merchant_name,
    merchantRef: r.merchant_ref,
    details: r.details,
    createdAt: r.created_at,
  };
}

/**
 * Red flags from the last `days` days, newest first. `supervisorId` scopes to
 * that supervisor's teams (in the WHERE, trap 16). A supervisor is shown every
 * kind: a kind added for admins only needs its own filter here.
 */
export async function listRedFlags({ supervisorId = null, days = 14, limit = 200 } = {}) {
  const { rows } = await pgQuery(
    `SELECT f.flag_id, f.kind, to_char(f.flag_day, 'YYYY-MM-DD') AS flag_day, f.team_id, t.name AS team_name,
            t.supervisor_id, f.merchant_id, m.name AS merchant_name, m.public_ref AS merchant_ref,
            f.details, f.created_at
       FROM team_red_flags f
       JOIN teams t ON t.team_id = f.team_id
       JOIN merchants m ON m.merchant_id = f.merchant_id
      WHERE ($1::text IS NULL OR t.supervisor_id = $1)
        AND f.flag_day >= (now() AT TIME ZONE 'Asia/Kolkata')::date - $2::int
      ORDER BY f.flag_day DESC, f.team_id, f.kind, m.name
      LIMIT $3`,
    [supervisorId === null ? null : String(supervisorId),
      Math.min(Math.max(Math.trunc(Number(days)) || 14, 1), 90), Math.min(Math.max(Number(limit) || 200, 1), 1000)],
    'oversight_list_flags');
  return rows.map(toFlag);
}

/**
 * The APPROVED member `merchantId`, only when they are in one of
 * `supervisorId`'s teams (in the WHERE: another supervisor's member matches no
 * row, trap 16). A proposed member is not one yet: a supervisor can propose any
 * merchant not in a team, and proposing must not open their log.
 */
export async function memberOfSupervisor(merchantId, supervisorId) {
  const { rows } = await pgQuery(
    `SELECT tm.merchant_id, tm.team_id, tm.approved_at, t.name AS team_name, m.name, m.public_ref, m.is_online
       FROM team_members tm JOIN teams t ON t.team_id = tm.team_id JOIN merchants m ON m.merchant_id = tm.merchant_id
      WHERE tm.merchant_id = $1 AND t.supervisor_id = $2 AND tm.status = 'APPROVED'`,
    [String(merchantId), String(supervisorId)], 'oversight_member_of');
  const r = rows[0];
  return r ? {
    merchantId: r.merchant_id, teamId: r.team_id, teamName: r.team_name, approvedAt: r.approved_at,
    name: r.name, publicRef: r.public_ref, isOnline: r.is_online,
  } : null;
}

/**
 * A member's online stretches over the last `days` days, newest first, cut at
 * `since` when given (the moment they joined the team: what came before was
 * not that team's, and may have been another supervisor's).
 */
export async function onlineSessions(merchantId, { days = 7, limit = 200, since = null } = {}) {
  const { rows } = await pgQuery(
    `SELECT GREATEST(started_at, $4::timestamptz) AS started_at, ended_at,
            EXTRACT(EPOCH FROM COALESCE(ended_at, now()) - GREATEST(started_at, $4::timestamptz)) AS seconds
       FROM merchant_online_sessions
      WHERE merchant_id = $1 AND COALESCE(ended_at, now()) > now() - make_interval(days => $2::int)
        AND COALESCE(ended_at, now()) > COALESCE($4::timestamptz, '-infinity')
      ORDER BY started_at DESC LIMIT $3`,
    [String(merchantId), Math.min(Math.max(Math.trunc(Number(days)) || 7, 1), 31), Math.min(Math.max(Number(limit) || 200, 1), 500), since],
    'oversight_sessions');
  return rows.map((r) => ({ startedAt: r.started_at, endedAt: r.ended_at, seconds: Math.round(Number(r.seconds)) }));
}

/**
 * The columns an order shows its member's supervisor: what the order was and
 * how it went, nothing about the player (§24). `toSupervisorOrderView`
 * (merchantOrderView.js) is the allowlist the response goes through.
 */
const SUPERVISOR_ORDER_SELECT = `
  SELECT os.order_id, os.merchant_id, os.order_type, os.state, os.currency,
         os.token_amount_paise, os.payment_mode, os.created_at, os.updated_at,
         os.dispute_raised_at, os.dispute_raised_by, os.dispute_reason, os.dispute_resolved_at, os.dispute_decision,
         os.rejected_reason
    FROM order_states os`;

function toSupervisorOrderRow(r) {
  return {
    orderId: r.order_id,
    merchantId: r.merchant_id,
    type: r.order_type,
    status: r.state,
    currency: r.currency,
    // Tokens, never fiat: the one unit every rail shares (trap 15).
    tokenAmount: Number(r.token_amount_paise) / 100,
    paymentMode: r.payment_mode,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    disputeRaisedAt: r.dispute_raised_at,
    disputeRaisedBy: r.dispute_raised_by,
    disputeReason: r.dispute_reason,
    disputeResolvedAt: r.dispute_resolved_at,
    disputeDecision: r.dispute_decision,
    rejectedReason: r.rejected_reason,
  };
}

/** A member's orders in their supervisor's teams, newest first. */
export async function memberOrders(merchantId, supervisorId, { limit = 50 } = {}) {
  const { rows } = await pgQuery(
    `${SUPERVISOR_ORDER_SELECT}
      WHERE os.merchant_id = $1
        AND os.team_id IN (SELECT team_id FROM teams WHERE supervisor_id = $2)
      ORDER BY os.created_at DESC LIMIT $3`,
    [String(merchantId), String(supervisorId), Math.min(Math.max(Number(limit) || 50, 1), 200)],
    'oversight_member_orders');
  return rows.map(toSupervisorOrderRow);
}

/**
 * Disputed orders of the supervisor's teams — open ones first, then those
 * decided in the last `days` days.
 */
export async function supervisorDisputes(supervisorId, { days = 30, limit = 100 } = {}) {
  const { rows } = await pgQuery(
    `${SUPERVISOR_ORDER_SELECT}
      WHERE os.team_id IN (SELECT team_id FROM teams WHERE supervisor_id = $1)
        AND os.dispute_raised_at IS NOT NULL
        AND (os.state = 'DISPUTED' OR os.dispute_raised_at > now() - make_interval(days => $2::int))
      ORDER BY (os.state = 'DISPUTED') DESC, os.dispute_raised_at DESC LIMIT $3`,
    [String(supervisorId), Math.min(Math.max(Math.trunc(Number(days)) || 30, 1), 90), Math.min(Math.max(Number(limit) || 100, 1), 200)],
    'oversight_disputes');
  return rows.map(toSupervisorOrderRow);
}

/** One disputed order of the supervisor's teams, or null (another team's order matches no row, trap 16). */
export async function supervisorDispute(orderId, supervisorId) {
  const { rows } = await pgQuery(
    `${SUPERVISOR_ORDER_SELECT}
      WHERE os.order_id = $1 AND os.dispute_raised_at IS NOT NULL
        AND os.team_id IN (SELECT team_id FROM teams WHERE supervisor_id = $2)`,
    [String(orderId), String(supervisorId)], 'oversight_dispute');
  return rows[0] ? toSupervisorOrderRow(rows[0]) : null;
}
