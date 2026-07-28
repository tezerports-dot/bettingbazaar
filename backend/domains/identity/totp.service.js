// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/identity/totp.service.js — THE authority for time-based one-time
 * passwords (Google Authenticator, Authy, 1Password, any RFC 6238 app).
 *
 * ── Why this is implemented rather than imported ───────────────────────────
 * TOTP is HMAC-SHA1 over a counter, truncated — RFC 4226 plus a clock. It is
 * not novel cryptography being invented here; every primitive comes from
 * node:crypto. What that buys is that the code path guarding every privileged
 * login carries no third-party dependency, and RFC 6238 Appendix B publishes
 * test vectors, so correctness is PROVEN against the specification rather than
 * assumed from a package's download count (see totp.service.test.js).
 *
 * ── Secrets are encrypted at rest ──────────────────────────────────────────
 * A TOTP secret is a bearer credential: anyone holding it can generate valid
 * codes forever. Unlike a password it cannot be stored as a one-way hash,
 * because the server must recompute codes from it. So it is encrypted with
 * AES-256-GCM under TOTP_ENCRYPTION_KEY and only decrypted for the microsecond
 * a verification takes. A database dump alone does not yield working 2FA.
 *
 * ── Replay ─────────────────────────────────────────────────────────────────
 * A code is valid for a whole time step (30s) and, with the drift window, a
 * little either side. Without a guard the same six digits work more than once
 * inside that span — which matters when the threat is someone reading the code
 * over a shoulder or off a phished page. verifyToken returns the counter it
 * matched so the caller can persist it and refuse anything at or below it.
 */
import crypto from 'crypto';

/** RFC 6238 defaults, and what every authenticator app assumes. */
export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;

/**
 * How many steps either side of "now" are accepted. 1 = ±30s, which tolerates
 * ordinary phone clock drift and a user typing the last digit as the code
 * rolls. Higher values widen the window an attacker has to reuse an observed
 * code, so this stays small.
 */
export const TOTP_DRIFT_STEPS = 1;

// ── Base32 (RFC 4648) ───────────────────────────────────────────────────────
// Authenticator apps take the secret as unpadded base32; this is the only
// reason the encoding exists here.
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += B32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = B32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ── HOTP / TOTP ─────────────────────────────────────────────────────────────

/**
 * RFC 4226 HOTP. `counter` is a step number, not a timestamp.
 * @param {Buffer} secret raw secret bytes
 */
export function hotp(secret, counter, digits = TOTP_DIGITS, algorithm = 'sha1') {
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter. writeBigUInt64BE keeps this exact past 2^53,
  // which Number arithmetic would not.
  buf.writeBigUInt64BE(BigInt(counter));

  const digest = crypto.createHmac(algorithm, secret).update(buf).digest();
  // Dynamic truncation (RFC 4226 §5.3): low nibble of the last byte selects
  // the 4-byte window, and the top bit is masked off to keep it positive.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The step number for a given epoch-milliseconds timestamp. */
export function counterFor(atMs = Date.now(), stepSeconds = TOTP_STEP_SECONDS) {
  return Math.floor(atMs / 1000 / stepSeconds);
}

/** The code an authenticator app shows right now, for a base32 secret. */
export function generateToken(base32Secret, atMs = Date.now()) {
  return hotp(base32Decode(base32Secret), counterFor(atMs));
}

/**
 * Verify a submitted code.
 *
 * @param {object} args
 * @param {string} args.secret     base32 secret
 * @param {string} args.token      what the user typed
 * @param {number} [args.atMs]
 * @param {number} [args.lastCounter] highest step already spent by this account;
 *   anything at or below it is refused as a replay.
 * @returns {{valid: boolean, counter?: number, reason?: string}}
 */
export function verifyToken({ secret, token, atMs = Date.now(), lastCounter = null }) {
  const cleaned = String(token ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleaned)) return { valid: false, reason: 'malformed' };

  const raw = base32Decode(secret);
  const current = counterFor(atMs);

  for (let drift = -TOTP_DRIFT_STEPS; drift <= TOTP_DRIFT_STEPS; drift++) {
    const counter = current + drift;
    if (counter < 0) continue;

    const expected = hotp(raw, counter);
    // Constant-time compare: a byte-by-byte early exit leaks, through timing,
    // how much of the code was right — which turns 10^6 guesses into 6×10.
    const a = Buffer.from(expected);
    const b = Buffer.from(cleaned);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) continue;

    if (lastCounter !== null && counter <= lastCounter) {
      return { valid: false, reason: 'replay' };
    }
    return { valid: true, counter };
  }
  return { valid: false, reason: 'mismatch' };
}

// ── Enrolment ───────────────────────────────────────────────────────────────

/** A fresh 160-bit secret — the size RFC 4226 §4 R6 recommends for HMAC-SHA1. */
export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/**
 * The `otpauth://` URI an authenticator app scans. The panel renders this as a
 * QR code; the secret never has to be typed.
 *
 * `issuer` appears as the account's heading in the app, and `label` identifies
 * WHICH account — critical when one person holds admin, merchant and player
 * entries for the same platform and must pick the right code under pressure.
 */
export function buildOtpauthUri({ secret, label, issuer = 'Betting Bazaar' }) {
  if (!secret) throw new Error('buildOtpauthUri requires a secret');
  if (!label) throw new Error('buildOtpauthUri requires a label');
  const encodedLabel = encodeURIComponent(`${issuer}:${label}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${encodedLabel}?${params.toString()}`;
}

// ── Secret storage ──────────────────────────────────────────────────────────

const ENC_ALGORITHM = 'aes-256-gcm';

/**
 * The key TOTP secrets are encrypted under. Separate from JWT_SECRET on
 * purpose: rotating the auth key must not silently invalidate everyone's
 * enrolled authenticator, and a leak of one must not compromise the other.
 */
function encryptionKey() {
  const raw = process.env.TOTP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'TOTP_ENCRYPTION_KEY is not set — 2FA secrets cannot be stored safely. ' +
      'Generate one with: openssl rand -base64 32',
    );
  }
  // Exactly 32 bytes, as base64 or hex. Anything else is REFUSED rather than
  // hashed into a usable key.
  //
  // Deriving a key from malformed material looks forgiving and is a trap: the
  // service starts happily, users enrol, secrets are encrypted under the
  // derived key — and the moment someone notices the typo and corrects the
  // env var, every stored secret becomes undecryptable and every enrolled
  // user is locked out. Failing at the first use is recoverable; silently
  // succeeding under the wrong key is not.
  const key = Buffer.from(raw, /^[0-9a-f]{64}$/i.test(raw) ? 'hex' : 'base64');
  if (key.length !== 32) {
    throw new Error(
      `TOTP_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}). ` +
      'Generate one with: openssl rand -base64 32',
    );
  }
  return key;
}

/** Encrypt a secret for storage. Returns `v1:<iv>:<tag>:<ciphertext>`, base64. */
export function encryptSecret(plainSecret) {
  const iv = crypto.randomBytes(12); // 96-bit nonce, the GCM standard
  const cipher = crypto.createCipheriv(ENC_ALGORITHM, encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plainSecret), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/** Reverse of encryptSecret. Throws if the ciphertext was tampered with. */
export function decryptSecret(stored) {
  const parts = String(stored ?? '').split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Stored TOTP secret is not in the expected v1 format');
  }
  const [, iv, tag, data] = parts;
  const decipher = crypto.createDecipheriv(ENC_ALGORITHM, encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// ── Backup codes ────────────────────────────────────────────────────────────

/**
 * Recovery codes, issued once at enrolment.
 *
 * These are not a nicety. 2FA is mandatory for admins and merchants, so a lost
 * or wiped phone locks someone out of an account that moves money — and for the
 * main admin there is nobody above them to reset it. Without recovery codes the
 * first broken handset is an unrecoverable lockout of the platform's own
 * operator.
 *
 * Stored as SHA-256 hashes. Unlike passwords these are high-entropy random
 * values, so a slow KDF buys nothing against brute force and would only add
 * latency to a login.
 */
export function generateBackupCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    // 40 bits, rendered as 8 base32 chars in two readable groups.
    const raw = base32Encode(crypto.randomBytes(5)).slice(0, 8);
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}

export function hashBackupCode(code) {
  return crypto.createHash('sha256')
    .update(String(code).toUpperCase().replace(/[\s-]/g, ''))
    .digest('hex');
}

/**
 * Spend a backup code. Returns the remaining hashes so the caller persists a
 * list with this one removed — single use is the whole point.
 */
export function consumeBackupCode(submitted, storedHashes = []) {
  const hash = hashBackupCode(submitted);
  const index = storedHashes.indexOf(hash);
  if (index === -1) return { valid: false, remaining: storedHashes };
  const remaining = storedHashes.filter((_, i) => i !== index);
  return { valid: true, remaining };
}
