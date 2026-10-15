// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Auto house bets (owner, 2026-10-15), against a REAL PostgreSQL (skipped when
 * DATABASE_URL is unset): a phantom agent's plan is saved whole or refused,
 * runs only while its owner holds phantom access, and a tick's bets move the
 * phantom pools once, however often the same second is offered.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { createUser, updateUser } from '../repositories/users.js';
import { savePlan, listFor, runnablePlans } from '../repositories/phantomAutoPlans.js';
import { placeAutoPhantomBets, getCycle } from '../repositories/markets.js';

const describePg = pgConfigured() ? describe : describe.skip;
const BOARD = '30_MIN';
let cycleN = 0;

async function openCycle(status = 'OPEN') {
  const id = `auto-${Date.now()}-${++cycleN}`;
  await pgQuery(
    `INSERT INTO cycles (cycle_id, cycle_type, status, start_time, end_time)
     VALUES ($1, $2, $3, now() - interval '1 minute', now() + interval '29 minutes')`,
    [id, BOARD, status],
  );
  return id;
}

const realBets = async (cycleId) => Number((await pgQuery(
  `SELECT COUNT(*) AS n FROM bets WHERE cycle_id = $1 AND NOT is_phantom`, [cycleId],
)).rows[0].n);

describePg('auto house bets (PostgreSQL)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE users RESTART IDENTITY CASCADE');
    await createUser({ userId: 'ag1', username: 'agent', mobile: '9990000201' });
    await createUser({ userId: 'pl1', username: 'player', mobile: '9990000202' });
    await updateUser('ag1', { phantom_access: 'BOTH' });
  });

  it('saves a plan of whole-rupee sizes and lists it in rupees', async () => {
    await savePlan({ userId: 'ag1', boardKey: BOARD, audience: 'VIP', side: 'DELHI', amounts: [100, '250', 50], enabled: true });
    const [plan] = await listFor('ag1');
    expect(plan).toMatchObject({ boardKey: BOARD, side: 'DELHI', amounts: [100, 250, 50], enabled: true });
  });

  it('refuses a plan with no sizes, too many, or a size that is not whole rupees, naming it', async () => {
    const save = (amounts) => savePlan({ userId: 'ag1', boardKey: BOARD, audience: 'VIP', side: 'BOMBAY', amounts, enabled: true });
    await expect(save([])).rejects.toMatchObject({ status: 400 });
    await expect(save(Array(1001).fill(10))).rejects.toMatchObject({ status: 400, message: expect.stringContaining('1000') });
    await expect(save([10, 2.5])).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Size 2') });
    await expect(save([0])).rejects.toMatchObject({ status: 400 });
    // 1,000 is allowed.
    await expect(save(Array(1000).fill(10))).resolves.toMatchObject({ side: 'BOMBAY' });
  });

  it('the database refuses a list the repository would refuse', async () => {
    await expect(pgQuery(
      `INSERT INTO phantom_auto_plans (user_id, board_key, audience, side, amounts_paise) VALUES ('ag1', $1, 'VIP', 'DELHI', '{150}')`,
      [BOARD],
    )).rejects.toMatchObject({ constraint: 'phantom_auto_plans_amounts' });
  });

  it('keeps a VIP and a General plan for the same board and side apart, and refuses one naming neither', async () => {
    await savePlan({ userId: 'ag1', boardKey: BOARD, audience: 'VIP', side: 'DELHI', amounts: [10], enabled: true });
    await savePlan({ userId: 'ag1', boardKey: BOARD, audience: 'GENERAL', side: 'DELHI', amounts: [20, 30], enabled: false });
    const plans = await listFor('ag1');
    expect(plans.map((p) => [p.audience, p.amounts, p.enabled])).toEqual([['GENERAL', [20, 30], false], ['VIP', [10], true]]);
    expect((await runnablePlans()).map((p) => p.audience)).toEqual(['VIP']);
    await expect(savePlan({ userId: 'ag1', boardKey: BOARD, side: 'DELHI', amounts: [10], enabled: true }))
      .rejects.toMatchObject({ status: 400 });
    await expect(pgQuery(
      `INSERT INTO phantom_auto_plans (user_id, board_key, audience, side, amounts_paise) VALUES ('ag1', $1, 'BOTH', 'BOMBAY', '{1000}')`,
      [BOARD],
    )).rejects.toMatchObject({ constraint: 'phantom_auto_plans_audience_known' });
  });

  it('runs only while switched on and its owner holds access to the board', async () => {
    await savePlan({ userId: 'ag1', boardKey: BOARD, audience: 'VIP', side: 'DELHI', amounts: [10], enabled: true });
    expect((await runnablePlans()).map((p) => p.userId)).toEqual(['ag1']);

    await updateUser('ag1', { phantom_access: 'NONE' });
    expect(await runnablePlans()).toEqual([]);

    await updateUser('ag1', { phantom_access: BOARD });
    expect(await runnablePlans()).toHaveLength(1);

    await savePlan({ userId: 'ag1', boardKey: BOARD, audience: 'VIP', side: 'DELHI', amounts: [10], enabled: false });
    expect(await runnablePlans()).toEqual([]);
  });

  it('places each second once and moves only the phantom pools', async () => {
    const cycleId = await openCycle();
    const bets = [
      { userId: 'ag1', side: 'DELHI', second: 0, amountPaise: 100_00 },
      { userId: 'ag1', side: 'DELHI', second: 1, amountPaise: 250_00 },
      { userId: 'ag1', side: 'BOMBAY', second: 1, amountPaise: 50_00 },
    ];
    const first = await placeAutoPhantomBets({ cycleId, cycleType: BOARD, bets });
    expect(first).toMatchObject({ ok: true, placed: 3, delhiRupees: 350, bombayRupees: 50 });

    // The same seconds again, plus one new one: only the new one lands.
    const again = await placeAutoPhantomBets({
      cycleId, cycleType: BOARD,
      bets: [...bets, { userId: 'ag1', side: 'DELHI', second: 2, amountPaise: 100_00 }],
    });
    expect(again).toMatchObject({ ok: true, placed: 1, delhiRupees: 100, bombayRupees: 0 });

    const cycle = await getCycle(cycleId);
    expect(cycle.phantomDelhi).toBe(450);
    expect(cycle.phantomBombay).toBe(50);
    const { rows } = await pgQuery(
      `SELECT COUNT(*)::int AS n, bool_and(is_phantom) AS all_phantom FROM bets WHERE cycle_id = $1`, [cycleId],
    );
    expect(rows[0]).toEqual({ n: 4, all_phantom: true });
    // Bystander: no real bet appeared.
    expect(await realBets(cycleId)).toBe(0);
  });

  it('places nothing on a round past betting or with phantom betting closed', async () => {
    const one = [{ userId: 'ag1', side: 'DELHI', second: 0, amountPaise: 100_00 }];
    const closed = await openCycle('CLOSED');
    expect(await placeAutoPhantomBets({ cycleId: closed, cycleType: BOARD, bets: one }))
      .toMatchObject({ ok: false, reason: 'CYCLE_CLOSED' });

    const equalized = await openCycle();
    await pgQuery(`UPDATE cycles SET phantom_bets_closed = TRUE WHERE cycle_id = $1`, [equalized]);
    expect(await placeAutoPhantomBets({ cycleId: equalized, cycleType: BOARD, bets: one }))
      .toMatchObject({ ok: false, reason: 'PHANTOM_CLOSED' });

    for (const id of [closed, equalized]) {
      const c = await getCycle(id);
      expect([c.phantomDelhi, c.phantomBombay]).toEqual([0, 0]);
    }
  });
});
