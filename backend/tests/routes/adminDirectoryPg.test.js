// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The admin's players and merchants tables (owner, 2026-10-14), through the
 * real routers and a real database.
 *
 * Each figure is asserted against rows this test wrote (trap 10: baseline, own
 * rows, the delta), and each sort is asserted to put the larger figure first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { applyMovementPaise } from '#db/repositories/wallets.core.js';
import { TEST_FUNDING } from '#db/tests/_funding.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;
const RUN = Math.random().toString(36).slice(2, 8);
let seq = 0;
const nextId = (p) => `${p}-${RUN}-${(seq += 1)}`;

describePg('admin directory — players and merchants tables', () => {
  let usersApp; let merchantsApp; let admin; let usersOnly; let merchantsOnly;
  const teams = teamFixture();
  const players = {};
  let team;

  const order = (userId, type, tokens, state = 'COMPLETED', merchantId = null) => pgQuery(
    `INSERT INTO order_states (order_id, user_id, merchant_id, order_type, state, token_amount_paise)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [nextId('ad-o'), userId, merchantId, type, state, tokens * 100]);

  const bet = (userId, stake, status, payout = 0, phantom = false) => pgQuery(
    `INSERT INTO bets (bet_id, user_id, cycle_id, side, stake_paise, payout_paise, status, is_phantom)
     VALUES ($1, $2, $3, 'A', $4, $5, $6, $7)`,
    [nextId('ad-b'), userId, `ad-cycle-${RUN}`, stake * 100, payout * 100, status, phantom]);

  const fund = (userId, rupees) => applyMovementPaise({
    userId,
    legs: [{ field: 'depositBalance', deltaPaise: rupees * 100 }],
    ledger: [{ txId: nextId('ad-seed'), field: 'depositBalance', amountPaise: rupees * 100, type: 'CREDIT' }],
    counterparty: TEST_FUNDING,
  });

  beforeAll(async () => {
    await applySchema();
    usersApp = mountRouter((await import('../../routes/admin/users.admin.routes.js')).default);
    merchantsApp = mountRouter((await import('../../domains/merchant/merchant.admin.routes.js')).default);
    admin = await actor({ isAdmin: true });
    usersOnly = await actor({ isSubAdmin: true, permissions: { canManageUsers: true } });
    merchantsOnly = await actor({ isSubAdmin: true, permissions: { canManageMerchants: true } });

    // A winner: deposited 5,000, sold 1,000, won 300 net on boards, +50 casino.
    players.winner = await actor({});
    await fund(players.winner.userId, 4_000);
    await order(players.winner.userId, 'DEPOSIT', 5_000);
    await order(players.winner.userId, 'WITHDRAWAL', 1_000);
    await order(players.winner.userId, 'DEPOSIT', 9_999, 'CANCELLED'); // not completed: not counted
    await bet(players.winner.userId, 300, 'WON', 600);   // +300
    await bet(players.winner.userId, 999, 'WON', 1998, true); // phantom bet: not counted
    await pgQuery(
      `INSERT INTO casino_rounds (round_id, user_id, provider_key, debited_paise, debited_deposit_paise, credited_paise)
       VALUES ($1, $2, 'test', 10000, 10000, 15000)`, [nextId('ad-r'), players.winner.userId]); // +50

    // A loser: deposited 500, lost 200, a bet still open (not counted).
    players.loser = await actor({});
    await fund(players.loser.userId, 300);
    await order(players.loser.userId, 'DEPOSIT', 500);
    await bet(players.loser.userId, 200, 'LOST');
    await bet(players.loser.userId, 100, 'PENDING');

    team = await teams.workingTeam({ rail: 'UPI_BANK', poolTokens: 7_000 });
  }, 120_000);

  afterAll(async () => { await teams.cleanup(); await closePg(); });

  const rowOf = (body, userId) => body.users.find((u) => u.userId === userId);

  it('shows each player\'s deposits, sells, net win/loss and both wallets', async () => {
    const res = await as(usersApp, admin).get('/users').query({ search: players.winner.mobile });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const w = rowOf(res.body, players.winner.userId);
    expect(w.totals).toMatchObject({ depositsPaise: 500_000, withdrawalsPaise: 100_000, depositCount: 1, netPaise: 35_000 });
    expect(w.wallet).toMatchObject({ vipPaise: 400_000, generalPaise: 0 });

    const l = rowOf((await as(usersApp, admin).get('/users').query({ search: players.loser.mobile })).body, players.loser.userId);
    expect(l.totals.netPaise).toBe(-20_000);
    expect(l.totals.depositsPaise).toBe(50_000);
  });

  it('sorts by any offered key, either way, and sends the keys it offers', async () => {
    const desc = await as(usersApp, admin).get('/users').query({ sort: 'net', dir: 'desc', limit: 200 });
    expect(desc.status).toBe(200);
    expect(desc.body.sorts).toEqual(expect.arrayContaining(['joined', 'deposits', 'net', 'vip', 'general']));
    const ids = desc.body.users.map((u) => u.userId);
    if (ids.includes(players.winner.userId) && ids.includes(players.loser.userId)) {
      expect(ids.indexOf(players.winner.userId)).toBeLessThan(ids.indexOf(players.loser.userId));
    }
    const nets = desc.body.users.map((u) => u.totals.netPaise);
    expect(nets).toEqual([...nets].sort((a, b) => b - a));

    const asc = await as(usersApp, admin).get('/users').query({ sort: 'deposits', dir: 'asc', limit: 200 });
    const deps = asc.body.users.map((u) => u.totals.depositsPaise);
    expect(deps).toEqual([...deps].sort((a, b) => a - b));
  });

  it('refuses an unknown sort by name, as a 400 the panel can show', async () => {
    const res = await as(usersApp, admin).get('/users').query({ sort: 'password_hash' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_SORT');
  });

  it('lists players only — never a staff login', async () => {
    const res = await as(usersApp, admin).get('/users').query({ search: usersOnly.mobile });
    expect(res.body.users.map((u) => u.userId)).not.toContain(usersOnly.userId);
  });

  it('carries the same row on the profile, with the sell escrow', async () => {
    const res = await as(usersApp, usersOnly).get(`/users/${players.winner.userId}`);
    expect(res.status).toBe(200);
    expect(res.body.summary.totals.netPaise).toBe(35_000);
    expect(res.body.escrow).toEqual({ inSellOrders: 0, inDispute: 0 });
  });

  it('refuses the players table without the users area', async () => {
    expect((await as(usersApp, merchantsOnly).get('/users')).status).toBe(403);
  });

  it('shows a supervisor\'s pool, commission today and this month, and an agent\'s team pool', async () => {
    const commission = nextId('ad-tc');
    await pgQuery(
      `INSERT INTO team_commissions (commission_id, team_id, supervisor_id, from_high_paise, to_high_paise,
         buys_paise, sells_paise, commission_paise)
       VALUES ($1, $2, $3, 0, 100000, 100000, 100000, 10000)`, [commission, team.teamId, team.supervisorId]);
    await pgQuery(
      `INSERT INTO team_commission_shares (commission_id, merchant_id, role, share_paise)
       VALUES ($1, $2, 'SUPERVISOR', 1600)`, [commission, team.supervisorId]);

    const res = await as(merchantsApp, merchantsOnly).get('/merchants').query({ role: 'SUPERVISOR', limit: 200 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const sup = res.body.merchants.find((m) => m.merchantId === team.supervisorId);
    expect(sup.role).toBe('SUPERVISOR');
    expect(sup.pool.availablePaise).toBe(700_000);
    expect(sup.commission).toEqual({ todayPaise: 1600, monthPaise: 1600, totalPaise: 1600 });
    expect(res.body.merchants.every((m) => m.role === 'SUPERVISOR')).toBe(true);

    const agents = await as(merchantsApp, merchantsOnly).get('/merchants').query({ role: 'AGENT', search: team.members[0] });
    const agent = agents.body.merchants.find((m) => m.merchantId === team.members[0]);
    expect(agent).toMatchObject({ role: 'AGENT', team: { teamId: team.teamId } });
    expect(agent.pool.availablePaise).toBe(700_000);
  });

  it('sorts merchants by pool and refuses an unknown role', async () => {
    const res = await as(merchantsApp, admin).get('/merchants').query({ sort: 'pool', dir: 'desc', limit: 200 });
    expect(res.status).toBe(200);
    const pools = res.body.merchants.map((m) => m.pool.availablePaise);
    expect(pools).toEqual([...pools].sort((a, b) => b - a));
    expect(res.body.roles).toEqual(['MERCHANT', 'SUPERVISOR', 'AGENT', 'UNASSIGNED']);

    const bad = await as(merchantsApp, admin).get('/merchants').query({ role: 'BOSS' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('UNKNOWN_ROLE');
  });

  it('carries the merchants-table row on the profile', async () => {
    const res = await as(merchantsApp, admin).get(`/merchants/${team.supervisorId}/profile`);
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ merchantId: team.supervisorId, role: 'SUPERVISOR' });
    // The choices the page's controls offer, from their owners (§32 S25).
    expect(res.body.choices.routingPriority).toEqual({ MIN: 1, MAX: 5, DEFAULT: 3 });
    expect(res.body.choices.supervisorRails).toEqual(['CASH', 'UPI_BANK']);
  });

  it('refuses the merchants table without the merchants area', async () => {
    expect((await as(merchantsApp, usersOnly).get('/merchants')).status).toBe(403);
  });
});
