// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/securityPg.js — the IP deny-list.
 *
 * ── This control has never functioned ───────────────────────────────────────
 * `ipBlocker` runs on every request. It asked for a model that was registered
 * NOWHERE, so every call raised MissingSchemaError into a catch that fails open
 * without logging. `blockIP` was the same: an operator blocking an abusive
 * address saw a success message and got no effect, indefinitely.
 *
 * ── Fail-open is kept, deliberately, and made loud ──────────────────────────
 * A deny-list that fails CLOSED locks every user out when the database blinks,
 * which is a worse outcome than letting a handful of blocked addresses through
 * for the duration. So the posture stays — but the failure is now LOGGED rather
 * than swallowed, because "the block silently stopped working" is exactly how
 * this ended up dead for as long as it did.
 *
 * That is the opposite call from `isTokenRevoked`, which fails closed, and the
 * difference is deliberate: a revoked token is a credential its holder is not
 * entitled to, while a blocked IP is a coarse abuse control whose false
 * positives are ordinary users.
 *
 * ── The cache, and why it is short ──────────────────────────────────────────
 * This is on every request, so an unconditional query per request is a real
 * cost. The cache is small and brief: an UNBLOCK takes effect within one TTL,
 * and a new BLOCK is applied immediately by invalidating on write, because the
 * asymmetry matters — being slow to stop an attacker is worse than being slow
 * to release one.
 */
import { pgQuery } from '../client.js';

/** How long a "not blocked" answer may be reused. Deliberately brief. */
const CACHE_TTL_MS = 30_000;

/** ip -> { blocked: boolean, at: number } */
const cache = new Map();

/** Drop a single address from the cache, or all of them. */
export function invalidateIpCache(ip = null) {
  if (ip) cache.delete(String(ip));
  else cache.clear();
}

/**
 * Is this address blocked right now?
 *
 * The expiry is enforced HERE rather than by a sweep: a temporary block whose
 * row has not been reclaimed yet has still lapsed, and one that has not lapsed
 * must hold even if no sweep ever runs.
 */
export async function isIpBlocked(ip) {
  if (!ip) return false;
  const key = String(ip);

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.blocked;

  const { rows } = await pgQuery(
    `SELECT 1 FROM blocked_ips
      WHERE ip = $1 AND active AND (expires_at IS NULL OR expires_at > now())`,
    [key], 'ip_is_blocked',
  );
  const blocked = rows.length > 0;
  cache.set(key, { blocked, at: Date.now() });
  return blocked;
}

/**
 * Block an address.
 *
 * Upsert, because blocking an already-blocked address is a retry rather than an
 * error, and re-blocking one that was released must revive the row rather than
 * collide with it.
 */
export async function blockIp(ip, { reason = 'Suspicious activity', actor = null, expiresAt = null } = {}) {
  if (!ip) throw new Error('blockIp requires an ip');
  const { rows } = await pgQuery(
    `INSERT INTO blocked_ips (ip, reason, active, blocked_at, blocked_by, expires_at)
     VALUES ($1, $2, TRUE, now(), $3, $4)
     ON CONFLICT (ip) DO UPDATE SET
       reason = EXCLUDED.reason, active = TRUE, blocked_at = now(),
       blocked_by = EXCLUDED.blocked_by, expires_at = EXCLUDED.expires_at,
       unblocked_at = NULL, unblocked_by = NULL
     RETURNING ip, reason, blocked_at, expires_at`,
    [String(ip), String(reason), actor ? String(actor) : null, expiresAt],
    'ip_block',
  );
  // Applied immediately, not at the next TTL: slow to stop an attacker is the
  // expensive direction of this trade.
  invalidateIpCache(ip);
  return rows[0];
}

/**
 * Release an address.
 *
 * The row SURVIVES, marked. "Was this address ever blocked, and why?" is what
 * an appeal asks, and deleting the row destroys the answer.
 */
export async function unblockIp(ip, { actor = null } = {}) {
  const { rows } = await pgQuery(
    `UPDATE blocked_ips
        SET active = FALSE, unblocked_at = now(), unblocked_by = $2
      WHERE ip = $1
      RETURNING ip, active, unblocked_at`,
    [String(ip), actor ? String(actor) : null], 'ip_unblock',
  );
  invalidateIpCache(ip);
  return rows[0] ?? null;
}

/** Everything currently blocked, newest first — the operator's view. */
export async function listBlockedIps({ includeReleased = false, limit = 200 } = {}) {
  const { rows } = await pgQuery(
    `SELECT ip, reason, active, blocked_at, blocked_by, unblocked_at, expires_at, notes
       FROM blocked_ips
      ${includeReleased ? '' : 'WHERE active AND (expires_at IS NULL OR expires_at > now())'}
      ORDER BY blocked_at DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 200, 1), 1000)], 'ip_list',
  );
  return rows.map((r) => ({
    ip: r.ip, reason: r.reason, active: r.active,
    blockedAt: r.blocked_at, blockedBy: r.blocked_by,
    unblockedAt: r.unblocked_at, expiresAt: r.expires_at, notes: r.notes,
  }));
}
