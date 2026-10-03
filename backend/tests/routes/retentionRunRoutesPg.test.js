// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * `POST /api/admin/operations/retention/run` — the Operations screen's
 * Maintenance section, through the real router and a real database.
 *
 * Route coverage (2026-10-01) listed it among the routes no client called: the
 * nightly job was the only thing that ever ran retention, and nobody could see
 * what it would take. The owner chose to wire it. Three things this file owns:
 *
 *   · the preview COUNTS and deletes nothing; the prune deletes exactly the old
 *     rows and never a young one (the 30-day floor is in the statement);
 *   · a failed run is a FAILURE. `runRetention` never throws (it runs from
 *     cron), so its failure is a value — and the route answered it
 *     `success: true`, which the screen would have shown as a prune that ran;
 *   · a prune, which deletes for good, is in the audit trail.
 *
 * Trap 10: retention deletes across the whole table, so every assertion is
 * about rows THIS file wrote, never a global count.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { historyFor } from '#db/repositories/audit.js';
import { mountRouter, actor, as } from './_harness.js';

const failNext = vi.hoisted(() => ({ value: false }));
vi.mock('../../domains/operations/retention.service.js', async (original) => {
  const real = await original();
  return {
    ...real,
    // The real service, except when a test asks for the failure it reports
    // as a value — the one way it fails, since it never throws.
    runRetention: async (opts) => {
      if (failNext.value) {
        failNext.value = false;
        return { cutoff: new Date(), dryRun: opts?.dryRun !== false, results: { error: 'relation is locked' }, totalDeleted: 0 };
      }
      return real.runRetention(opts);
    },
  };
});

const describePg = pgConfigured() ? describe : describe.skip;

describePg('the retention run route', () => {
  let app; let maintainer; let analyst;
  const RUN = `retention-suite-${Date.now().toString(36)}`;

  beforeAll(async () => {
    await applySchema();
    app = mountRouter((await import('../../domains/operations/operations.admin.routes.js')).default);
    maintainer = await actor({ isSubAdmin: true, permissions: { canRunMaintenance: true } });
    analyst = await actor({ isSubAdmin: true, permissions: { canViewAnalytics: true } });
  }, 60_000);

  afterAll(async () => {
    await pgQuery(`DELETE FROM frontend_error_reports WHERE message LIKE $1`, [`${RUN}%`]);
    await closePg();
  });

  /** Crash reports of this run: two far past any window, one from today. */
  const plant = async (tag) => {
    const { rows } = await pgQuery(
      `INSERT INTO frontend_error_reports (message, panel, created_at) VALUES
         ($1, 'admin', now() - interval '400 days'),
         ($2, 'admin', now() - interval '400 days'),
         ($3, 'admin', now())
       RETURNING id, message`,
      [`${RUN}-${tag}-old-1`, `${RUN}-${tag}-old-2`, `${RUN}-${tag}-young`],
    );
    return rows;
  };
  const surviving = async (tag) => (await pgQuery(
    `SELECT message FROM frontend_error_reports WHERE message LIKE $1 ORDER BY message`, [`${RUN}-${tag}-%`],
  )).rows.map((r) => r.message);

  it('previews: counts the old rows and deletes nothing', async () => {
    await plant('preview');
    const res = await as(app, maintainer).post('/operations/retention/run').send({ dryRun: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.results.frontendErrors).toBeGreaterThanOrEqual(2);
    expect(Object.keys(res.body.results).sort()).toEqual(['frontendErrors', 'notifications', 'referralClicks']);
    expect(await surviving('preview')).toHaveLength(3);
  });

  it('treats a request with no dryRun as a preview — a stray call deletes nothing', async () => {
    await plant('default');
    const res = await as(app, maintainer).post('/operations/retention/run').send({});
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(await surviving('default')).toHaveLength(3);
  });

  it('prunes the old rows, keeps the young one, and writes the audit row', async () => {
    await plant('prune');
    const res = await as(app, maintainer).post('/operations/retention/run').send({ dryRun: false });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.dryRun).toBe(false);
    expect(res.body.totalDeleted).toBeGreaterThanOrEqual(2);
    expect(await surviving('prune')).toEqual([`${RUN}-prune-young`]);

    const audit = (await historyFor('operational-data'))
      .filter((a) => a.action === 'RETENTION_RUN' && String(a.performedBy) === String(maintainer.userId));
    expect(audit).toHaveLength(1);
    expect(audit[0].details.totalDeleted).toBe(res.body.totalDeleted);
  });

  it('never deletes a row younger than 30 days, whatever window it is asked for', async () => {
    const { rows } = await pgQuery(
      `INSERT INTO frontend_error_reports (message, panel, created_at)
       VALUES ($1, 'admin', now() - interval '20 days') RETURNING id`, [`${RUN}-floor-20d`]);
    expect(rows).toHaveLength(1);
    const res = await as(app, maintainer).post('/operations/retention/run').send({ dryRun: false, months: 0 });
    expect(res.status).toBe(200);
    expect(await surviving('floor')).toEqual([`${RUN}-floor-20d`]);
  });

  it('answers a failed run as a failure, deletes nothing, and audits nothing', async () => {
    await plant('fail');
    const auditBefore = (await historyFor('operational-data')).length;
    failNext.value = true;
    const res = await as(app, maintainer).post('/operations/retention/run').send({ dryRun: false });
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    // Fixed wording: the database's own error text never reaches the caller.
    expect(res.body.message).toBe('Retention stopped before it finished. Run a preview to see what is left.');
    expect(JSON.stringify(res.body)).not.toContain('relation is locked');
    expect(await surviving('fail')).toHaveLength(3);
    expect((await historyFor('operational-data')).length).toBe(auditBefore);
  });

  it('refuses an account without the maintenance area, and deletes nothing', async () => {
    await plant('refused');
    const res = await as(app, analyst).post('/operations/retention/run').send({ dryRun: false });
    expect(res.status).toBe(403);
    expect(await surviving('refused')).toHaveLength(3);
  });
});
