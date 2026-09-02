// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * repositories/operations.js — the scheduled-job leader lock, and counters.
 *
 * ── Why the lock changed shape ──────────────────────────────────────────────
 * The document version relied on a TTL index to expire an abandoned lock. A TTL
 * index sweeps on ITS OWN SCHEDULE — up to a minute late, longer under load —
 * so a crashed leader's lock lingered and every instance skipped its jobs until
 * the sweep happened to run. Nothing reported it: each instance saw "someone
 * else holds the lock" and went back to sleep.
 *
 * PostgreSQL has no TTL index, and that is the better answer. The expiry is in
 * the WHERE clause of the claim itself, so an abandoned lock is claimable the
 * INSTANT it lapses, by whichever instance asks first.
 */
import { pgQuery } from '../client.js';

/**
 * Try to become the leader for a job.
 *
 * One statement. The insert, the "is the current holder's lease dead?" test and
 * the takeover are the same atomic operation — a read-then-write would let two
 * instances both see a lapsed lock and both claim it, which is the exact thing
 * a leader lock exists to prevent.
 *
 * Re-entrant for the SAME holder: an instance that already leads simply extends
 * its lease, so a job that runs longer than one tick does not lose the lock to
 * itself.
 */
export async function acquireLock(jobName, holder, { ttlSeconds = 300 } = {}) {
  if (!jobName || !holder) throw new Error('acquireLock requires a jobName and a holder');
  const { rows } = await pgQuery(
    `INSERT INTO cron_locks (job_name, holder, acquired_at, expires_at)
     VALUES ($1, $2, now(), now() + ($3 || ' seconds')::interval)
     ON CONFLICT (job_name) DO UPDATE
       SET holder = EXCLUDED.holder,
           acquired_at = now(),
           expires_at = EXCLUDED.expires_at
       WHERE cron_locks.expires_at <= now()      -- the previous leader is gone
          OR cron_locks.holder = EXCLUDED.holder -- or it is us, extending
     RETURNING holder, expires_at`,
    [String(jobName), String(holder), String(Math.max(Number(ttlSeconds) || 300, 1))],
    'cron_lock_acquire',
  );
  return rows[0]
    ? { acquired: true, holder: rows[0].holder, expiresAt: rows[0].expires_at }
    : { acquired: false };
}

/**
 * Extend the lease while a job is still running.
 *
 * Guarded on the holder, so an instance cannot extend a lock another instance
 * has already taken over — which is what would happen if a long GC pause let
 * the lease lapse and someone else claimed it mid-run.
 */
export async function renewLock(jobName, holder, { ttlSeconds = 300 } = {}) {
  const { rows } = await pgQuery(
    `UPDATE cron_locks SET expires_at = now() + ($3 || ' seconds')::interval
      WHERE job_name = $1 AND holder = $2 AND expires_at > now()
      RETURNING expires_at`,
    [String(jobName), String(holder), String(Math.max(Number(ttlSeconds) || 300, 1))],
    'cron_lock_renew',
  );
  return rows.length > 0;
}

/** Release the lock. Guarded on the holder, for the same reason as renew. */
export async function releaseLock(jobName, holder) {
  const { rows } = await pgQuery(
    'DELETE FROM cron_locks WHERE job_name = $1 AND holder = $2 RETURNING job_name',
    [String(jobName), String(holder)], 'cron_lock_release',
  );
  return rows.length > 0;
}

/** Who holds what, for an operator asking why a job is not running. */
export async function listLocks() {
  const { rows } = await pgQuery(
    `SELECT job_name, holder, acquired_at, expires_at, expires_at <= now() AS expired
       FROM cron_locks ORDER BY job_name`, [], 'cron_lock_list',
  );
  return rows.map((r) => ({
    jobName: r.job_name, holder: r.holder,
    acquiredAt: r.acquired_at, expiresAt: r.expires_at, expired: r.expired,
  }));
}

/**
 * Run `fn` only if this instance wins the lock.
 *
 * The lease is renewed on a timer while `fn` runs, so a job legitimately
 * slower than its TTL keeps the lock instead of having it stolen mid-run. The
 * release is in `finally` — a job that throws must not hold the lock until it
 * expires, or the next tick is skipped for no reason.
 */
export async function withLock(jobName, holder, fn, { ttlSeconds = 300 } = {}) {
  const claim = await acquireLock(jobName, holder, { ttlSeconds });
  if (!claim.acquired) return { ran: false, reason: 'NOT_LEADER' };

  const renewEvery = Math.max(Math.floor(ttlSeconds / 3), 1) * 1000;
  const heartbeat = setInterval(() => {
    renewLock(jobName, holder, { ttlSeconds }).catch((e) =>
      console.error(`[cron] lease renewal failed for ${jobName}:`, e.message));
  }, renewEvery);
  // Never hold the process open for a heartbeat.
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  try {
    return { ran: true, result: await fn() };
  } finally {
    clearInterval(heartbeat);
    await releaseLock(jobName, holder).catch((e) =>
      console.error(`[cron] lock release failed for ${jobName}:`, e.message));
  }
}

// ── Counters ────────────────────────────────────────────────────────────────

/**
 * Claim the next value of a counter.
 *
 * Derive from rows wherever there ARE rows to derive from — this exists for the
 * cases where there are none. The arithmetic is in the UPDATE, so two
 * concurrent claims cannot both read the same number and return it twice.
 */
export async function nextCounterValue(key, { by = 1 } = {}) {
  const { rows } = await pgQuery(
    `INSERT INTO counters (counter_key, value) VALUES ($1, $2)
     ON CONFLICT (counter_key) DO UPDATE
       SET value = counters.value + EXCLUDED.value, updated_at = now()
     RETURNING value`,
    [String(key), Math.max(Number(by) || 1, 1)], 'counter_next',
  );
  return Number(rows[0].value);
}

export async function getCounter(key) {
  const { rows } = await pgQuery(
    'SELECT value FROM counters WHERE counter_key = $1', [String(key)], 'counter_get',
  );
  return rows[0] ? Number(rows[0].value) : 0;
}

// ── Client crash reports ────────────────────────────────────────────────────

/** Record a crash from a browser panel. High volume, pruned by retention. */
export async function recordFrontendError({ message, stack = null, component = null, url = null, panel = null }) {
  if (!message) return null;
  const { rows } = await pgQuery(
    `INSERT INTO frontend_error_reports (message, stack, component, url, panel)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
    [String(message).slice(0, 4000), stack ? String(stack).slice(0, 20000) : null,
      component, url, panel], 'frontend_error_record',
  );
  return { id: Number(rows[0].id), createdAt: rows[0].created_at };
}

export async function listFrontendErrors({ limit = 100 } = {}) {
  const { rows } = await pgQuery(
    `SELECT id, message, stack, component, url, panel, created_at
       FROM frontend_error_reports ORDER BY created_at DESC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 100, 1), 1000)], 'frontend_error_list',
  );
  return rows.map((r) => ({
    id: Number(r.id), message: r.message, stack: r.stack, component: r.component,
    url: r.url, panel: r.panel, createdAt: r.created_at,
  }));
}

/**
 * Prune operational data past the retention window.
 *
 * Deliberately narrow. Financial, audit and user data is NEVER pruned — this
 * touches crash reports, expired referral clicks and expired notifications, and
 * a hard floor stops a misconfigured `retentionMonths` from deleting anything
 * recent whatever the admin set.
 */
export async function pruneOperationalData({ months = 6 } = {}) {
  const safeMonths = Math.max(Number(months) || 6, 1);
  const interval = `${safeMonths} months`;
  const out = {};
  for (const [name, sql] of Object.entries({
    frontendErrors: `DELETE FROM frontend_error_reports
                      WHERE created_at < now() - $1::interval
                        AND created_at < now() - interval '30 days'`,
    referralClicks: `DELETE FROM referral_clicks WHERE expires_at < now() - interval '30 days'`,
    notifications:  `DELETE FROM notifications
                      WHERE expires_at IS NOT NULL AND expires_at < now() - interval '30 days'`,
  })) {
    const { rowCount } = await pgQuery(sql, name === 'frontendErrors' ? [interval] : [], `prune_${name}`);
    out[name] = rowCount;
  }
  return out;
}
