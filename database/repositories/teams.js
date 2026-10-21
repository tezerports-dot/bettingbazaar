// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Supervisors and their teams (owner, 2026-10-02 — PROJECT_STATUS §3.10, 2a).
 *
 * A SUPERVISOR is a merchant with `is_supervisor` and one rail. It runs up to
 * MAX_TEAMS teams of at most TEAM_SIZE members. A member is in one team at
 * most (`team_members.merchant_id` is the primary key).
 *
 * ── Every cap is asked inside the write, under a lock ────────────────────────
 * "Fewer than four teams" and "fewer than ten members" are counts of sibling
 * rows, which no CHECK can see. Each writer takes the PARENT row FOR UPDATE —
 * the supervisor for a new team, the team for a new member — counts, and
 * writes in the same transaction. Two requests arriving together serialise on
 * that lock, so the second counts what the first wrote (§32 S6).
 *
 * ── Strength ────────────────────────────────────────────────────────────────
 * A team works with any number of approved members from one to TEAM_SIZE
 * (owner, Phase A of the merchants-and-agents plan). It replaced "works only at
 * ten; a team that drops below ten stops at midnight IST", and the columns that
 * rule needed (`short_since`, `was_full`) went with it. Strength is derived
 * from the approved count in the read, so it cannot disagree with the members.
 */
import { pgQuery, withTransaction } from '../client.js';
import { randomBytes } from 'node:crypto';
import { teamCommissionSql, toSummary, commissionRates } from './teamCommission.js';
import { getSystemConfig } from './config.js';
import { poolExposureSql, toPoolExposure, poolStandingSql, toPoolStanding } from './teamPools.js';
import { toCashOut } from './teamCashOut.js';
import { textHasAMobile } from '../../backend/domains/identity/mobileInText.js';

export const MAX_TEAMS = 4;
export const TEAM_SIZE = 10;
/**
 * The rails a supervisor (and so a team) runs on. No USDT: USDT buys are paid
 * to the platform (owner, 2026-10-18), and the row refuses one
 * (`merchants_supervisor_rail`).
 */
export const SUPERVISOR_RAILS = Object.freeze(['CASH', 'UPI_BANK']);

const newTeamId = () => `team_${randomBytes(10).toString('hex')}`;

/**
 * The team's working state, for the screens that show it.
 *   WORKING — at least one approved member: the team takes orders.
 *   STOPPED — no approved member yet, so there is nobody to route to.
 *
 * Routing does not read this: it routes to APPROVED members, which is the
 * same rule asked of the member row (`routingCandidates`), so a team-level
 * gate beside it would be a second answer to one question.
 */
const STRENGTH_SQL = `CASE WHEN approved_count >= 1 THEN 'WORKING' ELSE 'STOPPED' END`;

const TEAM_SELECT = `
  SELECT t.team_id, t.supervisor_id, t.name, t.created_at, t.cash_out_started_at, t.paused_until,
         s.name AS supervisor_name, s.public_ref AS supervisor_ref, s.supervisor_rail AS rail,
         c.approved_count, c.pending_count,
         COALESCE(p.available_paise, 0) AS pool_available_paise,
         COALESCE(p.held_paise, 0)      AS pool_held_paise,
         v.*, x.*, st.*,
         ${STRENGTH_SQL} AS strength
    FROM teams t
    JOIN merchants s ON s.merchant_id = t.supervisor_id
    LEFT JOIN team_pools p ON p.team_id = t.team_id
    CROSS JOIN LATERAL (${poolExposureSql('team_id = t.team_id')}) x
    CROSS JOIN LATERAL (${teamCommissionSql('t.team_id')}) v
    CROSS JOIN LATERAL (${poolStandingSql('t.team_id')}) st
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE status = 'APPROVED')::int AS approved_count,
             count(*) FILTER (WHERE status = 'PENDING')::int  AS pending_count
        FROM team_members WHERE team_id = t.team_id) c`;

const standingOf = (row) => toPoolStanding(row, { available_paise: row.pool_available_paise, held_paise: row.pool_held_paise });

function toTeam(row, rates) {
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
    // What the held tokens are held for, and the sells on their way in
    // (`teamPools.poolExposureSql`).
    poolExposure: toPoolExposure(row),
    // Size, left, consumed and sell room (owner, 2026-10-21; `teamPools.poolStandingSql`).
    poolStanding: standingOf(row),
    cashOut: toCashOut(row),
    // Order commission (owner, 2026-10-21): completed volume, what has been
    // paid, and what is earned but waiting for the commission pool.
    commission: toSummary(row.team_id, row, rates),
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
    // The admin's 1–5 routing priority (`setRoutingPriority`), shown and set
    // on the admin's Teams screen.
    routingPriority: Number(row.routing_priority),
    addedBy: row.added_by,
    addedAt: row.added_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
  };
}

const MEMBER_SELECT = `
  SELECT tm.merchant_id, tm.team_id, tm.status, tm.added_by, tm.added_at,
         tm.approved_by, tm.approved_at, m.name, m.public_ref, m.is_online, m.routing_priority
    FROM team_members tm JOIN merchants m ON m.merchant_id = tm.merchant_id`;

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
      // By merchant id OR the agent ID the merchant panel shows them (their
      // public ref), as `addMember` takes it: an admin pasting the ID the agent
      // read off their own Team page was answered "not found" (owner,
      // 2026-10-14), so no supervisor could be made from the panel.
      const ref = String(merchantId ?? '').trim();
      const { rows } = await client.query(
        `SELECT merchant_id, merchant_approval_status, is_supervisor
           FROM merchants WHERE merchant_id = $1 OR public_ref = upper($1) FOR UPDATE`, [ref]);
      const m = rows[0];
      if (!m) return { ok: false, reason: 'not_found' };
      merchantId = m.merchant_id;
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
      return { ok: true, merchantId };
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
  return toTeam(rows[0], commissionRates(await getSystemConfig()));
}

export async function listTeams({ supervisorId = null } = {}) {
  const { rows } = await pgQuery(
    `${TEAM_SELECT} WHERE ($1::text IS NULL OR t.supervisor_id = $1)
      ORDER BY s.name, t.created_at`,
    [supervisorId === null ? null : String(supervisorId)], 'teams_list');
  const rates = commissionRates(await getSystemConfig());
  return rows.map((r) => toTeam(r, rates));
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

/** An admin approves a pending member. Refused if the team already has TEAM_SIZE approved. */
export async function approveMember({ merchantId, actor }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT t.team_id FROM team_members tm
         JOIN teams t ON t.team_id = tm.team_id
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
    return { ok: true, teamId: rows[0].team_id, wasStatus: rows[0].status };
  });
}

// ── Merchant accounts (owner, 2026-10-11 — Phase B) ──────────────────────────
/**
 * A merchant account is a team of kind DIRECT owned by one merchant, with no
 * supervisor and no members: the owner (and their sub-members, merchantStaff.js)
 * serve its orders and its pool holds its tokens. The row's CHECK and trigger
 * hold the shape (`teams_kind_shape`, `bb_direct_team_shape`): one per owner,
 * never a supervisor or a member, kind and owner fixed.
 *
 * INSIDE the caller's transaction, so the admin's "create a merchant account"
 * writes the login, the merchant and its team together. A merchant account
 * serves INR only, as every merchant does.
 * Returns { ok: true, teamId } or { ok: false, reason }.
 */
export async function createDirectTeamWithin(client, { merchantId, name = null }) {
  const { rows: m } = await client.query(
    `SELECT name, is_supervisor FROM merchants WHERE merchant_id = $1 FOR UPDATE`,
    [String(merchantId)]);
  if (!m[0]) return { ok: false, reason: 'not_found' };
  if (m[0].is_supervisor) return { ok: false, reason: 'is_supervisor' };
  const { rows: member } = await client.query('SELECT 1 FROM team_members WHERE merchant_id = $1', [String(merchantId)]);
  if (member[0]) return { ok: false, reason: 'is_member' };
  const { rows: existing } = await client.query('SELECT team_id FROM teams WHERE owner_merchant_id = $1', [String(merchantId)]);
  if (existing[0]) return { ok: true, teamId: existing[0].team_id, already: true };
  const teamId = newTeamId();
  await client.query(
    `INSERT INTO teams (team_id, kind, owner_merchant_id, name) VALUES ($1, 'DIRECT', $2, $3)`,
    [teamId, String(merchantId), teamName(name || m[0].name)]);
  return { ok: true, teamId };
}

/** Make an existing merchant a merchant account (its own transaction). */
export async function createDirectTeam({ merchantId, name = null }) {
  return withTransaction((client) => createDirectTeamWithin(client, { merchantId, name }));
}

const DIRECT_SELECT = `
  SELECT t.team_id, t.owner_merchant_id, t.name, t.created_at, t.cash_out_started_at, t.paused_until,
         o.name AS owner_name, o.public_ref AS owner_ref, o.status AS owner_status,
         o.merchant_approval_status AS owner_approval, o.is_online AS owner_online,
         o.routing_priority AS owner_priority,
         COALESCE(p.available_paise, 0) AS pool_available_paise,
         COALESCE(p.held_paise, 0)      AS pool_held_paise,
         v.*, x.*, st.*
    FROM teams t
    JOIN merchants o ON o.merchant_id = t.owner_merchant_id
    LEFT JOIN team_pools p ON p.team_id = t.team_id
    CROSS JOIN LATERAL (${poolExposureSql('team_id = t.team_id')}) x
    CROSS JOIN LATERAL (${teamCommissionSql('t.team_id')}) v
    CROSS JOIN LATERAL (${poolStandingSql('t.team_id')}) st
   WHERE t.kind = 'DIRECT'`;

function toDirectTeam(row, rates) {
  if (!row) return null;
  return {
    teamId: row.team_id,
    kind: 'DIRECT',
    ownerMerchantId: row.owner_merchant_id,
    ownerName: row.owner_name,
    ownerRef: row.owner_ref,
    ownerStatus: row.owner_status,
    ownerApproval: row.owner_approval,
    ownerOnline: row.owner_online === true,
    routingPriority: Number(row.owner_priority),
    name: row.name,
    poolAvailablePaise: Number(row.pool_available_paise ?? 0),
    poolHeldPaise: Number(row.pool_held_paise ?? 0),
    poolExposure: toPoolExposure(row),
    poolStanding: standingOf(row),
    cashOut: toCashOut(row),
    commission: toSummary(row.team_id, row, rates, { kind: 'DIRECT' }),
    createdAt: row.created_at,
  };
}

/** The merchant account a merchant owns, or null. */
export async function directTeamOf(merchantId) {
  if (!merchantId) return null;
  const { rows } = await pgQuery(`${DIRECT_SELECT} AND t.owner_merchant_id = $1`, [String(merchantId)], 'teams_direct_of');
  return toDirectTeam(rows[0], commissionRates(await getSystemConfig()));
}

/** Every merchant account, by owner name. */
export async function listDirectTeams() {
  const { rows } = await pgQuery(`${DIRECT_SELECT} ORDER BY o.name, t.created_at`, [], 'teams_direct_list');
  const rates = commissionRates(await getSystemConfig());
  return rows.map((r) => toDirectTeam(r, rates));
}
