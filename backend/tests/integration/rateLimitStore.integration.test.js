// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Integration test (real Redis, provided as a CI service container): F-3.
// THE property under test is horizontal scale — two store instances
// (simulating two backend nodes) must SHARE counters, which is exactly what
// the old MemoryStore could not do. Skipped when REDIS_URL is absent (the
// restricted sandbox); CI sets it.
import { describe, it, expect, beforeAll } from 'vitest';
import { RedisRateLimitStore, awaitRateLimitRedisReady } from '../../middleware/redisRateLimitStore.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const suite = process.env.REDIS_URL ? describe : describe.skip;

suite('RedisRateLimitStore (real Redis — cross-instance counters)', () => {
  beforeAll(async () => {
    // The store deliberately serves from memory while the client is still
    // connecting (requests must never wait on Redis) — for the shared-counter
    // assertions we need the Redis path deterministically active first.
    const ready = await awaitRateLimitRedisReady(10000);
    expect(ready).toBe(true);
  });

  it('two instances share one counter — the horizontal-scale property', async () => {
    const prefix = 'rl:it1:' + Math.random().toString(16).slice(2) + ':';
    const nodeA = new RedisRateLimitStore(prefix);
    const nodeB = new RedisRateLimitStore(prefix);
    nodeA.init({ windowMs: 60000 });
    nodeB.init({ windowMs: 60000 });

    expect((await nodeA.increment('9.9.9.9')).totalHits).toBe(1);
    expect((await nodeB.increment('9.9.9.9')).totalHits).toBe(2); // sees A's hit
    expect((await nodeA.increment('9.9.9.9')).totalHits).toBe(3); // sees B's hit

    // And the fallback memory maps stayed untouched — Redis really served it.
    expect(nodeA.memory.size).toBe(0);
    expect(nodeB.memory.size).toBe(0);
  });

  it('windows expire in Redis (PEXPIRE set atomically with the first hit)', async () => {
    const prefix = 'rl:it2:' + Math.random().toString(16).slice(2) + ':';
    const store = new RedisRateLimitStore(prefix);
    store.init({ windowMs: 300 });

    expect((await store.increment('k')).totalHits).toBe(1);
    expect((await store.increment('k')).totalHits).toBe(2);
    await sleep(400);
    expect((await store.increment('k')).totalHits).toBe(1); // fresh window
  });

  it('prefixes isolate limiters; resetKey clears one key only', async () => {
    const p = Math.random().toString(16).slice(2);
    const auth = new RedisRateLimitStore(`rl:it3a:${p}:`);
    const bets = new RedisRateLimitStore(`rl:it3b:${p}:`);
    auth.init({ windowMs: 60000 });
    bets.init({ windowMs: 60000 });

    await auth.increment('u1');
    await auth.increment('u1');
    expect((await bets.increment('u1')).totalHits).toBe(1); // isolated

    await auth.resetKey('u1');
    expect((await auth.increment('u1')).totalHits).toBe(1); // cleared
    expect((await bets.increment('u1')).totalHits).toBe(2); // untouched
  });
});
