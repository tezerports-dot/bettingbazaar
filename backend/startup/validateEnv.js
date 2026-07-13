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
];

// Only meaningful in a real deployment; absence is a warning, not a failure.
// NOTE: ORDER_HMAC_SECRET is ADVISED (not required) on purpose — the order-signing
// code falls back to JWT_SECRET when it's unset, so making it fatal would refuse
// to boot an existing production that relies on that fallback. It's strongly
// recommended (key separation) but must not turn a deploy into an outage.
const ADVISED = [
  ['ORDER_HMAC_SECRET', 'dedicated payment-order HMAC secret; falls back to JWT_SECRET if unset — set a distinct value for key separation'],
  ['REDIS_URL',         'cross-instance rate limits, realtime fan-out, and job queue need Redis at >1 replica'],
  ['ALLOWED_ORIGINS',   'CORS allow-list; without it, production falls back to localhost origins only'],
  ['S3_BUCKET_NAME',    'asset/upload storage; without S3 the app uses ephemeral local disk (lost on redeploy)'],
];

/**
 * @param {object} [env=process.env]
 * @param {boolean} [isProd=NODE_ENV==='production']
 * @returns {{ ok: boolean, missing: string[], advisedMissing: string[] }}
 * @throws in production when any REQUIRED var is missing.
 */
export function validateEnv(env = process.env, isProd = env.NODE_ENV === 'production') {
  const missing = REQUIRED.filter(([k]) => !env[k] || String(env[k]).trim() === '').map(([k]) => k);
  const advisedMissing = ADVISED.filter(([k]) => !env[k] || String(env[k]).trim() === '').map(([k]) => k);

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
