// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Integration test (real DB): the cron leader lock (Phase X fix X-4). Proves
// the property that matters for horizontal scale — under concurrent acquire
// attempts (simulating N replicas hitting the same tick) at most ONE wins,
// and an expired lock becomes re-acquirable.
import { describe, it, expect } from 'vitest';
import { acquire, release, withLeaderLock } from '../../startup/cronLock.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('cron leader lock (X-4)', () => {
  it('only one of many concurrent acquirers wins the same tick', async () => {
    const name = 'test-job-' + Math.random().toString(16).slice(2);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => acquire(name, 60000))
    );
    expect(results.filter(Boolean).length).toBe(1); // exactly one leader
    await release(name);
  });

  it('a released lock is immediately re-acquirable', async () => {
    const name = 'test-job-' + Math.random().toString(16).slice(2);
    expect(await acquire(name, 60000)).toBe(true);
    // Held → a second acquire loses.
    expect(await acquire(name, 60000)).toBe(false);
    await release(name);
    // Released → acquirable again.
    expect(await acquire(name, 60000)).toBe(true);
    await release(name);
  });

  it('an expired lock is taken over (crashed-holder recovery)', async () => {
    const name = 'test-job-' + Math.random().toString(16).slice(2);
    expect(await acquire(name, 40)).toBe(true); // short TTL, not released
    expect(await acquire(name, 40)).toBe(false); // still held
    await sleep(60);                              // TTL lapses
    expect(await acquire(name, 60000)).toBe(true); // taken over
    await release(name);
  });

  it('withLeaderLock runs the body once across concurrent callers, then frees', async () => {
    const name = 'test-job-' + Math.random().toString(16).slice(2);
    let runs = 0;
    await Promise.all(Array.from({ length: 5 }, () =>
      withLeaderLock(name, 60000, async () => { runs += 1; await sleep(10); })
    ));
    expect(runs).toBe(1);                         // only the leader ran
    // Body finished → lock released → a later tick can run again.
    await withLeaderLock(name, 60000, async () => { runs += 1; });
    expect(runs).toBe(2);
  });
});
