// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Two admin buttons whose routes no test tier ever reached (report:routes,
 * 2026-10-01): Operations → "Rebuild leaderboard" (`POST /api/leaderboard/rebuild`,
 * canRunMaintenance) and Announcements → edit (`PUT /api/admin/announcements/:id`,
 * canManageContent). Through the real router and a real database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { db } from '#db';
import { historyFor } from '#db/repositories/audit.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('maintenance and announcement edit routes', () => {
  let app; let maintainer; let analyst; let editor;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../routes/retention.routes.js')).default);
    maintainer = await actor({ isSubAdmin: true, permissions: { canRunMaintenance: true } });
    analyst = await actor({ isSubAdmin: true, permissions: { canViewAnalytics: true } });
    editor = await actor({ isSubAdmin: true, permissions: { canManageContent: true } });
  }, 60_000);

  afterAll(async () => { await closePg(); });

  // ── Rebuild the leaderboard ──────────────────────────────────────────────
  it('rebuilds every period and says what it wrote', async () => {
    const res = await as(app, maintainer).post('/leaderboard/rebuild').send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.periods.length).toBeGreaterThan(0);
    for (const { period, entries } of res.body.periods) {
      expect(Number.isInteger(entries)).toBe(true);
      // What it SAYS it wrote is what the board now holds.
      const stored = await db.engagement.getLeaderboard(period);
      expect((stored?.entries ?? stored ?? []).length).toBe(entries);
    }
  });

  it('refuses the rebuild without the maintenance area, and without a session', async () => {
    expect((await as(app, analyst).post('/leaderboard/rebuild').send({})).status).toBe(403);
    expect((await request(app).post('/leaderboard/rebuild').send({})).status).toBe(401);
  });

  // ── Edit an announcement ─────────────────────────────────────────────────
  const make = async () => (await as(app, editor).post('/admin/announcements')
    .send({ title: 'Original', body: 'first words', type: 'INFO' })).body.announcement;

  it('edits an announcement, records who did it, and leaves another alone', async () => {
    const mine = await make();
    const bystander = await make();
    const res = await as(app, editor).put(`/admin/announcements/${mine.announcementId}`)
      .send({ title: 'Edited', type: 'WARNING' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.announcement).toMatchObject({ title: 'Edited', kind: 'WARNING', body: 'first words' });

    const all = (await as(app, editor).get('/admin/announcements')).body.announcements;
    expect(all.find((a) => a.announcementId === bystander.announcementId).title).toBe('Original');

    const trail = await historyFor(mine.announcementId);
    expect(trail.some((h) => h.action === 'ANNOUNCEMENT_UPDATED' && (h.performed_by ?? h.performedBy) === editor.userId)).toBe(true);
  });

  it('refuses an unknown type with the reason, and changes nothing', async () => {
    const mine = await make();
    const res = await as(app, editor).put(`/admin/announcements/${mine.announcementId}`).send({ type: 'SHOUT' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/type/i);
    const all = (await as(app, editor).get('/admin/announcements')).body.announcements;
    expect(all.find((a) => a.announcementId === mine.announcementId).kind).toBe('INFO');
  });

  it('404s an id that does not exist, and refuses an account without the content area', async () => {
    expect((await as(app, editor).put('/admin/announcements/nope-123').send({ title: 'x' })).status).toBe(404);
    const mine = await make();
    expect((await as(app, maintainer).put(`/admin/announcements/${mine.announcementId}`).send({ title: 'x' })).status).toBe(403);
  });
});
