// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The game and category admin routes (Games screen), through the real router
 * and a real database.
 *
 * Route coverage (2026-10-01) listed five of them as reached by NO tier. Testing
 * them found the defect this file is mostly about:
 *
 *   · `POST /admin/games` read `getGame` and then UPSERTED, under a comment
 *     saying the primary key decided. Two creates of one slug both passed the
 *     read, and the second overwrote the first — each admin told 200 (§32 S6).
 *   · `POST /admin/categories` upserted with no check at all, so "creating" a
 *     category whose slug existed replaced its name, icon and order, and
 *     re-enabled it if an admin had disabled it.
 *
 * Both are a CREATE now (`createOnly`): an existing slug writes nothing and
 * answers 409. Trap 10: every slug here is this run's own.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('game registry admin routes', () => {
  let app; let gamesAdmin; let contentOnly;
  const RUN = `rt${Date.now().toString(36)}`;
  let seq = 0;
  const slug = (tag) => `${RUN}-${tag}-${seq += 1}`;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/gameRegistry/gameRegistry.routes.js')).default);
    gamesAdmin = await actor({ isSubAdmin: true, permissions: { canManageGames: true } });
    contentOnly = await actor({ isSubAdmin: true, permissions: { canManageContent: true } });
  }, 60_000);

  afterAll(async () => {
    await pgQuery(`DELETE FROM games WHERE slug LIKE $1`, [`${RUN}-%`]);
    await pgQuery(`DELETE FROM game_categories WHERE slug LIKE $1`, [`${RUN}-%`]);
    await closePg();
  });

  const gameRow = async (s) => (await pgQuery(`SELECT name, status FROM games WHERE slug = $1`, [s])).rows[0];
  const categoryRow = async (s) => (await pgQuery(
    `SELECT name, icon, sort_order, enabled FROM game_categories WHERE slug = $1`, [s])).rows[0];

  // ── Games ────────────────────────────────────────────────────────────────
  it('creates an unpublished game, and refuses a second create of the same slug', async () => {
    const s = slug('game');
    const first = await as(app, gamesAdmin).post('/admin/games').send({ slug: s, name: 'First Name' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.game).toMatchObject({ slug: s, name: 'First Name', status: 'INACTIVE' });

    const again = await as(app, gamesAdmin).post('/admin/games').send({ slug: s, name: 'Overwritten' });
    expect(again.status).toBe(409);
    expect(again.body.message).toContain(s);
    expect((await gameRow(s)).name).toBe('First Name');
  });

  it('gives two simultaneous creates of one slug one game and one 409, never an overwrite', async () => {
    const s = slug('race');
    const [a, b] = await Promise.all([
      as(app, gamesAdmin).post('/admin/games').send({ slug: s, name: 'Racer A' }),
      as(app, gamesAdmin).post('/admin/games').send({ slug: s, name: 'Racer B' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? a : b;
    expect((await gameRow(s)).name).toBe(winner.body.game.name);
  });

  it('refuses an ACTIVE game nothing can launch, by name', async () => {
    const s = slug('unlaunchable');
    const res = await as(app, gamesAdmin).post('/admin/games')
      .send({ slug: s, name: 'Nowhere', status: 'ACTIVE', launchStrategy: 'URL' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/must be launchable/);
    expect(await gameRow(s)).toBeUndefined();
  });

  it('updates a game’s name and keeps its slug; 404 for one that does not exist', async () => {
    const s = slug('edit');
    expect((await as(app, gamesAdmin).post('/admin/games').send({ slug: s, name: 'Before' })).status).toBe(200);
    const res = await as(app, gamesAdmin).put(`/admin/games/${s}`).send({ name: 'After', slug: 'ignored-slug' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.game).toMatchObject({ slug: s, name: 'After' });
    expect((await as(app, gamesAdmin).put(`/admin/games/${slug('missing')}`).send({ name: 'x' })).status).toBe(404);
  });

  it('deletes a game, and answers 404 the second time', async () => {
    const s = slug('gone');
    expect((await as(app, gamesAdmin).post('/admin/games').send({ slug: s, name: 'Gone' })).status).toBe(200);
    expect((await as(app, gamesAdmin).delete(`/admin/games/${s}`)).status).toBe(200);
    expect(await gameRow(s)).toBeUndefined();
    expect((await as(app, gamesAdmin).delete(`/admin/games/${s}`)).status).toBe(404);
  });

  // ── Categories ───────────────────────────────────────────────────────────
  it('creates a category, and a second create of its slug changes nothing — a disabled one stays disabled', async () => {
    const s = slug('cat');
    const made = await as(app, gamesAdmin).post('/admin/categories').send({ slug: s, name: 'Original', icon: 'A', order: 3 });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    expect((await as(app, gamesAdmin).put(`/admin/categories/${s}`).send({ enabled: false })).status).toBe(200);

    const again = await as(app, gamesAdmin).post('/admin/categories').send({ slug: s, name: 'Replaced', icon: 'B', order: 9 });
    expect(again.status).toBe(409);
    expect(await categoryRow(s)).toEqual({ name: 'Original', icon: 'A', sort_order: 3, enabled: false });
  });

  it('updates a category; 404 for one that does not exist', async () => {
    const s = slug('catedit');
    expect((await as(app, gamesAdmin).post('/admin/categories').send({ slug: s, name: 'Cat' })).status).toBe(200);
    const res = await as(app, gamesAdmin).put(`/admin/categories/${s}`).send({ name: 'Renamed', order: 7 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await categoryRow(s)).toMatchObject({ name: 'Renamed', sort_order: 7 });
    expect((await as(app, gamesAdmin).put(`/admin/categories/${slug('nocat')}`).send({ name: 'x' })).status).toBe(404);
  });

  it('refuses to delete a category a game still uses, and deletes an empty one', async () => {
    const c = slug('used');
    const g = slug('ingame');
    expect((await as(app, gamesAdmin).post('/admin/categories').send({ slug: c, name: 'Used' })).status).toBe(200);
    expect((await as(app, gamesAdmin).post('/admin/games').send({ slug: g, name: 'In it', categorySlug: c })).status).toBe(200);
    const refused = await as(app, gamesAdmin).delete(`/admin/categories/${c}`);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/1 game\(s\) still use this category/);
    expect(await categoryRow(c)).toBeTruthy();

    expect((await as(app, gamesAdmin).delete(`/admin/games/${g}`)).status).toBe(200);
    expect((await as(app, gamesAdmin).delete(`/admin/categories/${c}`)).status).toBe(200);
    expect(await categoryRow(c)).toBeUndefined();
  });

  it('refuses every write to an account without the games area, and writes nothing', async () => {
    const s = slug('refused');
    expect((await as(app, contentOnly).post('/admin/games').send({ slug: s, name: 'No' })).status).toBe(403);
    expect((await as(app, contentOnly).post('/admin/categories').send({ slug: s, name: 'No' })).status).toBe(403);
    expect(await gameRow(s)).toBeUndefined();
    expect(await categoryRow(s)).toBeUndefined();
  });
});
