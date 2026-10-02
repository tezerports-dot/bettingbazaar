// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Supervisors and teams over HTTP, through the real routers and a real
 * database (PROJECT_STATUS §3.10, Step 2a).
 *
 * The repository suite (teamsPg) proves the caps and the strength rule. This
 * one proves the DOORS: who may call which route, that a supervisor can only
 * touch their own teams, that every refusal names what to do, and that the
 * merchant a supervisor proposes sees the result on their own screen.
 *
 * Trap 10: every merchant here is this run's own, and removed after.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '#db/client.js';
import { historyFor } from '#db/repositories/audit.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('team routes', () => {
  let adminApp; let merchantApp; let admin; let analyst;
  const made = [];
  const merchant = async () => { const m = await merchantActor(); made.push(m.merchantId); return m; };
  const publicRef = async (id) => (await pgQuery('SELECT public_ref FROM merchants WHERE merchant_id = $1', [id])).rows[0].public_ref;

  /** A supervisor, made one through the admin's own route. */
  const supervisor = async (rail = 'UPI_BANK') => {
    const s = await merchant();
    const res = await as(adminApp, admin).put(`/merchants/${s.merchantId}/supervisor`).send({ rail });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return s;
  };

  beforeAll(async () => {
    await applySchema();
    adminApp = mountRouter((await import('../../domains/team/team.admin.routes.js')).default);
    merchantApp = mountRouter((await import('../../domains/team/team.merchant.routes.js')).default);
    admin = await actor({ isSubAdmin: true, permissions: { canManageTeams: true } });
    analyst = await actor({ isSubAdmin: true, permissions: { canViewAnalytics: true } });
  }, 60_000);

  afterAll(async () => {
    await pgQuery('DELETE FROM team_members WHERE merchant_id = ANY($1)', [made]);
    await pgQuery('DELETE FROM teams WHERE supervisor_id = ANY($1)', [made]);
    await pgQuery('DELETE FROM merchants WHERE merchant_id = ANY($1)', [made]);
    await closePg();
  });

  // ── The admin's half ─────────────────────────────────────────────────────
  it('an admin makes a merchant a supervisor, audited; an unknown rail is a 400 naming the choices', async () => {
    const m = await merchant();
    const bad = await as(adminApp, admin).put(`/merchants/${m.merchantId}/supervisor`).send({ rail: 'CHEQUE' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/CASH, UPI_BANK, USDT/);
    expect((await as(adminApp, admin).put(`/merchants/${m.merchantId}/supervisor`).send({ rail: 'CASH' })).status).toBe(200);
    expect((await historyFor(m.merchantId)).map((a) => a.action)).toContain('SUPERVISOR_SET');
  });

  it('refuses every team route to staff without the Teams area', async () => {
    const m = await merchant();
    expect((await as(adminApp, analyst).get('/teams')).status).toBe(403);
    expect((await as(adminApp, analyst).put(`/merchants/${m.merchantId}/supervisor`).send({ rail: 'CASH' })).status).toBe(403);
    expect((await as(adminApp, analyst).post(`/team-members/${m.merchantId}/approve`)).status).toBe(403);
    const { rows } = await pgQuery('SELECT is_supervisor FROM merchants WHERE merchant_id = $1', [m.merchantId]);
    expect(rows[0].is_supervisor).toBe(false);
  });

  // ── The supervisor's half ────────────────────────────────────────────────
  it('a supervisor creates a team, proposes a member by public ref, and the member sees it PENDING', async () => {
    const sup = await supervisor();
    const created = await as(merchantApp, sup).post('/supervisor/teams').send({ name: 'Alpha' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const teamId = created.body.team.teamId;

    const member = await merchant();
    const added = await as(merchantApp, sup).post(`/supervisor/teams/${teamId}/members`)
      .send({ merchantRef: await publicRef(member.merchantId) });
    expect(added.status, JSON.stringify(added.body)).toBe(201);

    const seen = await as(merchantApp, member).get('/team');
    expect(seen.body).toMatchObject({ role: 'MEMBER', status: 'PENDING', team: { teamId, name: 'Alpha' } });

    // The admin approves; the member's screen says so.
    expect((await as(adminApp, admin).post(`/team-members/${member.merchantId}/approve`)).status).toBe(200);
    expect((await as(merchantApp, member).get('/team')).body.status).toBe('APPROVED');

    const sv = await as(merchantApp, sup).get('/team');
    expect(sv.body).toMatchObject({ role: 'SUPERVISOR', rail: 'UPI_BANK' });
    expect(sv.body.members.map((m) => m.merchantId)).toContain(member.merchantId);
  });

  it('a merchant who is not a supervisor is refused every supervisor route, and told why', async () => {
    const plain = await merchant();
    const res = await as(merchantApp, plain).post('/supervisor/teams').send({ name: 'Nope' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_supervisor');
    expect((await as(merchantApp, plain).get('/team')).body).toMatchObject({ role: 'NONE' });
  });

  it('a supervisor cannot touch another supervisor\'s team, members or name', async () => {
    const sup = await supervisor();
    const thief = await supervisor();
    const { body } = await as(merchantApp, sup).post('/supervisor/teams').send({ name: 'Bravo' });
    const teamId = body.team.teamId;
    const member = await merchant();
    await as(merchantApp, sup).post(`/supervisor/teams/${teamId}/members`).send({ merchantRef: member.merchantId });

    expect((await as(merchantApp, thief).put(`/supervisor/teams/${teamId}`).send({ name: 'Stolen' })).status).toBe(404);
    expect((await as(merchantApp, thief).post(`/supervisor/teams/${teamId}/members`).send({ merchantRef: (await merchant()).merchantId })).status).toBe(404);
    expect((await as(merchantApp, thief).delete(`/supervisor/teams/${teamId}/members/${member.merchantId}`)).status).toBe(404);
    expect((await as(merchantApp, thief).delete(`/supervisor/teams/${teamId}`)).status).toBe(404);
    const { rows } = await pgQuery('SELECT name FROM teams WHERE team_id = $1', [teamId]);
    expect(rows[0].name).toBe('Bravo');
    expect((await as(merchantApp, member).get('/team')).body.role).toBe('MEMBER');
  });

  it('removing a member through ANOTHER of the supervisor\'s teams\' URL is refused', async () => {
    const sup = await supervisor();
    const a = (await as(merchantApp, sup).post('/supervisor/teams').send({ name: 'A' })).body.team.teamId;
    const b = (await as(merchantApp, sup).post('/supervisor/teams').send({ name: 'B' })).body.team.teamId;
    const member = await merchant();
    await as(merchantApp, sup).post(`/supervisor/teams/${a}/members`).send({ merchantRef: member.merchantId });
    expect((await as(merchantApp, sup).delete(`/supervisor/teams/${b}/members/${member.merchantId}`)).status).toBe(404);
    expect((await as(merchantApp, sup).delete(`/supervisor/teams/${a}/members/${member.merchantId}`)).status).toBe(200);
  });

  it('names the problem in every refusal a supervisor can hit', async () => {
    const sup = await supervisor();
    const teamId = (await as(merchantApp, sup).post('/supervisor/teams').send({ name: 'Charlie' })).body.team.teamId;
    const unknown = await as(merchantApp, sup).post(`/supervisor/teams/${teamId}/members`).send({ merchantRef: 'MNOSUCH' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.message).toMatch(/ID shown on their Profile/);
    const empty = await as(merchantApp, sup).post(`/supervisor/teams/${teamId}/members`).send({});
    expect(empty.status).toBe(400);
    expect((await as(merchantApp, sup).post('/supervisor/teams').send({ name: '' })).status).toBe(400);
    for (let i = 0; i < 3; i += 1) await as(merchantApp, sup).post('/supervisor/teams').send({ name: `T${i}` });
    const fifth = await as(merchantApp, sup).post('/supervisor/teams').send({ name: 'Fifth' });
    expect(fifth.status).toBe(409);
    expect(fifth.body.message).toMatch(/at most 4 teams/);
  });

  it('an admin rejects a pending member, and cannot "reject" an approved one', async () => {
    const sup = await supervisor();
    const teamId = (await as(merchantApp, sup).post('/supervisor/teams').send({ name: 'Delta' })).body.team.teamId;
    const pending = await merchant();
    const approved = await merchant();
    for (const m of [pending, approved]) {
      await as(merchantApp, sup).post(`/supervisor/teams/${teamId}/members`).send({ merchantRef: m.merchantId });
    }
    await as(adminApp, admin).post(`/team-members/${approved.merchantId}/approve`);
    expect((await as(adminApp, admin).post(`/team-members/${approved.merchantId}/reject`)).status).toBe(409);
    expect((await as(adminApp, admin).post(`/team-members/${pending.merchantId}/reject`)).status).toBe(200);
    expect((await as(merchantApp, pending).get('/team')).body.role).toBe('NONE');
    // And the admin can remove an approved member outright.
    expect((await as(adminApp, admin).delete(`/team-members/${approved.merchantId}`)).status).toBe(200);
    expect((await as(merchantApp, approved).get('/team')).body.role).toBe('NONE');
  });

  it('the admin listing shows supervisors, teams and members', async () => {
    const sup = await supervisor('USDT');
    const teamId = (await as(merchantApp, sup).post('/supervisor/teams').send({ name: 'Echo' })).body.team.teamId;
    const res = await as(adminApp, admin).get('/teams');
    expect(res.status).toBe(200);
    expect(res.body.supervisors.find((s) => s.merchantId === sup.merchantId)).toMatchObject({ rail: 'USDT' });
    expect(res.body.teams.find((t) => t.teamId === teamId)).toMatchObject({ name: 'Echo', strength: 'STOPPED', size: 10 });
  });
});
