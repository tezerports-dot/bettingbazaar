// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * featureFlags.service.js — Runtime feature flag system.
 *
 * FLAGS are checked with: await isEnabled(FLAGS.LIVE_CASINO)
 *
 * PRIORITY ORDER (highest wins)
 *   1. Runtime override   — override(flag, true/false)
 *   2. Environment var    — FEATURE_LIVE_CASINO=true
 *   3. Default value      — defined in DEFAULTS below
 *
 * CDN CONFIG (call at startup after fetching from CDN edge)
 *   hydrateFromConfig({ LIVE_CASINO: true, SPORTSBOOK: false })
 *
 * REDIS BACKEND (future — swap _overrides Map for Redis hash)
 *   All call-sites using isEnabled() continue to work unchanged.
 *
 * TENANT SUPPORT (future)
 *   isEnabled(FLAGS.LIVE_CASINO, tenantId) — per-tenant flag resolution
 */

// ── Flag names (import FLAGS.* — never use raw strings) ───────────────────────
export const FLAGS = Object.freeze({
  // Product Platforms (Phase 011)
  LIVE_CASINO:          'LIVE_CASINO',
  SPORTSBOOK:           'SPORTSBOOK',
  GAMES_PLATFORM:       'GAMES_PLATFORM',   // in-house games beyond the cycle market
  EVENT_FEEDS:          'EVENT_FEEDS',      // fixtures/results/live-data ingestion
  ODDS_ENGINE:          'ODDS_ENGINE',      // dynamic pricing (cycle market stays fixed 2x)
  // Chat
  PUBLIC_CHAT:          'PUBLIC_CHAT',
  // Payments
  MULTI_CURRENCY:       'MULTI_CURRENCY',
  CRYPTO_PAYMENTS:      'CRYPTO_PAYMENTS',
  INTERNATIONAL_GATEWAY:'INTERNATIONAL_GATEWAY',
  // Notifications
  PUSH_NOTIFICATIONS:   'PUSH_NOTIFICATIONS',
  // Infrastructure
  KAFKA_EVENT_BUS:      'KAFKA_EVENT_BUS',
  REDIS_RATE_LIMITER:   'REDIS_RATE_LIMITER',
  READ_REPLICA:         'READ_REPLICA',
  // Multi-tenancy
  MULTI_TENANT:         'MULTI_TENANT',
  // Operations
  MAINTENANCE_MODE:     'MAINTENANCE_MODE',
});

// ── Default values ─────────────────────────────────────────────────────────────
const DEFAULTS = {
  [FLAGS.LIVE_CASINO]:           false,
  [FLAGS.SPORTSBOOK]:            false,
  [FLAGS.GAMES_PLATFORM]:        false,
  [FLAGS.EVENT_FEEDS]:           false,
  [FLAGS.ODDS_ENGINE]:           false,
  [FLAGS.PUBLIC_CHAT]:           false,
  [FLAGS.MULTI_CURRENCY]:        false,
  [FLAGS.CRYPTO_PAYMENTS]:       false,
  [FLAGS.INTERNATIONAL_GATEWAY]: false,
  [FLAGS.PUSH_NOTIFICATIONS]:    false,
  [FLAGS.KAFKA_EVENT_BUS]:       false,
  [FLAGS.REDIS_RATE_LIMITER]:    true,
  [FLAGS.READ_REPLICA]:          false,
  [FLAGS.MULTI_TENANT]:          false,
  [FLAGS.MAINTENANCE_MODE]:      false,
};

const _overrides = new Map();

/**
 * Check if a feature flag is enabled.
 * @param {string}      flag    One of FLAGS.*
 * @param {string|null} tenant  Optional tenant ID
 * @returns {Promise<boolean>}
 */
export async function isEnabled(flag, tenant = null) {
  if (tenant) {
    const tk = `${tenant}:${flag}`;
    if (_overrides.has(tk)) return Boolean(_overrides.get(tk));
  }
  if (_overrides.has(flag)) return Boolean(_overrides.get(flag));
  const envKey = `FEATURE_${flag}`;
  if (process.env[envKey] !== undefined) {
    return process.env[envKey] === 'true' || process.env[envKey] === '1';
  }
  return Boolean(DEFAULTS[flag] ?? false);
}

/** Override a flag at runtime (for testing or live toggles). */
export function override(flag, value, tenant = null) {
  _overrides.set(tenant ? `${tenant}:${flag}` : flag, value);
}

/** Hydrate flags from a CDN-delivered JSON config object. */
export function hydrateFromConfig(config) {
  for (const [k, v] of Object.entries(config)) {
    if (k in DEFAULTS) _overrides.set(k, v);
  }
}

/** Snapshot of all current flag values (for admin / health endpoint). */
export async function getAllFlags(tenant = null) {
  const result = {};
  for (const flag of Object.values(FLAGS)) {
    result[flag] = await isEnabled(flag, tenant);
  }
  return result;
}
