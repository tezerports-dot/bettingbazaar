// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * jwt.util.js — the SINGLE sign/verify authority for JSON Web Tokens (AQ-2).
 *
 * Every token this platform issues or checks flows through signToken() and
 * verifyJwt() here, so three security properties hold uniformly instead of being
 * re-implemented (and drifting) per file:
 *
 *   1. Algorithm pinned to HS256 on verify — blocks the "algorithm confusion"
 *      class (OWASP API2 / ASVS V9): a token forged with alg:none, or an
 *      attacker-supplied asymmetric alg, is rejected outright. Plain
 *      jwt.verify(token, secret) accepts whatever alg the token header claims.
 *   2. issuer + audience claims are STAMPED on every token we sign.
 *   3. issuer + audience are ENFORCED in production by default; non-production keeps legacy-test compatibility unless JWT_ENFORCE_CLAIMS=true.
 *
 * Compatibility rollback: production requires claims unless JWT_ENFORCE_CLAIMS=false
 * is set for an emergency legacy-token migration window. Test/development can keep
 * existing unsigned helper tokens working unless JWT_ENFORCE_CLAIMS=true is set.
 * The switch is env-only; no code change and no redeploy of this module.
 *
 * No fallback secret, ever: a missing JWT_SECRET is fatal at import time — the
 * same fail-fast posture as startup/validateEnv.js, enforced here because this
 * module is imported by every auth path.
 */
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is not set. Refusing to start.');
}

// SECRET ROTATION (Bucket B — activation-ready). Zero-downtime key rotation:
// tokens are SIGNED with JWT_SECRET (the current key) but VERIFIED against the
// current key PLUS any keys in JWT_PREVIOUS_SECRETS (comma-separated). To rotate
// without logging everyone out: set JWT_PREVIOUS_SECRETS=<old>, JWT_SECRET=<new>,
// deploy; sessions minted with <old> keep verifying until they expire, then drop
// <old> from JWT_PREVIOUS_SECRETS. With no previous keys set (the default), this
// is byte-for-byte the single-key behavior — nothing changes until you rotate.
const JWT_PREVIOUS_SECRETS = (process.env.JWT_PREVIOUS_SECRETS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const JWT_VERIFY_KEYS = [JWT_SECRET, ...JWT_PREVIOUS_SECRETS];

// D-4 (owner decision 2026-07-13): default access-token lifetime is 24h (was 7d).
// Instant revocation is retained via the per-request TokenBlacklist check, so a
// stolen token is both time-bounded AND killable. Env still overrides.
export const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
export const JWT_ISSUER     = process.env.JWT_ISSUER     || 'bettingbazaar';
export const JWT_AUDIENCE   = process.env.JWT_AUDIENCE   || 'bettingbazaar';
const ENFORCE_CLAIMS = process.env.JWT_ENFORCE_CLAIMS === undefined
  ? process.env.NODE_ENV === 'production'
  : process.env.JWT_ENFORCE_CLAIMS !== 'false';

/**
 * Sign a token. Stamps HS256 + issuer + audience + expiry.
 * @param {object} payload  claims (userId / merchantId / roles / …)
 * @param {object} [options] e.g. { expiresIn: '30m' } to override the default
 */
export function signToken(payload, options = {}) {
  const { expiresIn = JWT_EXPIRES_IN, ...rest } = options;
  return jwt.sign(payload, JWT_SECRET, {
    algorithm: 'HS256',
    issuer:    JWT_ISSUER,
    audience:  JWT_AUDIENCE,
    expiresIn,
    ...rest,
  });
}

/**
 * Verify a token. Throws exactly like jwt.verify (TokenExpiredError /
 * JsonWebTokenError) so existing per-site error handling keeps working.
 * Always pins algorithms:['HS256']; enforces iss/aud only when the flag is on.
 */
export function verifyJwt(token) {
  const opts = { algorithms: ['HS256'] };
  if (ENFORCE_CLAIMS) {
    opts.issuer   = JWT_ISSUER;
    opts.audience = JWT_AUDIENCE;
  }
  // Try the current key first, then any rotation keys. A signature mismatch on
  // one key falls through to the next; a non-signature failure (expired, bad
  // claims) is final and re-thrown as-is so callers see the real reason.
  let lastErr;
  for (const key of JWT_VERIFY_KEYS) {
    try {
      return jwt.verify(token, key, opts);
    } catch (err) {
      lastErr = err;
      // Only a signature/format problem is worth trying another key for; an
      // expired or claim-invalid token would fail identically under every key.
      if (err.name !== 'JsonWebTokenError') throw err;
    }
  }
  throw lastErr;
}

/**
 * Non-throwing variant — returns the decoded payload or null. Preserved for
 * callers that historically used the null-returning verifyToken() helper.
 */
export function tryVerifyJwt(token) {
  try { return verifyJwt(token); } catch { return null; }
}

export { JWT_SECRET, ENFORCE_CLAIMS };
