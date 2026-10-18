// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The merchant panel's figures, through the real merchant router and a real
 * database (owner report, 2026-10-18: "the merchant panel is not showing data
 * properly, the cards don't show the right result, commission stays 0").
 *
 * What is pinned:
 *   · the live queue can ask for every open state at once, so an order still
 *     PROCESSING or DISPUTED is listed however many newer finished orders the
 *     merchant has (the panel loaded only the newest 50 of any state, and the
 *     Orders tiles counted that page);
 *   · an unknown status is refused, never read as "no orders";
 *   · History's totals and volume chart come from the server, split by
 *     direction, over every completed order;
 *   · "today" is the IST day, the one the weekly chart already used;
 *   · GET /stats says what the team's commission is: paid, or earned and
 *     waiting for the platform's commission pool.
 *
 * Rows are written straight into `order_states`, as merchantEarningsPg does:
 * these are read paths, and the reads are what is under test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery, withTransaction } from '#db/client.js';
import { teamFixture } from '../teamFixture.js';
import { mountRouter, merchantActor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('merchant panel figures', () => {
  let panel; let m; let team;
  const teams = teamFixture();
  const user = `mpf-user-${Date.now().toString(36)}`;
  let seq = 0;

  const order = async ({ type = 'DEPOSIT', state = 'COMPLETED', tokens = 500, createdAt = 'now()', completedAt }) => {
    seq += 1;
    const id = `mpf-${Date.now().toString(36)}-${seq}`;
    const done = completedAt ?? (state === 'COMPLETED' ? 'now()' : 'NULL');
    await pgQuery(
      `INSERT INTO order_states
         (order_id, user_id, merchant_id, team_id, order_type, state, token_amount_paise,
          fiat_amount_paise, currency, created_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'INR', ${createdAt}, ${done})`,
      [id, user, m.merchantId, team.teamId, type, state, tokens * 100]);
    return id;
  };

  beforeAll(async () => {
    await applySchema();
    panel = mountRouter((await import('../../domains/merchant/merchant.routes.js')).default);
    m = await merchantActor();
    team = await teams.workingTeam({ rail: 'UPI_BANK', include: [m.merchantId] });
  }, 60_000);

  afterAll(async () => {
    await withTransaction(async (c) => {
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query('DELETE FROM order_transitions WHERE order_id IN (SELECT order_id FROM order_states WHERE user_id = $1)', [user]);
      await c.query('DELETE FROM order_states WHERE user_id = $1', [user]);
    });
    await teams.cleanup();
    await closePg();
  });

  it('lists an old open order beside sixty newer finished ones when asked for the open states', async () => {
    const processing = await order({ state: 'PROCESSING', createdAt: "now() - interval '3 days'" });
    const disputed = await order({ type: 'WITHDRAWAL', state: 'DISPUTED', createdAt: "now() - interval '2 days'" });
    for (let i = 0; i < 60; i += 1) await order({ createdAt: `now() - interval '${i} minutes'` });

    // The newest page alone does not reach them: what the panel used to load.
    const newest = await as(panel, m).get('/orders?limit=50');
    expect(newest.status).toBe(200);
    const newestIds = newest.body.orders.map((o) => o.orderId ?? o._id);
    expect(newestIds).not.toContain(processing);

    const open = await as(panel, m).get('/orders?status=PENDING_QUEUE,PROCESSING,PAID,DISPUTED&limit=100');
    expect(open.status, open.body.message).toBe(200);
    const ids = open.body.orders.map((o) => o.orderId ?? o._id);
    expect(ids).toContain(processing);
    expect(ids).toContain(disputed);
    expect(open.body.orders.every((o) => ['PENDING_QUEUE', 'PROCESSING', 'PAID', 'DISPUTED'].includes(o.status))).toBe(true);

    // One state still works as it did.
    const one = await as(panel, m).get('/orders?status=DISPUTED');
    expect(one.body.orders.map((o) => o.orderId ?? o._id)).toEqual([disputed]);
  });

  it('refuses an unknown status rather than answering an empty queue', async () => {
    const res = await as(panel, m).get('/orders?status=PROCESSING,NOPE');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_ORDER_STATE');
  });

  it('sends lifetime and daily volume split by direction, over every completed order', async () => {
    await pgQuery('DELETE FROM order_states WHERE user_id = $1', [user]);
    for (let i = 0; i < 3; i += 1) await order({ type: 'DEPOSIT', tokens: 1_000 });
    await order({ type: 'WITHDRAWAL', tokens: 5_000 });
    await order({ type: 'WITHDRAWAL', state: 'PROCESSING', tokens: 9_000 });

    const e = await as(panel, m).get('/earnings');
    expect(e.status).toBe(200);
    const life = e.body.earnings.lifetime;
    expect(life.totalOrders).toBe(4);
    expect(life.totalVolume).toBe(8_000);
    expect(life.deposits).toEqual({ count: 3, totalVolume: 3_000 });
    expect(life.withdrawals).toEqual({ count: 1, totalVolume: 5_000 });

    const w = await as(panel, m).get('/earnings/weekly');
    expect(w.status).toBe(200);
    const today = w.body.weekly.at(-1);
    expect(today.depositVolume).toBe(3_000);
    expect(today.withdrawalVolume).toBe(5_000);
  });

  it('counts "today" from IST midnight, not the database session\'s day', async () => {
    await pgQuery('DELETE FROM order_states WHERE user_id = $1', [user]);
    const istMidnight = `(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;
    // A minute after IST midnight is today; a minute before it is yesterday.
    await order({ tokens: 500, completedAt: `${istMidnight} + interval '1 minute'`, createdAt: `${istMidnight}` });
    await order({ tokens: 1_000, completedAt: `${istMidnight} - interval '1 minute'`, createdAt: `${istMidnight} - interval '2 minutes'` });

    // The test database runs in UTC, as the server's does: CURRENT_DATE there
    // starts at 05:30 IST, which put the 00:01 IST order on "yesterday".
    const e = await as(panel, m).get('/earnings');
    expect(e.body.earnings.today.deposits).toEqual({ count: 1, totalAmount: 500 });
    const s = await as(panel, m).get('/stats');
    expect(s.body.stats.completedToday).toBe(1);
  });

  it('tells the dashboard what the team\'s commission is, including what waits for the pool', async () => {
    await pgQuery('DELETE FROM order_states WHERE user_id = $1', [user]);
    await order({ type: 'DEPOSIT', tokens: 10_000 });
    await order({ type: 'WITHDRAWAL', tokens: 4_000 });

    const s = await as(panel, m).get('/stats');
    expect(s.status).toBe(200);
    const c = s.body.commission;
    expect(c.teamId).toBe(String(team.teamId));
    expect(c.buysPaise).toBe(10_000_00);
    expect(c.sellsPaise).toBe(4_000_00);
    expect(c.matchedPaise).toBe(4_000_00);
    // Nothing paid (the commission pool is not funded in this suite), so the
    // 10% of the matched rise is owed: the figure the dashboard shows beside a 0.
    expect(c.paidPaise).toBe(0);
    expect(c.owedPaise).toBe(400_00);
  });

  it('sends no commission for a merchant who works in no team', async () => {
    const loner = await merchantActor();
    const s = await as(panel, loner).get('/stats');
    expect(s.status).toBe(200);
    expect(s.body.commission).toBeNull();
  });
});
