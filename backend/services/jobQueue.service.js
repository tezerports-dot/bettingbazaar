// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * services/jobQueue.service.js — Background Job Platform (plan items 17 + 56,
 * one build per the plan). 2026-07-13.
 *
 * BullMQ (Redis-backed — matches the existing Redis infrastructure) gives every
 * scheduled job: retries with exponential backoff, persistence across restarts,
 * single-execution semantics across instances, and inspectable job state.
 *
 * GRACEFUL DEGRADATION (same philosophy as rate limiting / the SSE bridge):
 * without REDIS_URL, registerRecurring falls back to the EXACT pre-existing
 * pattern — setInterval + withLeaderLock — so a Redis-less deploy behaves
 * precisely as before this platform existed. With Redis, jobs run as BullMQ
 * repeatables; the processor still wraps withLeaderLock as defense-in-depth
 * (harmless: every job is already idempotent by design).
 *
 * Money-path note: this platform does not change WHAT jobs do — settlement,
 * reconciliation etc. keep their own idempotency guarantees (unique txIds,
 * status guards) that CI proves; the queue only changes WHEN/HOW they fire.
 */
import { withLeaderLock } from '../startup/cronLock.js';

const QUEUE_NAME = 'bb-jobs';
const processors = new Map();   // job name -> async fn
const intervals  = [];          // fallback timers (for shutdown)
let queue = null, worker = null, connection = null;

function redisConfigured() { return !!process.env.REDIS_URL; }

async function ensureQueue() {
  if (queue) return queue;
  const [{ Queue, Worker }, { default: IORedis }] = await Promise.all([
    import('bullmq'), import('ioredis'),
  ]);
  // BullMQ requires maxRetriesPerRequest: null on its blocking connections.
  connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
  connection.on('error', (e) => console.warn('[jobQueue] redis error:', e.message));
  queue = new Queue(QUEUE_NAME, { connection });
  worker = new Worker(QUEUE_NAME, async (job) => {
    const fn = processors.get(job.name);
    if (!fn) { console.warn(`[jobQueue] no processor for '${job.name}' — skipped`); return; }
    // Leader lock kept as belt-and-braces; TTL = the job's own interval or 60s.
    const ttl = job.data?.__ttlMs || 60 * 1000;
    await withLeaderLock(job.name, ttl, fn);
  }, { connection, concurrency: 1 });

  worker.on('failed', async (job, err) => {
    console.error(`[jobQueue] '${job?.name}' failed (attempt ${job?.attemptsMade}):`, err.message);
    // Page a human only when retries are exhausted (final failure).
    if (job && job.attemptsMade >= (job.opts?.attempts || 1)) {
      try {
        const { sendAlert } = await import('./alerting.service.js');
        sendAlert(`job-${job.name}`, `Background job '${job.name}' failed after ${job.attemptsMade} attempts`, { error: err.message });
      } catch { /* alerting optional */ }
    }
  });
  console.log('✅ Job platform: BullMQ active (Redis-backed, retries enabled)');
  return queue;
}

/**
 * registerRecurring — THE way scheduled jobs are declared (cronJobs.js uses
 * this for every job). Redis present → BullMQ repeatable (retry 3×,
 * exponential backoff from 30s, history capped). Redis absent → identical
 * behavior to the historical setInterval + withLeaderLock cron.
 */
export async function registerRecurring(name, everyMs, fn) {
  processors.set(name, fn);
  if (redisConfigured()) {
    try {
      const q = await ensureQueue();
      await q.add(name, { __ttlMs: everyMs }, {
        repeat: { every: everyMs },
        jobId: `recurring:${name}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 30 * 1000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      });
      return;
    } catch (e) {
      console.warn(`[jobQueue] BullMQ unavailable for '${name}' (${e.message}) — falling back to interval cron`);
    }
  }
  const t = setInterval(() => withLeaderLock(name, everyMs, fn), everyMs);
  if (t.unref) t.unref();
  intervals.push(t);
}

/**
 * enqueue — one-off job with retries (future producers: notification fan-out,
 * report generation). Without Redis it executes inline on the next tick —
 * best-effort, no retry (documented degradation).
 */
export async function enqueue(name, data = {}, opts = {}) {
  if (redisConfigured()) {
    try {
      const q = await ensureQueue();
      return await q.add(name, data, { attempts: 3, backoff: { type: 'exponential', delay: 10 * 1000 }, removeOnComplete: 200, ...opts });
    } catch (e) {
      console.warn(`[jobQueue] enqueue '${name}' fell back inline:`, e.message);
    }
  }
  const fn = processors.get(name);
  if (fn) setImmediate(() => fn(data).catch(err => console.error(`[jobQueue] inline '${name}' failed:`, err.message)));
  return null;
}

/** Register a processor for one-off jobs (recurring jobs register via registerRecurring). */
export function registerProcessor(name, fn) { processors.set(name, fn); }

/** Graceful shutdown — server.js calls this on SIGTERM/SIGINT. */
export async function closeJobQueue() {
  intervals.forEach(clearInterval);
  try { await worker?.close(); await queue?.close(); await connection?.quit(); } catch { /* closing */ }
}
