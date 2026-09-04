// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * startup/cronLock.js — leader election for scheduled jobs.
 *
 * cronJobs.js registers workers with bare `setInterval`. On more than one
 * backend instance EVERY instance runs EVERY job every tick — N× the database
 * work, and safe only as long as each job happens to be idempotent. This wraps
 * a job body so at most ONE instance runs it per tick.
 *
 * ── What the PostgreSQL lock does that the previous one could not ──────────
 * The lease is RENEWED while the job runs. The version this replaces set a TTL
 * once at acquisition and never touched it again, so a job that legitimately
 * took longer than its TTL had its lock expire underneath it — and the next
 * tick started a SECOND copy of a job that was still running. That is the exact
 * duplicate-work failure the lock exists to prevent, arriving specifically on
 * the slow runs where it costs most.
 *
 * A heartbeat extends the lease at a third of the TTL, guarded on the holder,
 * so an instance cannot extend a lock somebody else has already taken over.
 *
 * ── Best-effort by design ──────────────────────────────────────────────────
 * If the database is briefly unavailable the job is SKIPPED this tick (logged,
 * never thrown) rather than blocking the loop; the next tick retries. Failing
 * open — running everywhere when the lock is unreadable — would turn a database
 * blip into every instance doing every job at once, which is worse than a
 * missed tick.
 */
import crypto from 'crypto';
import { db } from '#db';

/**
 * One identity per PROCESS, so lock ownership is attributable in logs and a
 * restarted instance cannot accidentally renew the lease its previous life
 * held. The pid alone is not enough: pids are reused.
 */
const INSTANCE_ID = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

/**
 * Take the lock for `name` if it is free, expired, or already ours.
 *
 * "Already ours" is deliberate: an instance re-acquiring its own lock extends
 * it rather than being refused, so a job whose previous run released late does
 * not lock itself out.
 */
export async function acquire(name, ttlMs) {
  const { acquired } = await db.operations.acquireLock(name, INSTANCE_ID, {
    ttlSeconds: Math.max(Math.ceil(ttlMs / 1000), 1),
  });
  return acquired;
}

/** Free the lock, if and only if this instance still holds it. */
export async function release(name) {
  try {
    await db.operations.releaseLock(name, INSTANCE_ID);
  } catch { /* best-effort — the lease frees it regardless */ }
}

/**
 * Run `fn` only if this instance wins the lock for `name` this tick.
 *
 * `ttlMs` bounds how long a crashed holder can wedge the job. It is a floor,
 * not a ceiling: the lease is renewed while `fn` runs, so a slow job keeps its
 * lock instead of having it stolen mid-run.
 *
 * Never throws into the caller — the interval loop must not die.
 */
export async function withLeaderLock(name, ttlMs, fn) {
  try {
    const outcome = await db.operations.withLock(name, INSTANCE_ID, fn, {
      ttlSeconds: Math.max(Math.ceil(ttlMs / 1000), 1),
      // LEADER ELECTION, not mutual exclusion. Releasing on completion makes
      // three instances waking on the same tick take the lock one after another
      // and run the job three times, sequentially — every instance doing every
      // job, which is the duplicate work this exists to remove. The lease is
      // held for the rest of the tick so there is exactly one leader.
      holdLease: true,
    });
    return outcome.ran;
  } catch (e) {
    // Covers both a lock the database could not answer for and a job body that
    // threw. Either way the next tick retries; a thrown error here would take
    // the whole interval down and stop every job on this instance.
    console.warn(`[cron-lock] ${name}: skipped this tick — ${e.message}`);
    return false;
  }
}

/** Who holds what, for an operator asking why a job is not running. */
export function listLocks() {
  return db.operations.listLocks();
}

export const _instanceId = INSTANCE_ID; // exported for tests/log attribution
