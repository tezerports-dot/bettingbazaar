// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The commission engine's run lock, through a real database.
 *
 * It is a SESSION advisory lock on a dedicated pooled connection. If the unlock
 * failed, the connection went back to the pool still holding the lock — and
 * every later pass, on any connection but that one, was told "another pass is
 * running" until the connection happened to be recycled (verification of PR
 * #198, §7). Commission would silently stop being paid.
 *
 * The fix destroys the connection whenever the unlock is not CONFIRMED, which
 * ends the session and so the lock with it. These tests read the lock from a
 * separate session, because the pooled one would take it again re-entrantly
 * and see nothing wrong.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { pgConfigured, applySchema, closePg, resolvePgSsl } from '#db/client.js';
import { withCommissionRunLock } from '#db/repositories/ledger.core.js';

const describePg = pgConfigured() ? describe : describe.skip;
const COMMISSION_RUN_LOCK = 734_120_915;

describePg('the commission run lock', () => {
  let probe;

  /** Can a DIFFERENT session take the lock right now? It gives it straight back. */
  const freeElsewhere = async () => {
    const { rows } = await probe.query('SELECT pg_try_advisory_lock($1) AS got', [COMMISSION_RUN_LOCK]);
    if (rows[0].got) await probe.query('SELECT pg_advisory_unlock($1)', [COMMISSION_RUN_LOCK]);
    return rows[0].got;
  };
  const eventuallyFree = async () => {
    for (let i = 0; i < 40; i += 1) {
      if (await freeElsewhere()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };

  beforeAll(async () => {
    await applySchema();
    probe = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: resolvePgSsl() });
    await probe.connect();
  });

  afterAll(async () => {
    await probe.end();
    await closePg();
  });

  it('lets one pass run at a time, and frees the lock when it ends', async () => {
    let release;
    const holding = new Promise((r) => { release = r; });
    const first = withCommissionRunLock(() => holding);
    await new Promise((r) => setTimeout(r, 100));
    expect(await withCommissionRunLock(async () => 'second')).toEqual({ locked: false });
    expect(await freeElsewhere()).toBe(false);
    release('done');
    expect(await first).toEqual({ locked: true, value: 'done' });
    expect(await eventuallyFree()).toBe(true);
  });

  it('frees the lock when the pass THROWS (the opposite of a clean end)', async () => {
    await expect(withCommissionRunLock(async () => { throw new Error('pass failed'); })).rejects.toThrow('pass failed');
    expect(await eventuallyFree()).toBe(true);
  });

  it('frees the lock even when the UNLOCK fails, instead of parking it in the pool', async () => {
    const original = pg.Client.prototype.query;
    let failed = false;
    const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (text, ...rest) {
      if (!failed && typeof text === 'string' && text.includes('pg_advisory_unlock')) {
        failed = true;
        return Promise.reject(new Error('connection hiccup during unlock'));
      }
      return original.call(this, text, ...rest);
    });
    try {
      const res = await withCommissionRunLock(async () => 'paid');
      expect(res).toEqual({ locked: true, value: 'paid' });
      expect(failed).toBe(true);
    } finally {
      spy.mockRestore();
    }
    // Another session can take it: the next pass is not refused forever.
    expect(await eventuallyFree()).toBe(true);
    expect(await withCommissionRunLock(async () => 'next')).toEqual({ locked: true, value: 'next' });
  });
});
