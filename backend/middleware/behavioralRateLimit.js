// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** Sliding-window behavioral limiter keyed by authenticated session/device/account context. */
import { redisSlidingWindowAllow } from './redisRateLimitStore.js';

const buckets = new Map();
const MEMORY_BUCKET_MAX_ENTRIES = 10_000;
const MEMORY_BUCKET_MAX_TTL_MS = 60 * 60 * 1000;

function keyPart(value) {
  return String(value || '').trim().slice(0, 128) || 'unknown';
}

let nextMemorySweepAt = 0;
const MEMORY_SWEEP_INTERVAL_MS = 30_000;
const MEMORY_SWEEP_MAX_ENTRIES = 250;

function sweepExpiredBuckets(now, ttlMs) {
  if (now < nextMemorySweepAt) return;
  nextMemorySweepAt = now + MEMORY_SWEEP_INTERVAL_MS;
  let scanned = 0;
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastAccess >= ttlMs) buckets.delete(key);
    if (++scanned >= MEMORY_SWEEP_MAX_ENTRIES) break;
  }
}

function memoryAllow(k, { now, windowMs, max }) {
  const ttlMs = Math.min(windowMs, MEMORY_BUCKET_MAX_TTL_MS);
  sweepExpiredBuckets(now, ttlMs);

  const existing = buckets.get(k);
  if (existing) buckets.delete(k); // refresh this key's LRU recency on access
  const hits = (existing?.hits || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    buckets.set(k, { hits, lastAccess: now });
    return { allowed: false, retryAfter: Math.ceil((windowMs - (now - hits[0])) / 1000) };
  }
  while (buckets.size >= MEMORY_BUCKET_MAX_ENTRIES) {
    const oldestKey = buckets.keys().next().value;
    if (oldestKey === undefined) break;
    buckets.delete(oldestKey);
  }
  hits.push(now);
  buckets.set(k, { hits, lastAccess: now });
  return { allowed: true };
}

export function behavioralLimiter({ windowMs = 60_000, max = 30, action = 'action', keyPrefix = 'behavior' } = {}) {
  return async (req, res, next) => {
    const now = Date.now();
    const sessionId = keyPart(req.user?._id || req.userId || req.merchant?._id || req.merchantId);
    const deviceToken = keyPart(req.get('X-Device-Token') || req.get('X-Device-Fingerprint') || req.cookies?.device_token);
    const behavior = keyPart(req.get('X-Behavior-Cluster') || req.get('X-Device-Cluster'));
    const keys = [
      `${keyPrefix}:session:${sessionId}`,
      `${keyPrefix}:device:${deviceToken}`,
      `${keyPrefix}:behavior:${behavior}`,
      `${keyPrefix}:compound:${sessionId}:${deviceToken}:${behavior}`,
    ].filter((k) => !k.includes(':unknown'));

    for (const k of keys) {
      const redisDecision = await redisSlidingWindowAllow(`rl:${k}`, {
        now, windowMs, max, member: `${now}:${sessionId}:${deviceToken}:${Math.random()}`,
      });
      const decision = redisDecision ?? memoryAllow(k, { now, windowMs, max });
      if (!decision.allowed) {
        return res.status(429).json({
          success: false,
          message: `Too many ${action} attempts for this account/device velocity window.`,
          retryAfter: decision.retryAfter || Math.ceil(windowMs / 1000),
        });
      }
    }
    next();
  };
}

export const betBehaviorLimiter = behavioralLimiter({ action: 'bet placement', keyPrefix: 'bet', max: Number(process.env.BET_BEHAVIOR_MAX_PER_MINUTE || 30) });
