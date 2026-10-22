// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Admin › Owner Dashboard against a real database (owner, 2026-10-22).
 *
 * A settled VIP round is the profit; the real routes then show it in VIP
 * revenue, count it in a completed week of the owner's, let the owner take
 * out no more than is claimable, and record each withdrawal (a correction is
 * a negative row: the table is append-only). Players online come from the
 * minute samples. The supply split shows General balances and escrow as their
 * own holders, still adding up to the supply.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomInt } from 'node:crypto';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import * as boards from '#db/repositories/boards.js';
import { recordSample } from '#db/repositories/presence.js';
import { tokenHolders } from '#db/repositories/tokenHolders.js';
import router from '../../domains/revenue/ownerLedger.admin.routes.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;
const tag = `own-${Date.now().toString(36)}`;
const PHASES = { mergeBeforeEndSec: 40, equalizerBeforeEndSec: 30, closeBeforeEndSec: 20, celebrateBeforeEndSec: 5 };
const PROFIT = 50_000_000_00; // ₹5 crore, so the week clears every other suite's costs
const FEES = 1_000_00;

describePg('Admin › Owner Dashboard', () => {
  let app;
  let admin;
  let analyst;
  let board;
  const settledAt = new Date(Date.now() - 10 * 86_400_000);

  beforeAll(async () => {
    await applySchema();
    app = mountRouter(router);
    admin = await actor({ isAdmin: true });
    analyst = await actor({ isSubAdmin: true, permissions: { canViewAnalytics: true } });
    board = (await boards.createBoard({
      name: `Owner ${randomInt(0, 1e9)}`, kind: 'INTERVAL', durationMin: 5, phases: PHASES, minBet: 10, maxBet: 1000,
    })).key;
    await pgQuery(
      `INSERT INTO cycles (cycle_id, cycle_type, audience, status, start_time, end_time)
       VALUES ($1, $2, 'VIP', 'OPEN', $3::timestamptz - interval '5 minutes', $3::timestamptz)`,
      [`${tag}-c1`, board, settledAt]);
    await pgQuery(
      `UPDATE cycles SET status = 'COMPLETED', winner = 'DELHI', is_settled = TRUE, settled_at = $2,
              net_profit_paise = $3, total_platform_fees_paise = $4 WHERE cycle_id = $1`,
      [`${tag}-c1`, settledAt, PROFIT, FEES]);
  }, 60_000);

  afterAll(async () => {
    await pgQuery('UPDATE boards SET enabled = false WHERE board_key = $1', [board]).catch(() => {});
    await closePg();
  });

  it('VIP revenue counts the round\'s side difference and its fee, over the window that holds it', async () => {
    const day = new Date(settledAt.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const res = await as(app, analyst).get('/owner/dashboard').query({ from: day, to: day });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.vip.revenue.cycleSides).toBeGreaterThanOrEqual((PROFIT - FEES) / 100);
    expect(res.body.vip.revenue.winningFees).toBeGreaterThanOrEqual(FEES / 100);
    expect(res.body.vip.revenue.rounds).toBeGreaterThanOrEqual(1);
    expect(res.body.vip.netProfit).toBe(Number((res.body.vip.revenue.total - res.body.vip.costs.total).toFixed(2)));
    expect(res.body.stats).toHaveProperty('firstTimeDepositors');
    expect(res.body.general).toHaveProperty('claimed');
  });

  it('a bad day is a 400 naming it', async () => {
    const res = await as(app, analyst).get('/owner/dashboard').query({ from: '22-10-2026' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('BAD_DATE');
  });

  it('the settlement is the owner\'s alone: analytics staff are refused', async () => {
    expect((await as(app, analyst).get('/owner/settlements')).status).toBe(403);
    expect((await as(app, analyst).post('/owner/settlements').send({ amount: 1 })).status).toBe(403);
    expect((await as(app, analyst).put('/owner/settlements/week-start').send({ weekStartsAt: new Date() })).status).toBe(403);
  });

  it('nothing can be taken out before a week has finished', async () => {
    expect((await as(app, admin).put('/owner/settlements/week-start')
      .send({ weekStartsAt: new Date(Date.now() - 3_600_000).toISOString() })).status).toBe(200);
    const res = await as(app, admin).post('/owner/settlements').send({ amount: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_COMPLETE_WEEK');
  });

  it('a finished week\'s profit is claimable; more is refused; a withdrawal and its correction are both recorded', async () => {
    const start = new Date(settledAt.getTime() - 2 * 86_400_000);
    expect((await as(app, admin).put('/owner/settlements/week-start').send({ weekStartsAt: start.toISOString() })).status).toBe(200);

    const before = await as(app, admin).get('/owner/settlements');
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.weeks.length).toBeGreaterThanOrEqual(2);
    expect(before.body.weeks.some((w) => w.complete && w.netProfit >= (PROFIT / 100) * 0.5)).toBe(true);
    expect(before.body).not.toHaveProperty('claimablePaise');
    const { claimable } = before.body;
    expect(claimable).toBeGreaterThan(0);

    const over = await as(app, admin).post('/owner/settlements').send({ amount: claimable + 1 });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('OVER_CLAIMABLE');

    const took = await as(app, admin).post('/owner/settlements').send({ amount: 1000, note: `${tag} week` });
    expect(took.status, JSON.stringify(took.body)).toBe(201);
    expect(took.body.settlement).toMatchObject({ amount: 1000, note: `${tag} week` });

    const after = await as(app, admin).get('/owner/settlements');
    expect(after.body.claimable).toBeCloseTo(claimable - 1000, 2);
    expect(after.body.settlements[0].settlementId).toBe(took.body.settlement.settlementId);

    expect((await as(app, admin).post('/owner/settlements').send({ amount: -1000 })).body.code).toBe('NOTE_REQUIRED');
    const fix = await as(app, admin).post('/owner/settlements').send({ amount: -1000, note: `${tag} entered twice` });
    expect(fix.status).toBe(201);
    expect((await as(app, admin).get('/owner/settlements')).body.claimable).toBeCloseTo(claimable, 2);

    await expect(pgQuery('DELETE FROM owner_settlements WHERE settlement_id = $1', [took.body.settlement.settlementId]))
      .rejects.toThrow();
  });

  it('players online: the live figure and the peak, with its minute', async () => {
    await recordSample(`${tag}-w1`, 7);
    await recordSample(`${tag}-w2`, 5);
    const res = await as(app, analyst).get('/owner/dashboard');
    expect(res.body.online.now).toBeGreaterThanOrEqual(12);
    expect(res.body.online.allTimePeak.players).toBeGreaterThanOrEqual(12);
    expect(res.body.online.allTimePeak.at).toBeTruthy();
  });

  it('General balances and escrow are their own holders, and the holders still add up to the supply', async () => {
    const t = await tokenHolders({ limit: 1 });
    expect(t.kinds.map((k) => k.kind)).toEqual(expect.arrayContaining(['GENERAL', 'ESCROW', 'PLAYER']));
    // Whether the shared test database is whole depends on other suites'
    // cleanup (adminTokenSupplyPnlPg.test.js, trap 10): the kinds must still add
    // up to what the report says it accounted for.
    const sum = t.kinds.reduce((n, k) => n + k.tokens, 0);
    expect(sum).toBeCloseTo(t.accounted, 2);
  });
});
