// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * startup/validateEnv.js — fail-fast environment validation (AQ-1).
 *
 * A money platform must never boot into a state where a missing secret silently
 * degrades security (e.g. a fallback JWT secret that lets anyone forge tokens,
 * or an unset Mongo URI that connects to localhost). This module makes the
 * required configuration a HARD boot gate in production and a loud warning in
 * development, so misconfiguration surfaces at deploy time — not as a 3 a.m.
 * incident.
 *
 * Two tiers:
 *   REQUIRED  — the process cannot serve traffic safely without these. Missing
 *               any one aborts boot in production (throws) and warns loudly
 *               otherwise (tests set their own).
 *   ADVISED   — the app runs without them but a production deploy almost
 *               certainly wants them (S3, alerting, canonical host). Logged as a
 *               single warning; never fatal.
 *
 * Called once from server.js before the app starts listening.
 */

const REQUIRED = [
  ['JWT_SECRET',  'signs/verifies every auth token — a fallback would let anyone forge sessions'],
  ['MONGODB_URI', 'primary datastore — unset silently connects to localhost'],
  ['DATABASE_URL', 'PostgreSQL money datastore — required for active MongoDB + Postgres hybrid dual-write'],
  ['ORDER_HMAC_SECRET', 'dedicated payment-order HMAC secret; prevents JWT key reuse for order signing'],
  ['AADHAAR_HMAC_SECRET', 'dedicated Aadhaar HMAC secret; prevents reversible duplicate-document hashes'],
  ['REDIS_URL',         'cross-instance rate limits, realtime fan-out, and job queue need Redis at >1 replica'],
  ['ALLOWED_ORIGINS',   'CORS allow-list; production must explicitly name trusted origins'],
  ['S3_BUCKET_NAME',    'durable asset/upload storage; local disk is not safe for production'],
  ['METRICS_TOKEN',     'protects Prometheus metrics from public disclosure'],
  ['PUBLIC_APP_ORIGIN', 'official public application origin advertised to native clients'],
  ['PUBLIC_APP_ALLOWED_ORIGINS', 'explicit public application origin allow-list advertised to native clients'],
];

// Only meaningful in a real deployment; absence is a warning, not a failure.
const ADVISED = [
];

export function csv(value) {
  return String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

function isOrigin(value, { requireHttps = false } = {}) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (requireHttps && parsed.protocol !== 'https:') return false;
    return parsed.origin === value;
  } catch { return false; }
}

/**
 * @param {object} [env=process.env]
 * @param {boolean} [isProd=NODE_ENV==='production']
 * @returns {{ ok: boolean, missing: string[], advisedMissing: string[] }}
 * @throws in production when any REQUIRED var is missing.
 */
export function validateEnv(env = process.env, isProd = env.NODE_ENV === 'production') {
  const missing = REQUIRED.filter(([k]) => !env[k] || String(env[k]).trim() === '').map(([k]) => k);
  const invalidOrigins = ['PUBLIC_APP_ORIGIN', 'PUBLIC_APP_ALLOWED_ORIGINS'].filter((key) => {
    const origins = csv(env[key]);
    return env[key] && (!origins.length || !origins.every((origin) => isOrigin(origin, { requireHttps: isProd })));
  });
  const advisedMissing = ADVISED.filter(([k]) => !env[k] || String(env[k]).trim() === '').map(([k]) => k);

  if (invalidOrigins.length && isProd) throw new Error(`FATAL: invalid public application origin configuration: ${invalidOrigins.join(', ')}`);

  if (missing.length) {
    const detail = REQUIRED.filter(([k]) => missing.includes(k))
      .map(([k, why]) => `  - ${k}: ${why}`).join('\n');
    const msg = `FATAL: missing required environment variable(s):\n${detail}`;
    if (isProd) throw new Error(msg);
    // Non-prod: warn but let the process continue (dev/test provide their own).
    console.warn(`⚠️  ${msg}\n   (continuing because NODE_ENV=${env.NODE_ENV || 'unset'} — production would refuse to start)`);
  }

  if (advisedMissing.length && isProd) {
    console.warn('⚠️  Advised (not fatal) environment variables unset for production:');
    for (const [k, why] of ADVISED) {
      if (advisedMissing.includes(k)) console.warn(`   - ${k}: ${why}`);
    }
  }

  return { ok: missing.length === 0, missing, advisedMissing };
}

export default validateEnv;
