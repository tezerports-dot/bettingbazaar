// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The curated winners an operator adds to the public feed (Winners screen,
 * `canManageContent`), and what that feed publishes. Through the real router
 * and a real database.
 *
 * Route coverage (2026-10-01) listed the editor's create, edit and delete as
 * reached by NO tier. Testing them found three things:
 *
 *   · the EDIT took any amount — the create refuses ≤ 0, the table has no CHECK,
 *     so an entry could be edited to −5 and published that way — and a
 *     non-number threw a bare TypeError that left as a 500 (§32 S3, S35);
 *   · the edit was the one change to this feed that wrote no audit row;
 *   · the PUBLIC, unauthenticated feed spread the editor's row whole, so it
 *     published `createdBy` — the staff account that wrote the entry (S52).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgQuery, pgConfigured, applySchema, closePg } from '#db/client.js';
import { historyFor } from '#db/repositories/audit.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('curated winners', () => {
  let app; let editor; let analyst;
  const RUN = `cw-${Date.now().toString(36)}`;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../routes/winners.routes.js')).default);
    editor = await actor({ isSubAdmin: true, permissions: { canManageContent: true } });
    analyst = await actor({ isSubAdmin: true, permissions: { canViewAnalytics: true } });
  }, 60_000);

  afterAll(async () => {
    await pgQuery(`DELETE FROM fake_winners WHERE display_name LIKE $1`, [`${RUN}%`]);
    await closePg();
  });

  const add = async (name, extra = {}) => {
    const res = await as(app, editor).post('/admin/fake-winners').send({ displayName: `${RUN}-${name}`, amount: 500, ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.winner;
  };
  const stored = async (id) => (await pgQuery(`SELECT amount_paise, display_name FROM fake_winners WHERE id = $1`, [id])).rows[0];
  const audits = async (id, action) => (await historyFor(String(id))).filter((a) => a.action === action);

  it('creates an entry and records who added it', async () => {
    const w = await add('created');
    expect(w.amount).toBe(500);
    expect(await audits(w.id, 'CURATED_WINNER_ADDED')).toHaveLength(1);
  });

  it('refuses to create one with no amount or a non-positive one', async () => {
    for (const amount of [0, -5, undefined]) {
      const res = await as(app, editor).post('/admin/fake-winners').send({ displayName: `${RUN}-bad`, amount });
      expect(res.status, `amount ${amount}`).toBe(400);
    }
  });

  it('edits the amount, and the edit is audited with what it changed', async () => {
    const w = await add('edited');
    const res = await as(app, editor).put(`/admin/fake-winners/${w.id}`).send({ amount: 750, city: 'Pune' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Number((await stored(w.id)).amount_paise)).toBe(75_000);
    const rows = await audits(w.id, 'CURATED_WINNER_UPDATED');
    expect(rows).toHaveLength(1);
    expect(rows[0].details.fields.sort()).toEqual(['amount', 'city']);
    expect(String(rows[0].performedBy)).toBe(String(editor.userId));
  });

  it('refuses an edit to a non-positive or non-number amount with a 400, and changes nothing', async () => {
    const w = await add('guarded');
    for (const amount of [-5, 0, 'lots']) {
      const res = await as(app, editor).put(`/admin/fake-winners/${w.id}`).send({ amount });
      expect(res.status, `amount ${JSON.stringify(amount)}: ${JSON.stringify(res.body)}`).toBe(400);
      expect(res.body.message).toBe('amount must be positive');
    }
    expect(Number((await stored(w.id)).amount_paise)).toBe(50_000);
    expect(await audits(w.id, 'CURATED_WINNER_UPDATED')).toHaveLength(0);
  });

  it('answers 404 for an entry that does not exist, and 400 for an id that is not one', async () => {
    expect((await as(app, editor).put('/admin/fake-winners/999999999').send({ city: 'x' })).status).toBe(404);
    expect((await as(app, editor).put('/admin/fake-winners/undefined').send({ city: 'x' })).status).toBe(400);
  });

  it('deletes an entry once, audited, and 404s the second time', async () => {
    const w = await add('deleted');
    expect((await as(app, editor).delete(`/admin/fake-winners/${w.id}`)).status).toBe(200);
    expect(await stored(w.id)).toBeUndefined();
    expect(await audits(w.id, 'CURATED_WINNER_DELETED')).toHaveLength(1);
    expect((await as(app, editor).delete(`/admin/fake-winners/${w.id}`)).status).toBe(404);
  });

  it('refuses every write to an account without the content area', async () => {
    const w = await add('protected');
    expect((await as(app, analyst).post('/admin/fake-winners').send({ displayName: `${RUN}-no`, amount: 5 })).status).toBe(403);
    expect((await as(app, analyst).put(`/admin/fake-winners/${w.id}`).send({ amount: 9 })).status).toBe(403);
    expect((await as(app, analyst).delete(`/admin/fake-winners/${w.id}`)).status).toBe(403);
    expect(Number((await stored(w.id)).amount_paise)).toBe(50_000);
  });

  // ── What the PUBLIC feed publishes ────────────────────────────────────────
  it('publishes a public entry with the feed’s keys only — never the staff id that wrote it', async () => {
    await add('public');
    await add('hidden', { isPublic: false });
    const res = await request(app).get('/v1/winners').query({ limit: 200, period: 'week' });
    expect(res.status).toBe(200);
    const mine = res.body.winners.filter((w) => String(w.displayName).startsWith(RUN));
    expect(mine.map((w) => w.displayName)).toContain(`${RUN}-public`);
    expect(mine.map((w) => w.displayName)).not.toContain(`${RUN}-hidden`);
    for (const w of mine) {
      expect(Object.keys(w).sort()).toEqual(
        ['amount', 'badge', 'city', 'displayName', 'displayTime', 'game', 'isReal', 'profilePic'],
      );
    }
    expect(JSON.stringify(res.body)).not.toContain(String(editor.userId));
  });
});
