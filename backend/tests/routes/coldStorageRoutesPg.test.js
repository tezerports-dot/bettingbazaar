// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Cold storage is a full admin's alone (owner, 2026-10-20): a sub-admin
 * holding every delegable area and a player are refused; a full admin lists
 * and opens entries, and every opening is audited. Real routers, real database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pgConfigured, pgQuery, applySchema, closePg } from '#db/client.js';
import { PERMISSION_KEYS } from '../../domains/identity/staffPermissions.js';
import { mountRouter, actor, as } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('GET /api/admin/cold-storage', () => {
  let app; let admin; let subAdmin; let player; let entryId; const ref = `u-cold-route-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../routes/admin/coldStorage.admin.routes.js')).default);
    admin = await actor({ isAdmin: true });
    subAdmin = await actor({ isSubAdmin: true, permissions: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, true])) });
    player = await actor({});
    const { rows } = await pgQuery(
      `INSERT INTO cold_archive (kind, ref, first_at, last_at, row_count, rows)
       VALUES ('NOTIFICATION', $1, now() - interval '40 days', now() - interval '40 days', 1,
               jsonb_build_array(jsonb_build_object('table', 'notifications', 'row', jsonb_build_object('title', 'kept cold'))))
       RETURNING id`, [ref]);
    entryId = Number(rows[0].id);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  it('refuses a sub-admin holding every area, and a player', async () => {
    for (const who of [subAdmin, player]) {
      expect((await as(app, who).get('/cold-storage')).status).toBe(403);
      expect((await as(app, who).get(`/cold-storage/${entryId}`)).status).toBe(403);
    }
  });

  it('lists entries without their rows, and opens one with them, audited', async () => {
    const list = await as(app, admin).get(`/cold-storage?kind=NOTIFICATION&ref=${ref}`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.entries).toHaveLength(1);
    expect(list.body.entries[0]).not.toHaveProperty('rows');
    const one = await as(app, admin).get(`/cold-storage/${entryId}`);
    expect(one.status).toBe(200);
    expect(one.body.entry.rows[0].row.title).toBe('kept cold');
    const { rows } = await pgQuery(
      `SELECT 1 FROM enhanced_audit_logs WHERE action = 'COLD_STORAGE_OPENED' AND target_id = $1`, [String(entryId)]);
    expect(rows.length).toBe(1);
  });

  it('answers 404 for no such entry and 400 for an unknown kind', async () => {
    expect((await as(app, admin).get('/cold-storage/999999999')).status).toBe(404);
    expect((await as(app, admin).get('/cold-storage?kind=BETS')).status).toBe(400);
  });
});
