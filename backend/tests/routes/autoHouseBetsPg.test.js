// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * GET/PUT /api/bet/phantom/auto (owner, 2026-10-15), through the real route
 * and database: only a phantom agent, and only for a board their access
 * covers, saves an auto plan; a player without access is refused and keeps
 * nothing. Opposite case: the agent's own plan saves and reads back.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { updateUser } from '#db/repositories/users.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;
const BOARD = '30_MIN';

describePg('auto house-bet routes (PostgreSQL)', () => {
  let app;
  beforeAll(async () => {
    await applySchema();
    const { default: router } = await import('../../domains/markets/bet.routes.js');
    app = mountRouter(router, { prefix: '/api/bet' });
  });
  afterAll(async () => { await closePg(); });

  const plan = { boardKey: BOARD, audience: 'VIP', side: 'DELHI', amounts: [100, 50], enabled: true };
  const plansOf = async (userId) => (await pgQuery(
    `SELECT side, amounts_paise FROM phantom_auto_plans WHERE user_id = $1`, [userId],
  )).rows;

  it('refuses a player with no phantom access, and writes nothing', async () => {
    const player = await actor();
    const res = await as(app, player).put('/api/bet/phantom/auto').send(plan);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PHANTOM_ACCESS_REQUIRED');
    expect((await as(app, player).get('/api/bet/phantom/auto')).status).toBe(403);
    expect(await plansOf(player.userId)).toEqual([]);
  });

  it('refuses a board outside the agent\'s access', async () => {
    const other = (await pgQuery(`SELECT board_key FROM boards WHERE board_key <> $1 LIMIT 1`, [BOARD])).rows[0];
    if (!other) return; // a database with one board has nothing outside it
    const agent = await actor();
    await updateUser(agent.userId, { phantom_access: BOARD });
    const res = await as(app, agent).put('/api/bet/phantom/auto').send({ ...plan, boardKey: other.board_key });
    expect(res.status).toBe(403);
    expect(await plansOf(agent.userId)).toEqual([]);
  });

  it('refuses a bad side, a missing switch and an unknown board by name', async () => {
    const agent = await actor();
    await updateUser(agent.userId, { phantom_access: 'BOTH' });
    for (const body of [{ ...plan, side: 'PUNE' }, { ...plan, audience: undefined }, { ...plan, enabled: undefined }, { ...plan, boardKey: 'NO_SUCH_BOARD' }, { ...plan, amounts: [1.5] }]) {
      const res = await as(app, agent).put('/api/bet/phantom/auto').send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.message).toBeTruthy();
    }
    expect(await plansOf(agent.userId)).toEqual([]);
  });

  it('saves the agent\'s plan and reads it back with the limits', async () => {
    const agent = await actor();
    await updateUser(agent.userId, { phantom_access: BOARD });
    const saved = await as(app, agent).put('/api/bet/phantom/auto').send(plan);
    expect(saved.status).toBe(200);
    expect(saved.body.plan).toMatchObject({ boardKey: BOARD, side: 'DELHI', amounts: [100, 50], enabled: true });

    const read = await as(app, agent).get('/api/bet/phantom/auto');
    expect(read.status).toBe(200);
    expect(read.body.plans).toHaveLength(1);
    expect(read.body.limits).toEqual({ maxSteps: 1000, minRupees: 1, maxRupees: 10_000_000 });
    expect(await plansOf(agent.userId)).toEqual([{ side: 'DELHI', amounts_paise: ['10000', '5000'] }]);
  });
});
