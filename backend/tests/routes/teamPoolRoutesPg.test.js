// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Team token pools over HTTP, through the real routers and a real database
 * (PROJECT_STATUS §3.10, Step 2b).
 *
 * The repository suite (teamPoolsPg) proves the money. This one proves the
 * DOORS: a supervisor asks only for their own team; only staff with the money
 * area can fulfil; a fulfilment without a recorded payment is refused before
 * anything moves; and the supervisor's own screen shows the result.
 *
 * Trap 10: every merchant, team and request is this run's own, removed after.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '#db/client.js';
import { historyFor } from '#db/repositories/audit.js';
import { getPool, getRequest } from '#db/repositories/teamPools.js';
import { mountRouter, actor, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('team pool routes', () => {
  let adminApp; let merchantApp; let teamsAdmin; let funder; let analyst;
  const made = [];
  const merchant = async () => { const m = await merchantActor(); made.push(m.merchantId); return m; };

  /** A supervisor with one team, made through the real routes. */
  const supervisorWithTeam = async () => {
    const s = await merchant();
    expect((await as(adminApp, teamsAdmin).put(`/merchants/${s.merchantId}/supervisor`).send({ rail: 'UPI_BANK' })).status).toBe(200);
    const created = await as(merchantApp, s).post('/supervisor/teams').send({ name: 'Pool' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return { sup: s, teamId: created.body.team.teamId };
  };
  const ask = async ({ sup, teamId }, direction, tokenAmount) => {
    const res = await as(merchantApp, sup).post(`/supervisor/teams/${teamId}/pool-requests`).send({ direction, tokenAmount });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.request.requestId;
  };

  beforeAll(async () => {
    await applySchema();
    adminApp = mountRouter((await import('../../domains/team/team.admin.routes.js')).default);
    merchantApp = mountRouter((await import('../../domains/team/team.merchant.routes.js')).default);
    teamsAdmin = await actor({ isSubAdmin: true, permissions: { canManageTeams: true } });
    funder = await actor({ isSubAdmin: true, permissions: { canFundMerchants: true } });
    analyst = await actor({ isSubAdmin: true, permissions: { canViewAnalytics: true } });
  }, 60_000);

  afterAll(async () => {
    const { rows } = await pgQuery('SELECT team_id FROM teams WHERE supervisor_id = ANY($1)', [made]);
    const teams = rows.map((r) => r.team_id);
    await pgQuery('SET session_replication_role = replica');
    try {
      await pgQuery('DELETE FROM admin_token_considerations WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM team_pool_entries WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM team_pool_requests WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM team_pools WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM teams WHERE team_id = ANY($1)', [teams]);
      await pgQuery('DELETE FROM merchants WHERE merchant_id = ANY($1)', [made]);
    } finally {
      await pgQuery('SET session_replication_role = DEFAULT');
    }
    await closePg();
  });

  it('a supervisor asks, an admin fulfils with the payment recorded, and both screens show the pool', async () => {
    const t = await supervisorWithTeam();
    const requestId = await ask(t, 'BUY', 1500);

    // The supervisor's own screen lists it pending.
    const mine = await as(merchantApp, t.sup).get('/team');
    expect(mine.body.poolRequests.map((r) => [r.requestId, r.status])).toContainEqual([requestId, 'PENDING']);

    // The admin queue shows it.
    const queue = await as(adminApp, funder).get('/team-pool-requests?status=PENDING');
    expect(queue.status).toBe(200);
    expect(queue.body.requests.map((r) => r.requestId)).toContain(requestId);

    const done = await as(adminApp, funder).post(`/team-pool-requests/${requestId}/fulfil`)
      .send({ settlementCurrency: 'INR', settlementAmount: 1500 });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.pool.availablePaise).toBe(150000);
    expect(done.body.settlement).toMatchObject({ currency: 'INR', amount: 1500 });

    const pool = await as(merchantApp, t.sup).get(`/supervisor/teams/${t.teamId}/pool`);
    expect(pool.body.pool.availablePaise).toBe(150000);
    expect(pool.body.entries[0]).toMatchObject({ kind: 'ADMIN_SALE' });
    expect((await as(merchantApp, t.sup).get('/team')).body.teams[0].poolAvailablePaise).toBe(150000);

    expect((await historyFor(t.teamId)).filter((a) => a.action === 'TEAM_POOL_SALE')).toHaveLength(1);
  });

  it('a fulfilment with no payment recorded is refused by name, and nothing moves', async () => {
    const t = await supervisorWithTeam();
    const requestId = await ask(t, 'BUY', 200);
    const res = await as(adminApp, funder).post(`/team-pool-requests/${requestId}/fulfil`).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Record what the platform received/);
    expect((await getPool(t.teamId)).availablePaise).toBe(0);
    expect((await getRequest(requestId)).status).toBe('PENDING');
  });

  it('a second press of fulfil is a 409, and the pool moved once', async () => {
    const t = await supervisorWithTeam();
    const requestId = await ask(t, 'BUY', 300);
    const body = { settlementCurrency: 'INR', settlementAmount: 300 };
    expect((await as(adminApp, funder).post(`/team-pool-requests/${requestId}/fulfil`).send(body)).status).toBe(200);
    const second = await as(adminApp, funder).post(`/team-pool-requests/${requestId}/fulfil`).send(body);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('request_not_pending');
    expect((await getPool(t.teamId)).availablePaise).toBe(30000);
  });

  it('a buyback beyond the pool is refused when asked, naming what is available', async () => {
    const t = await supervisorWithTeam();
    const res = await as(merchantApp, t.sup).post(`/supervisor/teams/${t.teamId}/pool-requests`)
      .send({ direction: 'SELL', tokenAmount: 10 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('pool_short');
  });

  it('an admin rejects; the supervisor sees the reason and may ask again', async () => {
    const t = await supervisorWithTeam();
    const requestId = await ask(t, 'BUY', 50);
    expect((await as(adminApp, funder).post(`/team-pool-requests/${requestId}/reject`).send({ reason: 'No payment seen' })).status).toBe(200);
    const mine = await as(merchantApp, t.sup).get(`/supervisor/teams/${t.teamId}/pool`);
    expect(mine.body.requests[0]).toMatchObject({ status: 'REJECTED', decisionNote: 'No payment seen' });
    await ask(t, 'BUY', 50);
  });

  it('a supervisor cancels their own pending request, and cannot cancel another\'s', async () => {
    const t = await supervisorWithTeam();
    const other = await supervisorWithTeam();
    const requestId = await ask(t, 'BUY', 40);
    expect((await as(merchantApp, other.sup).delete(`/supervisor/pool-requests/${requestId}`)).status).toBe(409);
    expect((await as(merchantApp, t.sup).delete(`/supervisor/pool-requests/${requestId}`)).status).toBe(200);
  });

  // ── Doors ────────────────────────────────────────────────────────────────
  it('a supervisor cannot ask for, or read, another supervisor\'s pool', async () => {
    const t = await supervisorWithTeam();
    const thief = await supervisorWithTeam();
    const ask2 = await as(merchantApp, thief.sup).post(`/supervisor/teams/${t.teamId}/pool-requests`).send({ direction: 'BUY', tokenAmount: 10 });
    expect(ask2.status).toBe(404);
    expect((await as(merchantApp, thief.sup).get(`/supervisor/teams/${t.teamId}/pool`)).status).toBe(404);
  });

  it('a merchant who is not a supervisor is refused; a bad amount is a 400', async () => {
    const plain = await merchant();
    const t = await supervisorWithTeam();
    expect((await as(merchantApp, plain).post(`/supervisor/teams/${t.teamId}/pool-requests`).send({ direction: 'BUY', tokenAmount: 10 })).status).toBe(403);
    const bad = await as(merchantApp, t.sup).post(`/supervisor/teams/${t.teamId}/pool-requests`).send({ direction: 'BUY', tokenAmount: 1.5 });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/whole number/);
  });

  it('staff without the money area cannot see or fulfil a pool request — the Teams area is not enough', async () => {
    const t = await supervisorWithTeam();
    const requestId = await ask(t, 'BUY', 60);
    for (const who of [analyst, teamsAdmin]) {
      expect((await as(adminApp, who).get('/team-pool-requests')).status).toBe(403);
      expect((await as(adminApp, who).post(`/team-pool-requests/${requestId}/fulfil`).send({ settlementCurrency: 'INR', settlementAmount: 60 })).status).toBe(403);
      expect((await as(adminApp, who).post(`/team-pool-requests/${requestId}/reject`).send({})).status).toBe(403);
    }
    expect((await getPool(t.teamId)).availablePaise).toBe(0);
  });
});
