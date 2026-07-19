// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * startup/cronLock.js — leader election for scheduled jobs (Phase X fix X-4).
 *
 * WHY: cronJobs.js registers workers with bare setInterval. On more than one
 * backend instance EVERY instance runs EVERY job every tick — N× the DB work,
 * and safe only as long as each job happens to be idempotent. This wraps a
 * job body so at most ONE instance runs it per tick, via an atomic Mongo lock
 * with a TTL (so a crashed holder's lock frees itself within one interval).
 *
 * The lock is best-effort by design: if the DB is briefly unavailable the job
 * is skipped this tick (logged, never thrown) rather than blocking the loop —
 * the next tick retries. Idempotent jobs stay correct either way; this just
 * removes the duplicate work and the reliance on idempotency as the only guard.
 */
import mongoose from 'mongoose';
import crypto from 'crypto';

// One identity per process, so lock ownership is attributable in logs.
const INSTANCE_ID = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;

let CronLock;
function model() {
  if (CronLock) return CronLock;
  const schema = new mongoose.Schema({
    _id: String,               // job name
    holder: String,            // INSTANCE_ID that last held it
    expiresAt: { type: Date, index: true },
  }, { versionKey: false });
  CronLock = mongoose.models.CronLock || mongoose.model('CronLock', schema);
  return CronLock;
}

/**
 * acquire — atomically take the lock for `name` if it is free or expired.
 * Returns true if this instance now holds it, false otherwise.
 */
export async function acquire(name, ttlMs) {
  const Lock = model();
  const now = new Date();
  const expiresAt = new Date(Date.now() + ttlMs);
  try {
    // Take over an existing lock only if it has expired.
    const taken = await Lock.findOneAndUpdate(
      { _id: name, expiresAt: { $lte: now } },
      { $set: { holder: INSTANCE_ID, expiresAt } },
      { new: true }
    );
    if (taken) return true;
    // No expired doc matched — either it doesn't exist yet (create it) or a
    // live holder owns it (create throws duplicate-key → we lost).
    await Lock.create({ _id: name, holder: INSTANCE_ID, expiresAt });
    return true;
  } catch (err) {
    if (err?.code === 11000) return false; // a live holder owns it
    throw err;
  }
}

/** release — free the lock if (and only if) this instance still holds it. */
export async function release(name) {
  try {
    await model().updateOne(
      { _id: name, holder: INSTANCE_ID },
      { $set: { expiresAt: new Date(0) } } // epoch = immediately re-acquirable
    );
  } catch { /* best-effort — the TTL frees it regardless */ }
}

/**
 * withLeaderLock — run `fn` only if this instance wins the lock for `name`
 * this tick. ttlMs bounds how long a crashed holder can wedge the job
 * (default: the interval, so at most one tick is ever skipped). Never throws
 * into the caller — the interval loop must not die.
 */
export async function withLeaderLock(name, ttlMs, fn) {
  let held = false;
  try {
    held = await acquire(name, ttlMs);
  } catch (e) {
    console.warn(`[cron-lock] ${name}: acquire failed, skipping this tick:`, e.message);
    return;
  }
  if (!held) return; // another instance is running it this tick
  try {
    await fn();
  } finally {
    await release(name);
  }
}

export const _instanceId = INSTANCE_ID; // exported for tests/log attribution
