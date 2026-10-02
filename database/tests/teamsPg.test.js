// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Supervisors and teams, against a REAL PostgreSQL (PROJECT_STATUS §3.10, 2a).
 *
 * What a database is needed for: the two caps (4 teams, 10 members) are counts
 * of sibling rows, asked under a lock — so they are tested by RACING them; the
 * supervisor/member separation is a trigger; and the strength a team reports
 * is computed by the database's clock in IST.
 *
 * Trap 10: every merchant and team here is this run's own, and removed after.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg, getPool } from '../client.js';
import {
  createMerchant, updateMerchant, newMerchantId, generateMerchantPublicRef,
} from '../repositories/merchants.js';
import {
  setSupervisorRole, createTeam, renameTeam, deleteTeam, getTeam, listTeams,
  listMembers, membershipOf, addMember, approveMember, removeMember,
  MAX_TEAMS, TEAM_SIZE,
} from '../repositories/teams.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('supervisors and teams (PostgreSQL)', () => {
  const made = [];
  let seq = 0;
  const merchant = async ({ approval = 'APPROVED' } = {}) => {
    const merchantId = newMerchantId();
    seq += 1;
    await createMerchant({
      merchantId, name: `TM ${merchantId.slice(-6)}`, publicRef: generateMerchantPublicRef(),
      mobile: `7${String(Date.now()).slice(-6)}${String(seq).padStart(3, '0')}`, status: 'ACTIVE',
    });
    if (approval !== 'PENDING') await updateMerchant(merchantId, { merchantApprovalStatus: approval });
    made.push(merchantId);
    return merchantId;
  };
  const supervisor = async (rail = 'UPI_BANK') => {
    const id = await merchant();
    expect(await setSupervisorRole(id, { rail })).toEqual({ ok: true });
    return id;
  };
  /** A team with `n` APPROVED members. */
  const teamWith = async (n) => {
    const sup = await supervisor();
    const { teamId } = await createTeam({ supervisorId: sup, name: 'Alpha' });
    const members = [];
    for (let i = 0; i < n; i += 1) {
      const m = await merchant();
      expect((await addMember({ teamId, supervisorId: sup, merchantRef: m, actor: sup })).ok).toBe(true);
      expect((await approveMember({ merchantId: m, actor: 'admin-1' })).ok).toBe(true);
      members.push(m);
    }
    return { sup, teamId, members };
  };

  /** A team with `n` PENDING proposals (they count against the ten). */
  const teamWithPending = async (n) => {
    const sup = await supervisor();
    const { teamId } = await createTeam({ supervisorId: sup, name: 'Kilo' });
    for (let i = 0; i < n; i += 1) {
      expect((await addMember({ teamId, supervisorId: sup, merchantRef: await merchant(), actor: sup })).ok).toBe(true);
    }
    return { sup, teamId };
  };

  beforeAll(async () => { await applySchema(); }, 60_000);
  afterAll(async () => {
    await pgQuery('DELETE FROM team_members WHERE merchant_id = ANY($1)', [made]);
    await pgQuery('DELETE FROM teams WHERE supervisor_id = ANY($1)', [made]);
    await pgQuery('DELETE FROM merchants WHERE merchant_id = ANY($1)', [made]);
    await closePg();
  });

  // ── The supervisor role ──────────────────────────────────────────────────
  it('makes an approved merchant a supervisor on one rail, and refuses an unknown rail', async () => {
    const id = await merchant();
    await expect(setSupervisorRole(id, { rail: 'CHEQUE' })).rejects.toThrow(/rail must be/);
    expect(await setSupervisorRole(id, { rail: 'CASH' })).toEqual({ ok: true });
    const { rows } = await pgQuery('SELECT is_supervisor, supervisor_rail FROM merchants WHERE merchant_id = $1', [id]);
    expect(rows[0]).toEqual({ is_supervisor: true, supervisor_rail: 'CASH' });
  });

  it('refuses the role to a merchant the admin has not approved', async () => {
    const id = await merchant({ approval: 'PENDING' });
    expect(await setSupervisorRole(id, { rail: 'USDT' })).toEqual({ ok: false, reason: 'not_approved' });
  });

  it('will not change the rail, or remove the role, while the supervisor runs a team', async () => {
    const sup = await supervisor('UPI_BANK');
    await createTeam({ supervisorId: sup, name: 'Bravo' });
    expect(await setSupervisorRole(sup, { rail: 'CASH' })).toEqual({ ok: false, reason: 'has_teams' });
    expect(await setSupervisorRole(sup, { rail: null })).toEqual({ ok: false, reason: 'has_teams' });
  });

  it('the table refuses a supervisor flag with no rail, and a rail with no flag', async () => {
    const id = await merchant();
    await expect(pgQuery('UPDATE merchants SET is_supervisor = true WHERE merchant_id = $1', [id]))
      .rejects.toThrow(/merchants_supervisor_rail/);
    await expect(pgQuery(`UPDATE merchants SET supervisor_rail = 'CASH' WHERE merchant_id = $1`, [id]))
      .rejects.toThrow(/merchants_supervisor_rail/);
  });

  // ── A supervisor is never a member, and the reverse ──────────────────────
  it('refuses to add a supervisor as a member, and to make a member a supervisor', async () => {
    const sup = await supervisor();
    const other = await supervisor();
    const { teamId } = await createTeam({ supervisorId: sup, name: 'Charlie' });
    expect(await addMember({ teamId, supervisorId: sup, merchantRef: other, actor: sup }))
      .toEqual({ ok: false, reason: 'is_supervisor' });

    const m = await merchant();
    await addMember({ teamId, supervisorId: sup, merchantRef: m, actor: sup });
    expect(await setSupervisorRole(m, { rail: 'CASH' })).toEqual({ ok: false, reason: 'is_member' });
    // And the trigger holds against a direct write, not just the repository.
    await expect(pgQuery(`UPDATE merchants SET is_supervisor = true, supervisor_rail = 'CASH' WHERE merchant_id = $1`, [m]))
      .rejects.toThrow(/team member cannot be a supervisor/);
  });

  // ── Four teams ───────────────────────────────────────────────────────────
  it(`allows ${MAX_TEAMS} teams and refuses the next`, async () => {
    const sup = await supervisor();
    for (let i = 0; i < MAX_TEAMS; i += 1) {
      expect((await createTeam({ supervisorId: sup, name: `T${i}` })).ok).toBe(true);
    }
    expect(await createTeam({ supervisorId: sup, name: 'one too many' })).toEqual({ ok: false, reason: 'team_limit' });
  });

  it(`10 simultaneous creates leave exactly ${MAX_TEAMS} teams`, async () => {
    const sup = await supervisor();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      createTeam({ supervisorId: sup, name: `Race ${i}` })));
    expect(results.filter((r) => r.ok)).toHaveLength(MAX_TEAMS);
    expect(await listTeams({ supervisorId: sup })).toHaveLength(MAX_TEAMS);
  });

  it('refuses a team for a merchant who is not a supervisor', async () => {
    const id = await merchant();
    expect(await createTeam({ supervisorId: id, name: 'Nope' })).toEqual({ ok: false, reason: 'not_supervisor' });
  });

  it('renames only its own team, and deletes only an empty one', async () => {
    const sup = await supervisor();
    const stranger = await supervisor();
    const { teamId } = await createTeam({ supervisorId: sup, name: 'Delta' });
    expect(await renameTeam({ teamId, supervisorId: stranger, name: 'Stolen' })).toEqual({ ok: false, reason: 'not_found' });
    expect(await renameTeam({ teamId, supervisorId: sup, name: 'Echo' })).toEqual({ ok: true });
    expect((await getTeam(teamId)).name).toBe('Echo');

    const m = await merchant();
    await addMember({ teamId, supervisorId: sup, merchantRef: m, actor: sup });
    expect(await deleteTeam({ teamId, supervisorId: sup })).toEqual({ ok: false, reason: 'has_members' });
    await removeMember({ merchantId: m });
    expect(await deleteTeam({ teamId, supervisorId: stranger })).toEqual({ ok: false, reason: 'not_found' });
    expect(await deleteTeam({ teamId, supervisorId: sup })).toEqual({ ok: true });
  });

  // ── Members ──────────────────────────────────────────────────────────────
  it('adds a member by public ref as well as by id, PENDING until an admin approves', async () => {
    const sup = await supervisor();
    const { teamId } = await createTeam({ supervisorId: sup, name: 'Foxtrot' });
    const m = await merchant();
    const { rows } = await pgQuery('SELECT public_ref FROM merchants WHERE merchant_id = $1', [m]);
    expect(await addMember({ teamId, supervisorId: sup, merchantRef: rows[0].public_ref.toLowerCase(), actor: sup }))
      .toEqual({ ok: true, merchantId: m });
    expect((await membershipOf(m)).member.status).toBe('PENDING');
    expect((await approveMember({ merchantId: m, actor: 'admin-1' })).ok).toBe(true);
    const after = await membershipOf(m);
    expect(after.member).toMatchObject({ status: 'APPROVED', approvedBy: 'admin-1' });
  });

  it('refuses an unknown merchant, an unapproved one, and one already in a team', async () => {
    const sup = await supervisor();
    const { teamId } = await createTeam({ supervisorId: sup, name: 'Golf' });
    const { teamId: other } = await createTeam({ supervisorId: sup, name: 'Hotel' });
    expect(await addMember({ teamId, supervisorId: sup, merchantRef: 'MNOSUCHREF', actor: sup }))
      .toEqual({ ok: false, reason: 'merchant_not_found' });
    const unapproved = await merchant({ approval: 'PENDING' });
    expect(await addMember({ teamId, supervisorId: sup, merchantRef: unapproved, actor: sup }))
      .toEqual({ ok: false, reason: 'merchant_not_approved' });
    const m = await merchant();
    await addMember({ teamId, supervisorId: sup, merchantRef: m, actor: sup });
    expect(await addMember({ teamId: other, supervisorId: sup, merchantRef: m, actor: sup }))
      .toEqual({ ok: false, reason: 'already_in_team' });
  });

  it('will not let a supervisor add to a team that is not theirs', async () => {
    const sup = await supervisor();
    const stranger = await supervisor();
    const { teamId } = await createTeam({ supervisorId: sup, name: 'India' });
    expect(await addMember({ teamId, supervisorId: stranger, merchantRef: await merchant(), actor: stranger }))
      .toEqual({ ok: false, reason: 'team_not_found' });
  });

  it(`holds ${TEAM_SIZE} places, and 15 simultaneous proposals fill exactly ${TEAM_SIZE}`, async () => {
    const sup = await supervisor();
    const { teamId } = await createTeam({ supervisorId: sup, name: 'Juliet' });
    const candidates = [];
    for (let i = 0; i < 15; i += 1) candidates.push(await merchant());
    const results = await Promise.all(candidates.map((m) =>
      addMember({ teamId, supervisorId: sup, merchantRef: m, actor: sup })));
    expect(results.filter((r) => r.ok)).toHaveLength(TEAM_SIZE);
    expect(results.filter((r) => r.reason === 'team_full')).toHaveLength(15 - TEAM_SIZE);
    expect(await listMembers({ teamId })).toHaveLength(TEAM_SIZE);
  });

  // The test above races 15 proposals, which proves the cap holds under real
  // concurrency but only CATCHES a missing lock when the scheduler happens to
  // interleave them — on CI it did not, and the mutation removing the lock
  // survived (M282). This one forces the interleaving: a SHARE lock on
  // team_members stops every INSERT, so each proposal gets as far as it can
  // and waits. With the team row locked, only the first is past its count;
  // without it, all five have counted nine. Then the lock is released.
  it('proposals for the last place are serialised by the team row lock, not by timing', async () => {
    const { sup, teamId } = await teamWithPending(TEAM_SIZE - 1);
    const candidates = [];
    for (let i = 0; i < 5; i += 1) candidates.push(await merchant());

    const holder = await (await getPool()).connect();
    let results;
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE team_members IN SHARE MODE');
      const racing = Promise.all(candidates.map((m) =>
        addMember({ teamId, supervisorId: sup, merchantRef: m, actor: sup })));
      // Wait until all five are parked on a lock — wherever their code stops them.
      for (let i = 0; i < 200; i += 1) {
        const { rows } = await pgQuery(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1`, [holder.processID]);
        if (rows[0].n >= candidates.length) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await holder.query('COMMIT');
      results = await racing;
    } finally {
      holder.release();
    }
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.reason === 'team_full')).toHaveLength(4);
    expect(await listMembers({ teamId })).toHaveLength(TEAM_SIZE);
  });

  it('only a supervisor can remove from their own teams; a pending-only removal leaves an approved member', async () => {
    const { sup, members } = await teamWith(1);
    const stranger = await supervisor();
    expect(await removeMember({ merchantId: members[0], supervisorId: stranger })).toEqual({ ok: false, reason: 'not_found' });
    expect(await removeMember({ merchantId: members[0], onlyPending: true })).toEqual({ ok: false, reason: 'not_pending' });
    expect((await removeMember({ merchantId: members[0], supervisorId: sup })).ok).toBe(true);
    expect(await membershipOf(members[0])).toBeNull();
  });

  // ── Strength ─────────────────────────────────────────────────────────────
  it('a team that has never had ten is STOPPED, and at ten it is WORKING', async () => {
    const { teamId, sup } = await teamWith(TEAM_SIZE - 1);
    expect((await getTeam(teamId)).strength).toBe('STOPPED');
    const m = await merchant();
    await addMember({ teamId, supervisorId: sup, merchantRef: m, actor: sup });
    await approveMember({ merchantId: m, actor: 'admin-1' });
    expect(await getTeam(teamId)).toMatchObject({ strength: 'WORKING', approvedCount: TEAM_SIZE, wasFull: true, shortSince: null });
  });

  it('dropping from ten starts a grace day; a second drop does not restart it; refilling ends it', async () => {
    const { teamId, sup, members } = await teamWith(TEAM_SIZE);
    await removeMember({ merchantId: members[0], supervisorId: sup });
    const first = await getTeam(teamId);
    expect(first.strength).toBe('GRACE');
    expect(first.shortSince).not.toBeNull();

    await removeMember({ merchantId: members[1], supervisorId: sup });
    expect((await getTeam(teamId)).shortSince.getTime()).toBe(first.shortSince.getTime());

    for (let i = 0; i < 2; i += 1) {
      const m = await merchant();
      await addMember({ teamId, supervisorId: sup, merchantRef: m, actor: sup });
      await approveMember({ merchantId: m, actor: 'admin-1' });
    }
    expect(await getTeam(teamId)).toMatchObject({ strength: 'WORKING', shortSince: null });
  });

  it('the grace day ends at midnight IST, by the database clock', async () => {
    const { teamId, sup, members } = await teamWith(TEAM_SIZE);
    await removeMember({ merchantId: members[0], supervisorId: sup });
    // Yesterday in IST, whatever the server's own zone is.
    await pgQuery(`UPDATE teams SET short_since = (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - interval '1 minute') AT TIME ZONE 'Asia/Kolkata'
                    WHERE team_id = $1`, [teamId]);
    expect((await getTeam(teamId)).strength).toBe('STOPPED');
  });

  it(`refuses to approve an eleventh member`, async () => {
    const { teamId, sup, members } = await teamWith(TEAM_SIZE);
    // UNREACHABLE through the repository: addMember counts pending AND
    // approved against the ten, so a pending eleventh cannot be proposed. It is
    // staged by hand (§32 S16, knowingly) to prove the SECOND guard — the count
    // in approveMember — holds on its own if the first is ever loosened.
    await removeMember({ merchantId: members[0], supervisorId: sup });
    const late = await merchant();
    await addMember({ teamId, supervisorId: sup, merchantRef: late, actor: sup });
    await pgQuery(`INSERT INTO team_members (merchant_id, team_id, added_by, status, approved_by, approved_at)
                   VALUES ($1, $2, $3, 'APPROVED', 'admin-1', now())`, [members[0], teamId, sup]);
    expect(await approveMember({ merchantId: late, actor: 'admin-1' })).toEqual({ ok: false, reason: 'team_full' });
  });
});
