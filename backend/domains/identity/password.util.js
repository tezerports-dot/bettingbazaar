// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * password.util.js — the single password hashing authority (AQ-8).
 *
 * NEW hashes use Argon2id — the OWASP/NIST first-choice password KDF (memory-hard
 * against GPU cracking, no 72-byte input cap). Parameters follow the OWASP
 * Password Storage Cheat Sheet minimum: memoryCost 19 MiB (19456 KiB), timeCost
 * 2, parallelism 1. Argon2 is a native module and runs on the libuv threadpool,
 * so hashing a login burst no longer blocks the event loop the way pure-JS
 * bcryptjs (cost 12, ~150-250ms on-thread) did.
 *
 * verifyPassword() accepts BOTH argon2id and legacy bcrypt hashes, so existing
 * users are never locked out. On a successful bcrypt verify it reports
 * needsRehash:true — the login handler then transparently re-stores the password
 * as argon2id, upgrading each user in place the next time they sign in. bcryptjs
 * is retained ONLY as a verify-fallback for those not-yet-upgraded hashes.
 */
import argon2 from 'argon2';
import bcrypt from 'bcryptjs';

// OWASP ASVS 5.0 / Password Storage Cheat Sheet minimum for Argon2id.
const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: Number(process.env.ARGON2_MEMORY_KIB || 19456), // 19 MiB
  timeCost:   Number(process.env.ARGON2_TIME_COST  || 2),
  parallelism: Number(process.env.ARGON2_PARALLELISM || 1),
};

/** Hash a plaintext password with Argon2id. */
export async function hashPassword(plain) {
  return argon2.hash(String(plain), ARGON2_OPTS);
}

/**
 * Verify a plaintext password against a stored hash of EITHER scheme.
 * @returns {Promise<{ valid: boolean, needsRehash: boolean }>}
 *   needsRehash is true when the stored hash is a legacy bcrypt hash that
 *   verified — the caller should re-store hashPassword(plain) to upgrade it.
 */
export async function verifyPassword(hash, plain) {
  if (typeof hash !== 'string' || !hash) return { valid: false, needsRehash: false };
  if (hash.startsWith('$argon2')) {
    const valid = await argon2.verify(hash, String(plain)).catch(() => false);
    return { valid, needsRehash: false };
  }
  // Legacy bcrypt hash ($2a$ / $2b$ / $2y$): verify, and flag for upgrade.
  const valid = await bcrypt.compare(String(plain), hash).catch(() => false);
  return { valid, needsRehash: valid };
}

/** True if a stored hash is already Argon2id (no upgrade needed). */
export function isArgon2(hash) {
  return typeof hash === 'string' && hash.startsWith('$argon2');
}
