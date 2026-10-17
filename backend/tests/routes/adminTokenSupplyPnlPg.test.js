// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Admin › Token Flow's supply breakdown and Admin › Profit & Loss, against a
 * real database (owner, 2026-10-17).
 *
 * Token Flow showed deposits and withdrawals only: nothing said where the 20
 * billion tokens are. Profit & Loss counted deposits as revenue and left out
 * bonuses. These cases fund a real wallet and write a real bonus row, then
 * read the REAL admin routes: the holders add up to the supply, the funded
 * player is listed with their tokens, the P&L counts the bonus as a cost and
 * the deposit as money flow, and both download as CSV.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { fundWallet } from '#db/tests/_funding.js';
import router from '../../domains/analytics/analytics.admin.routes.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;
const tag = `tsp-${Date.now().toString(36)}`;

describePg('Admin › Token Flow supply and Profit & Loss', () => {
  let app;
  let admin;
  let analyst;
  let player;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter(router);
    admin = await actor({ isAdmin: true });
    analyst = await actor({ isSubAdmin: true, permissions: { canViewAnalytics: true } });
    player = await actor({});
    await fundWallet(player.userId, 777_00, `${tag}-fund`);
  }, 60_000);

  afterAll(async () => {
    await pgQuery('DELETE FROM promo_grants WHERE source_ref LIKE $1', [`${tag}-%`]).catch(() => {});
    await closePg();
  });

  it('the holders add up to the whole supply, and a funded player is one of them', async () => {
    const res = await as(app, admin).get('/analytics/token-holders').query({ kind: 'PLAYER', search: player.userId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.supply).toBeGreaterThan(0);
    // The kinds add up to what the report says it accounted for, and the flag
    // says whether that is the whole supply. Whether it IS the whole supply
    // on this shared test database depends on other suites' cleanup (several
    // delete their own team pools and leave TEAM_FLOAT behind), so it is not
    // asserted here (trap 10); the database holds it per transaction.
    const sum = res.body.kinds.reduce((n, k) => n + k.tokens, 0);
    expect(sum).toBeCloseTo(res.body.accounted, 2);
    expect(res.body.accountedFor).toBe(res.body.accounted === res.body.supply);
    expect(res.body.holders).toHaveLength(1);
    expect(res.body.holders[0]).toMatchObject({ kind: 'PLAYER', holderId: player.userId, tokens: 777 });
  });

  it('the platform holding is listed first, as the largest holder', async () => {
    const res = await as(app, admin).get('/analytics/token-holders').query({ limit: 1 });
    expect(res.body.holders[0].kind).toBe('PLATFORM');
  });

  it('an analyst sees the totals by kind, but not the per-player list', async () => {
    const supply = await as(app, analyst).get('/analytics/token-supply');
    expect(supply.status).toBe(200);
    expect(supply.body.kinds.map((k) => k.kind)).toContain('PLAYER');
    expect(supply.body.holders).toBeUndefined();
    expect((await as(app, analyst).get('/analytics/token-holders')).status).toBe(403);
    expect((await as(app, analyst).get('/analytics/token-holders.csv')).status).toBe(403);
  });

  it('refuses an unknown holder kind with a 400', async () => {
    expect((await as(app, admin).get('/analytics/token-holders').query({ kind: 'NOBODY' })).status).toBe(400);
  });

  it('downloads the holders as CSV', async () => {
    const res = await as(app, admin).get('/analytics/token-holders.csv').query({ search: player.userId });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const [head, row] = res.text.split('\n');
    expect(head).toBe('kind,holder_id,name,supervisor_or_owner,approved_members,tokens,held_or_riding,share_of_supply_percent');
    expect(row).toContain(`PLAYER,${player.userId}`);
  });

  it('counts a referral bonus as a cost, and a day outside the window not at all', async () => {
    const day = '2103-04-05';
    const window = { startDate: day, endDate: day };
    const before = (await as(app, analyst).get('/analytics/financials').query(window)).body.data;
    await pgQuery(
      `INSERT INTO promo_grants (grant_id, user_id, source, source_ref, amount_paise, required_turnover_paise, created_at)
       VALUES ($1, $2, 'REFERRAL', $3, 2500, 25000, ($4::date)::timestamp AT TIME ZONE 'Asia/Kolkata' + interval '23 hours')`,
      [`${tag}-g1`, player.userId, `${tag}-r1`, day],
    );
    const after = (await as(app, analyst).get('/analytics/financials').query(window)).body.data;
    expect(after.costs.referralBonuses.amount - before.costs.referralBonuses.amount).toBe(25);
    expect(after.netProfit - before.netProfit).toBe(-25);
    const nextDay = (await as(app, analyst).get('/analytics/financials').query({ startDate: '2103-04-06', endDate: '2103-04-06' })).body.data;
    expect(nextDay.costs.referralBonuses.amount).toBe(0);
  });

  it('refuses a date that is not YYYY-MM-DD with a 400', async () => {
    expect((await as(app, analyst).get('/analytics/financials').query({ startDate: 'yesterday' })).status).toBe(400);
  });

  it('downloads the P&L as CSV, deposits under money flow and not revenue', async () => {
    const res = await as(app, analyst).get('/analytics/financials.csv');
    expect(res.status).toBe(200);
    expect(res.text.split('\n')[0]).toBe('section,item,amount,count');
    expect(res.text).toMatch(/\nMoney flow \(not revenue\),Deposits,/);
    expect(res.text).not.toMatch(/\nRevenue,Deposits/);
  });
});
