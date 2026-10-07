// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Supervisors and their teams (owner, 2026-10-02 — PROJECT_STATUS §3.10, 2a).
 *
 * A SUPERVISOR is a merchant with `is_supervisor` and one rail. It runs up to
 * MAX_TEAMS teams of exactly TEAM_SIZE approved members. A member is in one
 * team at most (`team_members.merchant_id` is the primary key).
 *
 * ── Every cap is asked inside the write, under a lock ────────────────────────
 * "Fewer than four teams" and "fewer than ten members" are counts of sibling
 * rows, which no CHECK can see. Each writer takes the PARENT row FOR UPDATE —
 * the supervisor for a new team, the team for a new member — counts, and
 * writes in the same transaction. Two requests arriving together serialise on
 * that lock, so the second counts what the first wrote (§32 S6).
 *
 * ── Strength ────────────────────────────────────────────────────────────────
 * A team works only at TEAM_SIZE. One that DROPS below it keeps working until
 * the end of that day in IST, then stops until it is full again (owner).
 * `short_since` records the drop; `was_full` separates a team that dropped
 * from one that has never been full (and so never worked). Both are written in
 * the same transaction as the membership change that moves them, so the
 * strength a reader sees cannot disagree with the members it is derived from.
 */
import { pgQuery, withTransaction } from '../client.js';
import { randomBytes } from 'node:crypto';
import { teamVolumeSql, teamMarkSql, toSummary } from './teamCommission.js';
import { textHasAMobile } from '../../backend/domains/identity/mobileInText.js';

export const MAX_TEAMS = 4;
export const TEAM_SIZE = 10;
export const SUPERVISOR_RAILS = Object.freeze(['CASH', 'UPI_BANK', 'USDT']);

const newTeamId = () => `team_${randomBytes(10).toString('hex')}`;

/**
 * The team's working state, computed by the database's clock.
 *   WORKING — ten approved members.
 *   GRACE   — dropped below ten today (IST); still takes orders until midnight.
 *   STOPPED — below ten, and either never full or the grace day has passed.
 */
export const STRENGTH_SQL = `CASE
    WHEN approved_count >= ${TEAM_SIZE} THEN 'WORKING'
    WHEN t.short_since IS NOT NULL
     AND (t.short_since AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
      THEN 'GRACE'
    ELSE 'STOPPED' END`;

const TEAM_SELECT = `
  SELECT t.team_id, t.supervisor_id, t.name, t.short_since, t.was_full, t.created_at,
         s.name AS supervisor_name, s.public_ref AS supervisor_ref, s.supervisor_rail AS rail,
         c.approved_count, c.pending_count,
         COALESCE(p.available_paise, 0) AS pool_available_paise,
         COALESCE(p.held_paise, 0)      AS pool_held_paise,
         v.buys_paise, v.sells_paise, k.high_paise, k.paid_paise,
         ${STRENGTH_SQL} AS strength
    FROM teams t
    JOIN merchants s ON s.merchant_id = t.supervisor_id
    LEFT JOIN team_pools p ON p.team_id = t.team_id
    CROSS JOIN LATERAL (${teamVolumeSql('t.team_id')}) v
    CROSS JOIN LATERAL (${teamMarkSql('t.team_id')}) k
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE status = 'APPROVED')::int AS approved_count,
             count(*) FILTER (WHERE status = 'PENDING')::int  AS pending_count
        FROM team_members WHERE team_id = t.team_id) c`;

function toTeam(row) {
  if (!row) return null;
  return {
    teamId: row.team_id,
    supervisorId: row.supervisor_id,
    supervisorName: row.supervisor_name,
    supervisorRef: row.supervisor_ref,
    name: row.name,
    rail: row.rail,
    approvedCount: Number(row.approved_count),
    pendingCount: Number(row.pending_count),
    size: TEAM_SIZE,
    strength: row.strength,
    // The team's tokens (Step 2b). BIGINT arrives as a string (trap 5).
    poolAvailablePaise: Number(row.pool_available_paise ?? 0),
    poolHeldPaise: Number(row.pool_held_paise ?? 0),
    // Step 2e: matched volume, the high-water mark, what has been paid, and
    // what is earned but waiting for the commission pool.
    commission: toSummary(row.team_id, row),
    shortSince: row.short_since,
    wasFull: row.was_full,
    createdAt: row.created_at,
  };
}

function toMember(row) {
  return {
    merchantId: row.merchant_id,
    teamId: row.team_id,
    name: row.name,
    publicRef: row.public_ref,
    status: row.status,
    isOnline: row.is_online,
    addedBy: row.added_by,
    addedAt: row.added_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
  };
}

const MEMBER_SELECT = `
  SELECT tm.merchant_id, tm.team_id, tm.status, tm.added_by, tm.added_at,
         tm.approved_by, tm.approved_at, m.name, m.public_ref, m.is_online
    FROM team_members tm JOIN merchants m ON m.merchant_id = tm.merchant_id`;

/**
 * Recompute a team's strength fields after a membership change, inside the
 * caller's transaction and under its lock on the team row.
 */
async function settleStrength(client, teamId) {
  await client.query(
    `UPDATE teams t SET
        was_full    = t.was_full OR c.n >= ${TEAM_SIZE},
        short_since = CASE
          WHEN c.n >= ${TEAM_SIZE} THEN NULL
          -- Dropping from full starts the grace day; already short keeps the
          -- day it started, so removing a second member cannot extend it.
          WHEN t.was_full THEN COALESCE(t.short_since, now())
          ELSE NULL END,
        updated_at  = now()
       FROM (SELECT count(*)::int AS n FROM team_members
              WHERE team_id = $1 AND status = 'APPROVED') c
      WHERE t.team_id = $1`,
    [teamId],
  );
}

// ── Supervisors ──────────────────────────────────────────────────────────────

/**
 * Make an approved merchant a supervisor on one rail, change that rail, or —
 * with `rail: null` — take the role away.
 *
 * Refused while the supervisor runs any team: a rail is what every order the
 * teams serve settles on, and changing it under live teams would change what
 * their members are routed (and what they are holding) mid-flight.
 */
export async function setSupervisorRole(merchantId, { rail }) {
  if (rail !== null && !SUPERVISOR_RAILS.includes(rail)) {
    throw Object.assign(new Error(`rail must be one of ${SUPERVISOR_RAILS.join(', ')}`), { status: 400 });
  }
  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT merchant_id, merchant_approval_status, is_supervisor
           FROM merchants WHERE merchant_id = $1 FOR UPDATE`, [String(merchantId)]);
      const m = rows[0];
      if (!m) return { ok: false, reason: 'not_found' };
      if (m.merchant_approval_status !== 'APPROVED') return { ok: false, reason: 'not_approved' };
      const { rows: t } = await client.query(
        'SELECT 1 FROM teams WHERE supervisor_id = $1 LIMIT 1', [String(merchantId)]);
      if (t.length) return { ok: false, reason: 'has_teams' };
      // Becoming a supervisor switches the merchant OFFLINE in the same
      // statement: a supervisor takes no orders and has no online switch
      // (`setOnline` refuses them), and a member promoted while online would
      // otherwise stay online, logging a member's online time (§2) for
      // somebody who is no longer one. The trigger on `is_online` closes the
      // open stretch. Taking the role away leaves the switch where it is.
      await client.query(
        `UPDATE merchants SET is_supervisor = $2, supervisor_rail = $3,
                is_online = is_online AND NOT $2,
                last_online_toggle = CASE WHEN $2 AND is_online THEN now() ELSE last_online_toggle END,
                updated_at = now()
          WHERE merchant_id = $1`,
        [String(merchantId), rail !== null, rail],
      );
      return { ok: true };
    });
  } catch (e) {
    if (e?.constraint === 'team_roles_disjoint') return { ok: false, reason: 'is_member' };
    throw e;
  }
}

export async function listSupervisors() {
  const { rows } = await pgQuery(
    `SELECT merchant_id, name, public_ref, supervisor_rail, is_online
       FROM merchants WHERE is_supervisor ORDER BY name`, [], 'teams_list_supervisors');
  return rows.map((r) => ({
    merchantId: r.merchant_id, name: r.name, publicRef: r.public_ref,
    rail: r.supervisor_rail, isOnline: r.is_online,
  }));
}

// ── Teams ────────────────────────────────────────────────────────────────────

/**
 * A team name as typed, or a 400 naming what is wrong with it. Its members see
 * it, so it may not carry a mobile number (the row's `teams_name_not_a_mobile`
 * holds the same rule for every writer; owner, 2026-10-03).
 */
function teamName(name) {
  const clean = String(name ?? '').trim();
  if (!clean || clean.length > 60) {
    throw Object.assign(new Error('A team name is 1–60 characters.'), { status: 400 });
  }
  if (textHasAMobile(clean)) {
    throw Object.assign(new Error('Take the phone number out of the team name: every member sees it.'), { status: 400 });
  }
  return clean;
}

export async function createTeam({ supervisorId, name }) {
  const clean = teamName(name);
  return withTransaction(async (client) => {
    // The lock every concurrent create for this supervisor queues on.
    const { rows } = await client.query(
      'SELECT is_supervisor FROM merchants WHERE merchant_id = $1 FOR UPDATE', [String(supervisorId)]);
    if (!rows[0]?.is_supervisor) return { ok: false, reason: 'not_supervisor' };
    const { rows: c } = await client.query(
      'SELECT count(*)::int AS n FROM teams WHERE supervisor_id = $1', [String(supervisorId)]);
    if (c[0].n >= MAX_TEAMS) return { ok: false, reason: 'team_limit' };
    const teamId = newTeamId();
    await client.query(
      'INSERT INTO teams (team_id, supervisor_id, name) VALUES ($1, $2, $3)',
      [teamId, String(supervisorId), clean]);
    return { ok: true, teamId };
  });
}

export async function renameTeam({ teamId, supervisorId, name }) {
  const clean = teamName(name);
  const { rowCount } = await pgQuery(
    `UPDATE teams SET name = $3, updated_at = now()
      WHERE team_id = $1 AND supervisor_id = $2`,
    [String(teamId), String(supervisorId), clean], 'teams_rename');
  return rowCount ? { ok: true } : { ok: false, reason: 'not_found' };
}

/**
 * A team with any member (pending or approved) is not deleted, nor one that
 * has ever traded tokens: its pool ledger is the record of where those tokens
 * went, and a deleted team would orphan it.
 */
export async function deleteTeam({ teamId, supervisorId }) {
  const { rowCount } = await pgQuery(
    `DELETE FROM teams t
      WHERE t.team_id = $1 AND t.supervisor_id = $2
        AND NOT EXISTS (SELECT 1 FROM team_members WHERE team_id = t.team_id)
        AND NOT EXISTS (SELECT 1 FROM team_pool_entries WHERE team_id = t.team_id)
        AND NOT EXISTS (SELECT 1 FROM team_pool_requests WHERE team_id = t.team_id)
        AND NOT EXISTS (SELECT 1 FROM team_red_flags WHERE team_id = t.team_id)`,
    [String(teamId), String(supervisorId)], 'teams_delete');
  if (rowCount) return { ok: true };
  const team = await getTeam(teamId);
  if (!team || team.supervisorId !== String(supervisorId)) return { ok: false, reason: 'not_found' };
  return { ok: false, reason: team.approvedCount + team.pendingCount > 0 ? 'has_members' : 'has_pool_history' };
}

export async function getTeam(teamId) {
  const { rows } = await pgQuery(`${TEAM_SELECT} WHERE t.team_id = $1`, [String(teamId)], 'teams_get');
  return toTeam(rows[0]);
}

export async function listTeams({ supervisorId = null } = {}) {
  const { rows } = await pgQuery(
    `${TEAM_SELECT} WHERE ($1::text IS NULL OR t.supervisor_id = $1)
      ORDER BY s.name, t.created_at`,
    [supervisorId === null ? null : String(supervisorId)], 'teams_list');
  return rows.map(toTeam);
}

export async function listMembers({ teamId = null, status = null } = {}) {
  const { rows } = await pgQuery(
    `${MEMBER_SELECT}
      WHERE ($1::text IS NULL OR tm.team_id = $1) AND ($2::text IS NULL OR tm.status = $2)
      ORDER BY tm.status, tm.added_at`,
    [teamId, status], 'teams_list_members');
  return rows.map(toMember);
}

/** The team a merchant is in (pending or approved), with their own row. */
export async function membershipOf(merchantId) {
  const { rows } = await pgQuery(`${MEMBER_SELECT} WHERE tm.merchant_id = $1`,
    [String(merchantId)], 'teams_membership');
  if (!rows[0]) return null;
  return { member: toMember(rows[0]), team: await getTeam(rows[0].team_id) };
}

// ── Members ──────────────────────────────────────────────────────────────────

/**
 * A supervisor proposes a merchant for a team, by merchant id or public ref.
 * The proposal is PENDING until an admin approves it. Pending and approved
 * together may not exceed TEAM_SIZE, so a team cannot queue more proposals
 * than it has places for.
 */
export async function addMember({ teamId, supervisorId, merchantRef, actor }) {
  const ref = String(merchantRef ?? '').trim();
  if (!ref) throw Object.assign(new Error('Enter the merchant ID to add.'), { status: 400 });
  try {
    return await withTransaction(async (client) => {
      const { rows: t } = await client.query(
        'SELECT team_id FROM teams WHERE team_id = $1 AND supervisor_id = $2 FOR UPDATE',
        [String(teamId), String(supervisorId)]);
      if (!t[0]) return { ok: false, reason: 'team_not_found' };
      const { rows: m } = await client.query(
        `SELECT merchant_id, merchant_approval_status, is_supervisor FROM merchants
          WHERE merchant_id = $1 OR public_ref = upper($1)`, [ref]);
      if (!m[0]) return { ok: false, reason: 'merchant_not_found' };
      if (m[0].is_supervisor) return { ok: false, reason: 'is_supervisor' };
      if (m[0].merchant_approval_status !== 'APPROVED') return { ok: false, reason: 'merchant_not_approved' };
      const { rows: c } = await client.query(
        'SELECT count(*)::int AS n FROM team_members WHERE team_id = $1', [String(teamId)]);
      if (c[0].n >= TEAM_SIZE) return { ok: false, reason: 'team_full' };
      const { rowCount } = await client.query(
        `INSERT INTO team_members (merchant_id, team_id, added_by) VALUES ($1, $2, $3)
         ON CONFLICT (merchant_id) DO NOTHING`,
        [m[0].merchant_id, String(teamId), String(actor)]);
      if (!rowCount) return { ok: false, reason: 'already_in_team' };
      return { ok: true, merchantId: m[0].merchant_id };
    });
  } catch (e) {
    if (e?.constraint === 'team_roles_disjoint') return { ok: false, reason: 'is_supervisor' };
    throw e;
  }
}

/** An admin approves a pending member. Refused if the team already has ten. */
export async function approveMember({ merchantId, actor }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT t.team_id FROM team_members tm JOIN teams t ON t.team_id = tm.team_id
        WHERE tm.merchant_id = $1 AND tm.status = 'PENDING'
        FOR UPDATE OF t`, [String(merchantId)]);
    if (!rows[0]) return { ok: false, reason: 'not_pending' };
    const teamId = rows[0].team_id;
    const { rows: c } = await client.query(
      `SELECT count(*)::int AS n FROM team_members WHERE team_id = $1 AND status = 'APPROVED'`, [teamId]);
    if (c[0].n >= TEAM_SIZE) return { ok: false, reason: 'team_full' };
    await client.query(
      `UPDATE team_members SET status = 'APPROVED', approved_by = $2, approved_at = now()
        WHERE merchant_id = $1`, [String(merchantId), String(actor)]);
    await settleStrength(client, teamId);
    return { ok: true, teamId };
  });
}

/**
 * Take a merchant out of their team — a rejected proposal, or a member removed
 * by their supervisor or an admin. `supervisorId`, when given, scopes the
 * removal to that supervisor's teams.
 */
export async function removeMember({ merchantId, supervisorId = null, onlyPending = false }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT t.team_id, tm.status FROM team_members tm JOIN teams t ON t.team_id = tm.team_id
        WHERE tm.merchant_id = $1 AND ($2::text IS NULL OR t.supervisor_id = $2)
        FOR UPDATE OF t`, [String(merchantId), supervisorId === null ? null : String(supervisorId)]);
    if (!rows[0]) return { ok: false, reason: 'not_found' };
    if (onlyPending && rows[0].status !== 'PENDING') return { ok: false, reason: 'not_pending' };
    await client.query('DELETE FROM team_members WHERE merchant_id = $1', [String(merchantId)]);
    await settleStrength(client, rows[0].team_id);
    return { ok: true, teamId: rows[0].team_id, wasStatus: rows[0].status };
  });
}
