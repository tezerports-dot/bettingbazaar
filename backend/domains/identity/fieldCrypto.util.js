// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/identity/fieldCrypto.util.js — AES-256-GCM for individual stored fields.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * A few values must be RECOVERABLE, not merely comparable, and are dangerous in
 * a database dump:
 *
 *   - Aadhaar numbers. KYC verification is performed in bulk by an outside
 *     party who genuinely needs the number to check it against the phone, so a
 *     one-way hash alone cannot serve the workflow. The hash still exists and is
 *     what enforces "one account per Aadhaar" (aadhaarHash.util.js); this holds
 *     the ciphertext the export is generated from.
 *   - Telegram bot tokens. Whoever holds one can impersonate the bot — read
 *     every message sent to it, and message every user who has ever started it.
 *
 * Both are written once and read rarely, by one audited path each. Storing them
 * in plaintext would mean a single `mongodump` hands over every player's
 * national identity number and the ability to speak as the platform.
 *
 * ── Why a separate key from TOTP ────────────────────────────────────────────
 * `totp.service.js` already encrypts second-factor secrets under
 * TOTP_ENCRYPTION_KEY, and this deliberately does NOT reuse that key. The two
 * protect different things with different blast radii: a leaked TOTP key costs
 * you second factors, a leaked identity key costs you every Aadhaar on the
 * platform. Sharing one key would make rotating either of them require
 * re-encrypting both.
 *
 * The format and the refusal-to-derive rule are copied deliberately from
 * totp.service.js — that shape is already proven here, and a second, subtly
 * different crypto implementation in the same codebase is its own hazard.
 */
import crypto from 'crypto';

const ENC_ALGORITHM = 'aes-256-gcm';

/**
 * The key, resolved per call so a rotated env var takes effect on redeploy
 * without a code change, and so tests can set it up before first use.
 *
 * Malformed material is REFUSED rather than hashed into something usable. A
 * derived key looks forgiving and is a trap: the service starts, records are
 * encrypted under the wrong key, and the moment the typo is corrected every
 * stored value becomes undecryptable. Failing at first use is recoverable.
 */
function encryptionKey() {
  const raw = process.env.IDENTITY_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error(
      'IDENTITY_ENCRYPTION_KEY is not configured. ' +
      'Generate one with: openssl rand -base64 32',
    );
  }
  const key = Buffer.from(raw, /^[0-9a-f]{64}$/i.test(raw) ? 'hex' : 'base64');
  if (key.length !== 32) {
    throw new Error(
      `IDENTITY_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}). ` +
      'Generate one with: openssl rand -base64 32',
    );
  }
  return key;
}

/** True when a key is present and well-formed — for boot checks and health. */
export function configured() {
  try { encryptionKey(); return true; } catch { return false; }
}

/** Encrypt a value for storage. Returns `v1:<iv>:<tag>:<ciphertext>`, base64. */
export function encryptField(plain) {
  const iv = crypto.randomBytes(12); // 96-bit nonce, the GCM standard
  const cipher = crypto.createCipheriv(ENC_ALGORITHM, encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/**
 * Reverse of encryptField. Throws if the ciphertext was tampered with — GCM
 * authenticates, so a modified record fails loudly instead of decrypting to
 * something plausible.
 */
export function decryptField(stored) {
  const parts = String(stored ?? '').split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Stored value is not in the expected v1 format');
  }
  const [, iv, tag, data] = parts;
  const decipher = crypto.createDecipheriv(ENC_ALGORITHM, encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export default { configured, encryptField, decryptField };
