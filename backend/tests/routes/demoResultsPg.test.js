// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Demo results the admin types (owner, 2026-10-20): per board and profile,
 * B/D oldest first, at most 1,440; one file for every board at once, checked
 * whole before anything is saved; sent to players with the board.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomInt } from 'node:crypto';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import * as boards from '#db/repositories/boards.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;
const PHASES = { mergeBeforeEndSec: 40, equalizerBeforeEndSec: 30, closeBeforeEndSec: 20, celebrateBeforeEndSec: 5 };

describePg('typed demo results', () => {
  let app; let publicApp; let admin; let player; let key;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../routes/admin/boards.admin.routes.js')).default);
    publicApp = mountRouter((await import('../../domains/user/user.routes.js')).default, { prefix: '/api' });
    admin = await actor({ isAdmin: true });
    player = await actor({});
    key = (await boards.createBoard({ name: `Demo ${randomInt(0, 1e9)}`, kind: 'INTERVAL', durationMin: 5, phases: PHASES, minBet: 10, maxBet: 1000 })).key;
  }, 60_000);

  afterAll(async () => {
    await pgQuery(`UPDATE boards SET enabled = false, demo_vip = '', demo_general = '' WHERE board_key = $1`, [key]);
    await closePg();
  });

  it('saves B and D typed any way, oldest first, and players get them with the board', async () => {
    const res = await as(app, admin).put(`/boards/${key}/demo-results`).send({ audience: 'VIP', results: 'b, D,bombay\nDELHI' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ count: 4, bombay: 2, delhi: 2, results: 'B,D,B,D' });
    const { invalidateBoards } = await import('../../domains/markets/cycleTypes.js');
    invalidateBoards();
    const pub = await as(publicApp, player).get('/api/v1/boards');
    const mine = pub.body.boards.find((b) => b.key === key);
    expect(mine.demoResults).toEqual({ VIP: 'BDBD', GENERAL: '' });
  });

  it('refuses anything but B or D, naming the entry, and more than 1,440', async () => {
    const bad = await as(app, admin).put(`/boards/${key}/demo-results`).send({ audience: 'VIP', results: 'B,D,X' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/Result 3 is "X"/);
    const many = await as(app, admin).put(`/boards/${key}/demo-results`).send({ audience: 'GENERAL', results: Array(1441).fill('B').join(',') });
    expect(many.status).toBe(400);
    const wrongProfile = await as(app, admin).put(`/boards/${key}/demo-results`).send({ audience: 'GOLD', results: 'B' });
    expect(wrongProfile.status).toBe(400);
    const full = await as(app, admin).put(`/boards/${key}/demo-results`).send({ audience: 'GENERAL', results: Array(1440).fill('D').join(',') });
    expect(full.body.count).toBe(1440);
  });

  it('the downloaded file comes back in whole; one bad line saves nothing', async () => {
    const csv = await as(app, admin).get('/boards/demo-results.csv');
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(`${key},VIP,"B,D,B,D"`);
    const okFile = `board,profile,results\n${key},VIP,D,D\n${key},GENERAL,"B,B,B"`;
    const ok = await as(app, admin).post('/boards/demo-results/import').send({ text: okFile });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await boards.getBoard(key)).demoResults).toEqual({ VIP: 'DD', GENERAL: 'BBB' });
    const badFile = `${key},VIP,B,B\n${key},GENERAL,B,Q`;
    const bad = await as(app, admin).post('/boards/demo-results/import').send({ text: badFile });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/Line 2/);
    expect((await boards.getBoard(key)).demoResults).toEqual({ VIP: 'DD', GENERAL: 'BBB' });
  });

  it('an empty box goes back to the drawn ones', async () => {
    const res = await as(app, admin).put(`/boards/${key}/demo-results`).send({ audience: 'VIP', results: '' });
    expect(res.body.count).toBe(0);
    expect((await boards.getBoard(key)).demoResults.VIP).toBe('');
  });

  it('is the games area only', async () => {
    const res = await as(app, player).put(`/boards/${key}/demo-results`).send({ audience: 'VIP', results: 'B' });
    expect([401, 403]).toContain(res.status);
  });

  it('the database refuses anything but B and D', async () => {
    await expect(pgQuery(`UPDATE boards SET demo_vip = 'BX' WHERE board_key = $1`, [key]))
      .rejects.toMatchObject({ constraint: 'boards_demo_results_shape' });
  });
});
