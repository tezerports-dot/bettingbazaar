// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Redis-backed store for express-rate-limit (F-3, 2026-07-10).
 *
 * WHY: the default MemoryStore keeps counters per process, so the moment the
 * backend runs more than one instance every limit is effectively N× looser
 * and brute-force protection collapses. This store keeps counters in Redis
 * (already provisioned on Railway), shared across all instances.
 *
 * DEGRADATION CONTRACT (mirrors cache.service.js philosophy):
 *   - REDIS_URL unset (dev, CI unit tests, sandbox): pure in-process
 *     counters — identical behavior to the old MemoryStore, no connection
 *     attempts, no noise.
 *   - REDIS_URL set but Redis unreachable mid-flight: fall back to the
 *     in-process counter for that window and keep serving requests. Rate
 *     limiting degrades to per-instance rather than failing requests open
 *     or closed.
 *
 * Counting is atomic via a single Lua script (INCR + ensure PEXPIRE), the
 * same pattern rate-limit-redis uses — no INCR/EXPIRE race, self-healing
 * TTL if a prior process died between the two calls.
 */
import Redis from 'ioredis';

const LUA_INCR = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {hits, ttl}
`;


const LUA_SLIDING_WINDOW = `
local window_start = tonumber(ARGV[1]) - tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', window_start)
local current_requests = redis.call('ZCARD', KEYS[1])
if current_requests < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4] or ARGV[1])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return {1, current_requests + 1}
else
  return {0, current_requests}
end
`;

let sharedClient = null;
let loggedDown = false;

function getClient() {
  if (!process.env.REDIS_URL) return null;
  if (sharedClient) return sharedClient;
  sharedClient = new Redis(process.env.REDIS_URL, {
    // Separate connection from the cache client on purpose: a slow cache
    // pipeline must never delay auth/bet rate decisions, and vice versa.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false, // fail fast to the memory fallback when down
    retryStrategy: (times) => Math.min(times * 200, 5000), // keep reconnecting forever
  });
  sharedClient.defineCommand('rlIncr', { numberOfKeys: 1, lua: LUA_INCR });
  sharedClient.defineCommand('rlSlidingWindow', { numberOfKeys: 1, lua: LUA_SLIDING_WINDOW });
  sharedClient.on('ready', () => {
    loggedDown = false;
    console.log('✅ Rate-limit Redis store connected (shared counters across instances)');
  });
  sharedClient.on('error', (err) => {
    if (!loggedDown) {
      loggedDown = true;
      console.warn('⚠️  Rate-limit Redis store unavailable — per-instance fallback active:', err.message);
    }
  });
  return sharedClient;
}

export class RedisRateLimitStore {
  /**
   * @param {string} prefix Redis key prefix, one per limiter (e.g. 'rl:auth:')
   */
  constructor(prefix) {
    this.prefix = prefix;
    this.windowMs = 60000; // overwritten by init()
    this.memory = new Map(); // fallback counters: key -> { count, resetAt }
    // Counters live in Redis, shared across instances — tells
    // express-rate-limit not to assume process-local keys.
    this.localKeys = false;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  key(k) {
    return `${this.prefix}${k}`;
  }

  memorySweep() {
    if (this.memory.size < 10000) return;
    const now = Date.now();
    for (const [k, v] of this.memory) {
      if (v.resetAt <= now) this.memory.delete(k);
    }
  }

  memoryIncrement(k) {
    const now = Date.now();
    const entry = this.memory.get(k);
    if (!entry || entry.resetAt <= now) {
      this.memorySweep();
      const fresh = { count: 1, resetAt: now + this.windowMs };
      this.memory.set(k, fresh);
      return { totalHits: 1, resetTime: new Date(fresh.resetAt) };
    }
    entry.count += 1;
    return { totalHits: entry.count, resetTime: new Date(entry.resetAt) };
  }

  async increment(k) {
    const client = getClient();
    if (client && client.status === 'ready') {
      try {
        const [hits, ttl] = await client.rlIncr(this.key(k), this.windowMs);
        return { totalHits: hits, resetTime: new Date(Date.now() + ttl) };
      } catch { /* degrade to per-instance counting */ }
    }
    return this.memoryIncrement(k);
  }

  async decrement(k) {
    const client = getClient();
    if (client && client.status === 'ready') {
      try {
        await client.decr(this.key(k));
        return;
      } catch { /* degrade */ }
    }
    const entry = this.memory.get(k);
    if (entry && entry.count > 0) entry.count -= 1;
  }

  async resetKey(k) {
    const client = getClient();
    if (client && client.status === 'ready') {
      try {
        await client.del(this.key(k));
        return;
      } catch { /* degrade */ }
    }
    this.memory.delete(k);
  }
}

/** One store per limiter — prefixes keep windows/counters isolated. */
export function createRateLimitStore(prefix) {
  return new RedisRateLimitStore(prefix);
}

/**
 * awaitRateLimitRedisReady — resolve true once the shared client is ready
 * (or immediately false when REDIS_URL is unset). The store itself never
 * blocks a request on this — it falls back to memory while connecting; this
 * exists for tests and optional startup warmup that want the Redis path
 * deterministically active before proceeding.
 */
export function awaitRateLimitRedisReady(timeoutMs = 5000) {
  const client = getClient();
  if (!client) return Promise.resolve(false);
  if (client.status === 'ready') return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(client.status === 'ready'), timeoutMs);
    client.once('ready', () => { clearTimeout(timer); resolve(true); });
  });
}


/**
 * Atomic Redis sliding-window log limiter for compound non-IP identifiers.
 * Returns null when Redis is unavailable so callers can apply their memory
 * fallback without turning Redis outages into production request failures.
 */
export async function redisSlidingWindowAllow(key, { windowMs, max, now = Date.now(), member } = {}) {
  const client = getClient();
  if (!client || client.status !== 'ready') return null;
  try {
    const [allowed, count] = await client.rlSlidingWindow(key, now, windowMs, max, member || `${now}:${Math.random()}`);
    return { allowed: Number(allowed) === 1, count: Number(count) };
  } catch {
    return null;
  }
}
