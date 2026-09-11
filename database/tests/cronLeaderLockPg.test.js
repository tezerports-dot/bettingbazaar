// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * One instance runs a scheduled job per tick. Not two, and not "eventually one".
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The lock was rewritten onto PostgreSQL and its concurrency test was never
 * restored — the registry entry promised it and nothing wrote it. So the thing
 * standing between settlement and running N times per tick on N instances has
 * been untested since the rewrite.
 *
 * ── The failure this is really about ────────────────────────────────────────
 * A MUTEX is not a leader election, and the difference is invisible to a naive
 * test. Three instances waking on the same tick and taking a released lock one
 * after another satisfy "never simultaneously" perfectly — and the job runs
 * three times, sequentially. That is the exact duplicate work the lock exists
 * to remove. `holdLease: true` is what makes it an election, and the test for
 * it has to count RUNS across a tick, not observe overlap.
 *
 * ── Why against a real database ─────────────────────────────────────────────
 * The whole guarantee is one atomic INSERT … ON CONFLICT … WHERE. A stub with a
 * Map would agree with every assertion here and prove nothing about whether two
 * connections racing that statement can both win.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import {
  acquireLock, renewLock, releaseLock, listLocks, withLock,
} from '../repositories/operations.js';

/**
 * Age a lock into the past the way time does: BOTH timestamps move.
 *
 * Pushing `expires_at` back on its own is refused by
 * `cron_locks_expires_after_acquire` — correctly, because a lock that expired
 * before it was taken is not a state the system can reach. The constraint is
 * the reason this helper exists rather than a bare UPDATE.
 */
const expire = (jobName) => pgQuery(
  `UPDATE cron_locks
      SET acquired_at = now() - interval '2 hours',
          expires_at  = now() - interval '1 hour'
    WHERE job_name = $1`, [jobName]);

const describePg = pgConfigured() ? describe : describe.skip;

describePg('cron leader lock', () => {
  const RUN = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  const job = (label) => `test:${label}:${RUN}:${seq += 1}`;

  beforeAll(async () => { await applySchema(); }, 60_000);
  afterAll(async () => {
    await pgQuery('DELETE FROM cron_locks WHERE job_name LIKE $1', [`test:%:${RUN}:%`]);
    await closePg();
  });

  it('gives the lock to exactly one of many simultaneous claimants', async () => {
    // The single-statement claim is the whole guarantee. A read-then-write
    // would let every one of these see a free lock and all ten would win.
    const name = job('race');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => acquireLock(name, `inst-${i}`, { ttlSeconds: 60 })),
    );
    expect(results.filter((r) => r.acquired)).toHaveLength(1);
  });

  it('refuses a second holder while the lease is alive', async () => {
    const name = job('held');
    expect((await acquireLock(name, 'A', { ttlSeconds: 60 })).acquired).toBe(true);
    expect((await acquireLock(name, 'B', { ttlSeconds: 60 })).acquired).toBe(false);
  });

  it('lets the holder re-acquire, so a slow job cannot lock itself out', async () => {
    const name = job('reentrant');
    const first = await acquireLock(name, 'A', { ttlSeconds: 60 });
    const again = await acquireLock(name, 'A', { ttlSeconds: 120 });
    expect(again.acquired).toBe(true);
    // And it EXTENDS rather than merely succeeding.
    expect(new Date(again.expiresAt).getTime()).toBeGreaterThan(new Date(first.expiresAt).getTime());
  });

  it('hands the lock on once the lease has lapsed', async () => {
    // A crashed leader must not wedge the job forever. Expiry is what bounds it.
    const name = job('lapsed');
    expect((await acquireLock(name, 'DEAD', { ttlSeconds: 1 })).acquired).toBe(true);
    await expire(name);
    expect((await acquireLock(name, 'ALIVE', { ttlSeconds: 60 })).acquired).toBe(true);
    expect((await listLocks()).find((l) => l.jobName === name).holder).toBe('ALIVE');
  });

  it('will not let a non-holder renew or release', async () => {
    // Otherwise an instance whose lease lapsed mid-run could extend or drop a
    // lock the new leader is relying on.
    const name = job('guarded');
    await acquireLock(name, 'A', { ttlSeconds: 60 });
    expect(await renewLock(name, 'B', { ttlSeconds: 60 })).toBe(false);
    expect(await releaseLock(name, 'B')).toBe(false);
    expect(await releaseLock(name, 'A')).toBe(true);
  });

  it('will not renew a lease that has already lapsed', async () => {
    // Renewing an expired lock would resurrect a holder somebody may already
    // have replaced.
    const name = job('stale-renew');
    await acquireLock(name, 'A', { ttlSeconds: 60 });
    await expire(name);
    expect(await renewLock(name, 'A', { ttlSeconds: 60 })).toBe(false);
  });

  // ── The one that distinguishes a leader election from a mutex ─────────────
  it('runs a held-lease job ONCE across a tick, however many instances wake', async () => {
    const name = job('tick');
    let runs = 0;
    const tick = () => withLock(name, `inst-${Math.random()}`, async () => { runs += 1; },
      { ttlSeconds: 60, holdLease: true });

    // Simultaneous — the race — and then sequential, which is the case a mutex
    // passes and a leader election must not: three instances taking a released
    // lock one after another would run the job three times.
    await Promise.all([tick(), tick(), tick()]);
    await tick();
    await tick();

    expect(runs).toBe(1);
  });

  it('releases on completion when the lease is not held', async () => {
    // The mutex mode is still available for work that genuinely wants it.
    const name = job('mutex');
    const holder = 'inst-1';
    const outcome = await withLock(name, holder, async () => 'done', { ttlSeconds: 60 });
    expect(outcome).toMatchObject({ ran: true, result: 'done' });
    expect((await listLocks()).some((l) => l.jobName === name)).toBe(false);
  });

  it('frees the lock when the job throws, so the next tick retries', async () => {
    // Holding a lease for work that FAILED would skip the retry as well as the
    // duplicate — a settlement pass that errored would simply not run again.
    const name = job('threw');
    await expect(withLock(name, 'inst-1', async () => { throw new Error('boom'); },
      { ttlSeconds: 60, holdLease: true })).rejects.toThrow('boom');

    expect((await listLocks()).some((l) => l.jobName === name)).toBe(false);
    expect((await acquireLock(name, 'inst-2', { ttlSeconds: 60 })).acquired).toBe(true);
  });

  it('tells a caller it was not the leader instead of throwing', async () => {
    // The interval loop must not die because another instance won.
    const name = job('follower');
    await acquireLock(name, 'LEADER', { ttlSeconds: 60 });
    let ran = false;
    const outcome = await withLock(name, 'FOLLOWER', async () => { ran = true; }, { ttlSeconds: 60 });
    expect(outcome).toEqual({ ran: false, reason: 'NOT_LEADER' });
    expect(ran).toBe(false);
  });

  it('refuses a claim with no job name or no holder', async () => {
    // A blank holder would make every instance look like the same one.
    await expect(acquireLock('', 'A')).rejects.toThrow(/jobName and a holder/);
    await expect(acquireLock(job('nameless'), '')).rejects.toThrow(/jobName and a holder/);
  });

  it('reports an expired lock as expired, for an operator asking why', async () => {
    const name = job('listing');
    await acquireLock(name, 'A', { ttlSeconds: 60 });
    expect((await listLocks()).find((l) => l.jobName === name).expired).toBe(false);
    await expire(name);
    expect((await listLocks()).find((l) => l.jobName === name).expired).toBe(true);
  });
});
