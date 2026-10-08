// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The admin's boards and the public board list, over HTTP against a real
 * database (owner, 2026-10-08).
 *
 *   GET  /admin/boards          canManageGames; every board + the timer choices
 *   POST /admin/boards          create
 *   PUT  /admin/boards/order    every board, first to last
 *   PUT  /admin/boards/:key     edit / switch
 *   GET  /v1/boards             public: switched-on boards, in home order
 *
 * The row rules themselves are in database/tests/boardsPg.test.js.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomInt } from 'node:crypto';
import { pgConfigured, pgQuery, applySchema, closePg } from '#db/client.js';
import { listBoards, setHomeOrder } from '#db/repositories/boards.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

const BODY = () => ({
  name: `Rt board ${randomInt(0, 1e9)}`, kind: 'INTERVAL', durationMin: 10,
  phases: { mergeBeforeEndSec: 60, equalizerBeforeEndSec: 40, closeBeforeEndSec: 20, celebrateBeforeEndSec: 5 },
  minBet: 20, maxBet: 2000,
});

describePg('board routes', () => {
  let admin; let pub; let gamesStaff; let otherStaff;
  const created = [];
  let originalOrder;

  beforeAll(async () => {
    await applySchema();
    admin = mountRouter((await import('../../routes/admin/boards.admin.routes.js')).default);
    pub = mountRouter((await import('../../domains/user/user.routes.js')).default);
    gamesStaff = await actor({ isSubAdmin: true, permissions: { canManageGames: true } });
    otherStaff = await actor({ isSubAdmin: true, permissions: { canManageContent: true } });
    originalOrder = (await listBoards()).map((b) => b.key);
  }, 60_000);

  afterAll(async () => {
    if (created.length) await pgQuery('UPDATE boards SET enabled = false WHERE board_key = ANY($1)', [created]).catch(() => {});
    await setHomeOrder((await listBoards()).map((b) => b.key)
      .sort((a, b) => (originalOrder.indexOf(a) + 1 || 1e9) - (originalOrder.indexOf(b) + 1 || 1e9))).catch(() => {});
    await closePg();
  });

  it('admits only staff holding canManageGames', async () => {
    expect((await request(admin).get('/boards')).status).toBe(401);
    expect((await as(admin, otherStaff).get('/boards')).status).toBe(403);
    expect((await as(admin, otherStaff).post('/boards').send(BODY())).status).toBe(403);
    expect((await as(admin, otherStaff).put('/boards/30_MIN').send({ minBet: 11 })).status).toBe(403);
    expect((await as(admin, otherStaff).put('/boards/order').send({ keys: originalOrder })).status).toBe(403);

    const ok = await as(admin, gamesStaff).get('/boards');
    expect(ok.status).toBe(200);
    expect(ok.body.intervalMinutes).toEqual([1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60]);
    expect(ok.body.boards.map((b) => b.key)).toEqual(expect.arrayContaining(['1_MIN', '30_MIN', 'FULL_DAY']));
  });

  it('creates a board players then see, last on the home page, and hides it once switched off', async () => {
    const res = await as(admin, gamesStaff).post('/boards').send(BODY());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { board } = res.body;
    created.push(board.key);

    const seen = (await request(pub).get('/v1/boards')).body.boards;
    expect(seen.at(-1)).toMatchObject({ key: board.key, durationMin: 10, minBet: 20, maxBet: 2000 });
    // The public view carries what the panel draws and times by, nothing more.
    expect(Object.keys(seen.at(-1)).sort()).toEqual(
      ['anchorHourIst', 'durationMin', 'homeOrder', 'idPrefix', 'key', 'kind', 'maxBet', 'minBet', 'name', 'phases'].sort());

    const off = await as(admin, gamesStaff).put(`/boards/${board.key}`).send({ enabled: false });
    expect(off.status).toBe(200);
    expect((await request(pub).get('/v1/boards')).body.boards.map((b) => b.key)).not.toContain(board.key);
    const { rows } = await pgQuery('SELECT enabled FROM boards WHERE board_key = $1', [board.key]);
    expect(rows[0].enabled).toBe(false);
  });

  it('answers a bad board with the field that is wrong, and writes nothing', async () => {
    const before = (await listBoards()).length;
    const res = await as(admin, gamesStaff).post('/boards').send({ ...BODY(), durationMin: 7 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/tile the hour/);
    expect((await listBoards()).length).toBe(before);

    const edit = await as(admin, gamesStaff).put('/boards/30_MIN').send({ minBet: 5000, maxBet: 100 });
    expect(edit.status).toBe(400);
    expect(edit.body.message).toMatch(/minimum bet cannot be above/);
    expect((await as(admin, gamesStaff).put('/boards/NO_SUCH_BOARD').send({ minBet: 20 })).status).toBe(404);
  });

  it('sets the home-page order the players are given', async () => {
    const all = (await listBoards()).map((b) => b.key);
    const wanted = [all.at(-1), ...all.slice(0, -1)];
    const res = await as(admin, gamesStaff).put('/boards/order').send({ keys: wanted });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const enabledInOrder = (await listBoards()).filter((b) => b.enabled).map((b) => b.key);
    expect((await request(pub).get('/v1/boards')).body.boards.map((b) => b.key)).toEqual(enabledInOrder);
    expect((await listBoards()).map((b) => b.key)).toEqual(wanted);

    const partial = await as(admin, gamesStaff).put('/boards/order').send({ keys: wanted.slice(1) });
    expect(partial.status).toBe(400);
    expect(partial.body.code).toBe('INVALID_BOARD_ORDER');
    expect((await listBoards()).map((b) => b.key)).toEqual(wanted);
  });
});
