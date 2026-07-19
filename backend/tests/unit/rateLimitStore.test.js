// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the F-3 rate-limit store's in-process fallback path (the
// behavior every dev/CI environment without REDIS_URL gets, and the runtime
// degradation mode when Redis drops). The Redis-shared path is proven in
// rateLimitStore.integration.test.js against a real Redis in CI.
import { describe, it, expect } from 'vitest';
import { RedisRateLimitStore } from '../../middleware/redisRateLimitStore.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('RedisRateLimitStore memory fallback', () => {
  it('counts hits within a window', () => {
    const store = new RedisRateLimitStore('rl:test:');
    store.init({ windowMs: 60000 });
    expect(store.memoryIncrement('1.2.3.4').totalHits).toBe(1);
    expect(store.memoryIncrement('1.2.3.4').totalHits).toBe(2);
    expect(store.memoryIncrement('1.2.3.4').totalHits).toBe(3);
    // Different key counts independently
    expect(store.memoryIncrement('5.6.7.8').totalHits).toBe(1);
  });

  it('resets after the window expires', async () => {
    const store = new RedisRateLimitStore('rl:test:');
    store.init({ windowMs: 40 });
    expect(store.memoryIncrement('k').totalHits).toBe(1);
    expect(store.memoryIncrement('k').totalHits).toBe(2);
    await sleep(60);
    expect(store.memoryIncrement('k').totalHits).toBe(1); // fresh window
  });

  it('provides a resetTime inside the window', () => {
    const store = new RedisRateLimitStore('rl:test:');
    store.init({ windowMs: 60000 });
    const { resetTime } = store.memoryIncrement('k');
    const delta = resetTime.getTime() - Date.now();
    expect(delta).toBeGreaterThan(55000);
    expect(delta).toBeLessThanOrEqual(60000);
  });

  it('increment() itself falls back to memory when no Redis is configured', async () => {
    // In this sandbox/CI-unit environment REDIS_URL is unset, so the public
    // API must transparently use the in-process counter.
    if (process.env.REDIS_URL) return; // covered by the integration test then
    const store = new RedisRateLimitStore('rl:test:');
    store.init({ windowMs: 60000 });
    expect((await store.increment('k')).totalHits).toBe(1);
    expect((await store.increment('k')).totalHits).toBe(2);
    await store.decrement('k');
    expect((await store.increment('k')).totalHits).toBe(2); // 2−1+1
    await store.resetKey('k');
    expect((await store.increment('k')).totalHits).toBe(1);
  });
});
