// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * startup/redisConnect.js — Redis connection, or an honest null.
 *
 * ── What this used to do, and what an operator saw ──────────────────────────
 * It fell back to a hardcoded `redis://localhost:6379` when `REDIS_URL` was
 * unset, so a deployment that does not use Redis at all still opened a client,
 * still failed, and — because the failed client was never disconnected — kept
 * RETRYING for the life of the process. Every attempt emitted an `error` event
 * with no listener, which ioredis reports as an unhandled error.
 *
 * The symptom is not a crash. It is a log filled with
 * `[ioredis] Unhandled error event: connect ECONNREFUSED 127.0.0.1:6379`,
 * forever, at whatever rate the retry strategy fires — which is precisely the
 * noise that hides a real error from the person reading the log. Measured on a
 * local boot: nine in the first twelve seconds, and climbing.
 *
 * The hardcoded address was also a §4 violation on its own: an operational
 * endpoint with no owner, which would have quietly connected a production
 * instance to whatever happened to be on its own localhost.
 *
 * ── What it does now ────────────────────────────────────────────────────────
 * No `REDIS_URL` means Redis is not configured, which is a supported way to run
 * this platform (`jobQueue.service.js` falls back to in-process timers, the
 * rate-limit store to memory, and the realtime bridge to single-instance). So
 * it says so once and returns null WITHOUT constructing a client.
 *
 * A configured Redis that will not connect is a different thing — worth a
 * warning — and the client is DISCONNECTED before returning, so a failed
 * startup connection does not leave a socket reconnecting behind it.
 *
 * The two sibling clients (`realtimeBridge.js`, `redisRateLimitStore.js`)
 * already checked `REDIS_URL` before constructing. This was the odd one out.
 */
import Redis from 'ioredis';

export async function connectRedis() {
  if (!String(process.env.REDIS_URL || '').trim()) {
    console.log('ℹ️  Redis not configured (no REDIS_URL) — in-memory fallbacks in use.');
    return null;
  }

  const redis = new Redis(process.env.REDIS_URL, {
    // ioredis 6 defaults to RESP3; pin RESP2 so the wire behaviour is byte-for-
    // byte identical to v5 across the whole app, BullMQ and the socket.io Redis
    // adapter (all validated on RESP2). The v6 upgrade is for Node-20+ support
    // and maintenance, NOT a protocol change — adopt RESP3 later, deliberately.
    protocol: 2,
    maxRetriesPerRequest: 3,
    enableReadyCheck:     true,
    lazyConnect:          true,
  });

  // Attached BEFORE connecting. Without a listener ioredis treats an `error`
  // event as unhandled, and an unhandled 'error' on an EventEmitter is a
  // process-level throw — so the catch below would not always be what caught it.
  redis.on('error', (e) => console.warn('⚠️  Redis error:', e.message));

  try {
    await redis.connect();
    console.log('✅ Redis Connected');
    return redis;
  } catch (error) {
    console.warn('⚠️  Redis unavailable — using in-memory fallback:', error.message);
    // Stop it reconnecting. A client left alive after a failed startup retries
    // for the life of the process, which is the log flood this file exists to
    // have stopped.
    redis.disconnect();
    return null;
  }
}
