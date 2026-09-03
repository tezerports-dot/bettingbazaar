// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
  ['DATABASE_URL', 'the datastore — every balance, order, bet and identity lives in PostgreSQL and there is no second store to fall back on'],
  ['ORDER_HMAC_SECRET', 'dedicated payment-order HMAC secret; prevents JWT key reuse for order signing'],
  ['AADHAAR_HMAC_SECRET', 'dedicated Aadhaar HMAC secret; prevents reversible duplicate-document hashes'],
  // Encrypts the values that must be RECOVERABLE rather than merely comparable:
  // Aadhaar numbers (the outside verifier needs the number) and Telegram bot
  // tokens (whoever holds one can speak as the platform). Missing it does not
  // fail at boot without this line — it fails at the first signup, which is a
  // far worse place to discover it.
  ['IDENTITY_ENCRYPTION_KEY', 'AES-256 key for Aadhaar + bot-token ciphertext; a wrong or absent key makes every stored identity unreadable'],
  ['REDIS_URL',         'cross-instance rate limits, realtime fan-out, and job queue need Redis at >1 replica'],
  ['ALLOWED_ORIGINS',   'CORS allow-list; production must explicitly name trusted origins'],
  // All four S3 vars, not just the bucket. server.js refuses to boot production
  // unless isS3Configured() is true (services/cdn.service.js), and that checks
  // BUCKET + ACCESS_KEY + SECRET_KEY + ENDPOINT. Listing only the bucket here
  // meant an operator could satisfy every name this gate prints and still crash
  // seconds later on a different, less specific error — the exact failure this
  // fail-fast module exists to prevent.
  ['S3_BUCKET_NAME',    'durable asset/upload storage; local disk is not safe for production'],
  ['S3_ACCESS_KEY',     'S3 credentials; production storage refuses the local-disk fallback'],
  ['S3_SECRET_KEY',     'S3 credentials; production storage refuses the local-disk fallback'],
  ['S3_ENDPOINT',       'S3-compatible endpoint URL (e.g. Cloudflare R2, Vultr, AWS)'],
  ['METRICS_TOKEN',     'protects Prometheus metrics from public disclosure'],
  ['PUBLIC_APP_ORIGIN', 'official public application origin advertised to native clients'],
  ['PUBLIC_APP_ALLOWED_ORIGINS', 'explicit public application origin allow-list advertised to native clients'],
];

// Only meaningful in a real deployment; absence is a warning, not a failure.
const ADVISED = [
];

const METRICS_TOKEN_PLACEHOLDERS = new Set([
  'change-this-to-a-random-metrics-token',
  'change-me',
  'changeme',
]);

const AADHAAR_HMAC_PLACEHOLDERS = new Set([
  'change-this-to-a-dedicated-random-string',
  'change-this-to-a-random-string',
]);

// Signing/HMAC secrets that must never reach production weak. A forgeable
// JWT/PASETO signing key or order-HMAC key is the single highest-impact failure
// on a money platform (anyone can mint sessions or sign fraudulent orders), so
// hold them to the same non-placeholder ≥32-char bar as the other secrets.
const SIGNING_SECRET_MIN = 32;
const SIGNING_SECRET_PLACEHOLDERS = new Set([
  'change-me', 'changeme', 'secret', 'password', 'your-secret-key', 'changethis',
  'test-only-jwt-secret', 'test-only-order-hmac-secret', 'change-this-to-a-random-string',
]);

function hasWeakSigningSecret(value) {
  const s = String(value || '').trim();
  return s.length < SIGNING_SECRET_MIN || SIGNING_SECRET_PLACEHOLDERS.has(s.toLowerCase());
}

function hasWeakMetricsToken(value) {
  const token = String(value || '').trim();
  return token.length < 32 || METRICS_TOKEN_PLACEHOLDERS.has(token.toLowerCase());
}

/**
 * The identity key is not a passphrase — it must decode to exactly 32 bytes.
 *
 * Checked at boot rather than at first use because the failure mode is
 * asymmetric: a bad key that is caught here costs a restart, while one that is
 * caught later has already encrypted records nobody can read back.
 */
function hasBadIdentityKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return true;
  try {
    const key = Buffer.from(raw, /^[0-9a-f]{64}$/i.test(raw) ? 'hex' : 'base64');
    return key.length !== 32;
  } catch { return true; }
}

function hasWeakAadhaarHmacSecret(value) {
  const secret = String(value || '').trim();
  return secret.length < 32 || AADHAAR_HMAC_PLACEHOLDERS.has(secret.toLowerCase());
}

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
  const weakAadhaarHmacSecret = hasWeakAadhaarHmacSecret(env.AADHAAR_HMAC_SECRET);
  const weakMetricsToken = hasWeakMetricsToken(env.METRICS_TOKEN);
  const invalidOrigins = ['PUBLIC_APP_ORIGIN', 'PUBLIC_APP_ALLOWED_ORIGINS'].filter((key) => {
    const origins = csv(env[key]);
    return env[key] && (!origins.length || !origins.every((origin) => isOrigin(origin, { requireHttps: isProd })));
  });
  const advisedMissing = ADVISED.filter(([k]) => !env[k] || String(env[k]).trim() === '').map(([k]) => k);

  // Signing secrets: the effective PASETO seed is PASETO_SECRET_KEY || JWT_SECRET
  // (see domains/identity/jwt.util.js), so hold whichever is set — plus the
  // order-HMAC key — to the strong-secret bar.
  const weakSigningSecrets = ['JWT_SECRET', 'PASETO_SECRET_KEY', 'ORDER_HMAC_SECRET']
    .filter((k) => env[k] && !missing.includes(k) && hasWeakSigningSecret(env[k]));

  // Money-DB TLS: PG_SSL=no-verify accepts ANY certificate for the Postgres
  // money datastore (a network attacker could MITM the ledger). Refuse to boot
  // production with it unless the operator explicitly accepts the risk.
  const insecurePgTls = String(env.PG_SSL || '').trim().toLowerCase() === 'no-verify'
    && String(env.ALLOW_INSECURE_PG_TLS || '').trim().toLowerCase() !== 'true';

  if (invalidOrigins.length && isProd) throw new Error(`FATAL: invalid public application origin configuration: ${invalidOrigins.join(', ')}`);
  if (weakSigningSecrets.length && isProd) {
    throw new Error(`FATAL: ${weakSigningSecrets.join(', ')} must each be a non-placeholder secret of at least ${SIGNING_SECRET_MIN} characters — a weak signing key lets anyone forge auth tokens or sign fraudulent orders`);
  }
  if (insecurePgTls && isProd) {
    throw new Error('FATAL: PG_SSL=no-verify disables money-DB TLS certificate verification. Pin the provider CA via PG_CA_CERT, or set ALLOW_INSECURE_PG_TLS=true to explicitly accept the risk.');
  }
  if (weakAadhaarHmacSecret && !missing.includes('AADHAAR_HMAC_SECRET') && isProd) {
    throw new Error('FATAL: AADHAAR_HMAC_SECRET must be a non-placeholder secret of at least 32 characters');
  }
  if (hasBadIdentityKey(env.IDENTITY_ENCRYPTION_KEY) && !missing.includes('IDENTITY_ENCRYPTION_KEY') && isProd) {
    throw new Error('FATAL: IDENTITY_ENCRYPTION_KEY must decode to exactly 32 bytes. Generate one with: openssl rand -base64 32');
  }
  if (weakMetricsToken && !missing.includes('METRICS_TOKEN') && isProd) {
    throw new Error('FATAL: METRICS_TOKEN must be a non-placeholder token of at least 32 characters');
  }

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
