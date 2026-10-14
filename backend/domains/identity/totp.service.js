// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/identity/totp.service.js — the STAFF second factor: an authenticator
 * app (owner, 2026-10-13: admin, sub-admin, queue manager and mediator sign in
 * with mobile + password + Google Authenticator; no Telegram).
 *
 * RFC 6238 over `node:crypto`, no dependency: HMAC-SHA-1, 6 digits, 30-second
 * steps, the step before and after accepted for clock drift, compared in
 * constant time. The secret is 20 random bytes, base32, encrypted at rest
 * (`encryptField`, IDENTITY_ENCRYPTION_KEY). The QR is drawn here
 * (`QRCode.toDataURL`), so the admin panel needs no QR library (CSP already
 * allows `img-src data:`).
 *
 * ── What makes a code single-use ───────────────────────────────────────────
 * The step a code matched is claimed in the database (`db.totp.claimCounter`,
 * `last_counter < step` in the UPDATE's WHERE, §32 S6). A code typed twice,
 * an older code, or the same code arriving on two connections at once: one
 * wins, the rest are refused.
 *
 * ── Recovery codes ──────────────────────────────────────────────────────────
 * Ten `XXXXX-XXXXX` codes (base32 alphabet), shown once, stored only as
 * argon2id hashes, each spent by removing its hash in one UPDATE. Every stored
 * hash is checked on every attempt, so the time taken does not say which slot
 * matched. New codes need a current authenticator code, never a recovery code:
 * a stolen recovery code must not be able to mint ten more.
 */
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { db } from '#db';
import { encryptField, decryptField } from './fieldCrypto.util.js';
import { hashPassword, verifyPassword } from './password.util.js';
import { refusal } from '../../shared/httpError.js';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;
/** The step before and after the current one are accepted (clock drift). */
const WINDOW = 1;
const SECRET_BYTES = 20;
const RECOVERY_CODE_COUNT = 10;

// ── Base32 (RFC 4648, no padding) ──────────────────────────────────────────

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('base32Decode: not base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ── HOTP / TOTP ─────────────────────────────────────────────────────────────

/** RFC 4226 HOTP: the `digits`-digit code for one counter. */
export function hotp(secret, counter, digits = DIGITS) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16)
    | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The 30-second step a moment falls in. */
export function stepAt(ms = Date.now()) {
  return Math.floor(ms / 1000 / STEP_SECONDS);
}

/** RFC 6238 TOTP for a moment. */
export function totp(secret, ms = Date.now(), digits = DIGITS) {
  return hotp(secret, stepAt(ms), digits);
}

function sameCode(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Which step in the window this code belongs to, or null. Every step in the
 * window is computed and compared, so the time taken does not depend on which
 * one matched.
 *
 * @param {Buffer} secret
 * @param {string} code
 * @param {number} [ms]
 * @returns {number|null}
 */
export function matchStep(secret, code, ms = Date.now()) {
  if (!/^\d{6}$/.test(String(code ?? ''))) return null;
  const now = stepAt(ms);
  let matched = null;
  for (let s = now - WINDOW; s <= now + WINDOW; s += 1) {
    if (sameCode(hotp(secret, s), code) && matched === null) matched = s;
  }
  return matched;
}

// ── Recovery codes ──────────────────────────────────────────────────────────

/** `XXXXX-XXXXX`, base32 alphabet. */
function newRecoveryCode() {
  const chars = [...crypto.randomBytes(10)].map((b) => BASE32[b & 31]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

/** What a person types, in the stored shape: case, spaces and dashes forgiven. */
export function normaliseRecoveryCode(input) {
  const clean = String(input ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z2-7]{10}$/.test(clean)) return null;
  return `${clean.slice(0, 5)}-${clean.slice(5)}`;
}

async function freshRecoveryCodes() {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  const hashes = await Promise.all(codes.map((c) => hashPassword(c)));
  return { codes, hashes };
}

// ── Refusals, in the words of the person who meets them ────────────────────

const WRONG_CODE = () => refusal(401, 'TOTP_INVALID',
  'That code is not right. Type the 6-digit code your authenticator app shows now.');
const NOT_ENROLLED = () => refusal(409, 'TOTP_NOT_ENROLLED',
  'This account has no authenticator app yet. Sign in again to set one up.');
const ALREADY_ENROLLED = () => refusal(409, 'TOTP_ALREADY_ENROLLED',
  'This account already has an authenticator app. Ask an admin to reset it if you lost it.');
const SETUP_EXPIRED = () => refusal(409, 'TOTP_SETUP_EXPIRED',
  'This setup has expired. Start again to get a new QR code.');

// ── Enrolment ───────────────────────────────────────────────────────────────

/**
 * Start (or restart) enrolment: a new secret, stored pending, and what the
 * person scans.
 *
 * @param {object} user  the STAFF `users` row
 * @param {object} o
 * @param {string} o.issuer  the platform's name (branding `appName`)
 * @returns {Promise<{secret: string, otpauthUri: string, qrDataUrl: string}>}
 */
export async function beginEnrolment(user, { issuer }) {
  const secret = base32Encode(crypto.randomBytes(SECRET_BYTES));
  const saved = await db.totp.savePending(user.userId, encryptField(secret));
  if (!saved) throw ALREADY_ENROLLED();
  const label = encodeURIComponent(`${issuer}:${user.mobile}`);
  const params = new URLSearchParams({
    secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS),
  });
  const otpauthUri = `otpauth://totp/${label}?${params.toString()}`;
  const qrDataUrl = await QRCode.toDataURL(otpauthUri, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
  return { secret, otpauthUri, qrDataUrl };
}

/**
 * Finish enrolment with the first code from the app. Answers the ten recovery
 * codes, shown once.
 *
 * @returns {Promise<{recoveryCodes: string[]}>}
 */
export async function completeEnrolment(user, code, { now = Date.now() } = {}) {
  const s = await db.totp.getSecrets(user.userId);
  if (s?.enrolled) throw ALREADY_ENROLLED();
  if (!s?.pendingSecretEnc || !s.pendingLive) throw SETUP_EXPIRED();
  const step = matchStep(base32Decode(decryptField(s.pendingSecretEnc)), code, now);
  if (step === null) throw WRONG_CODE();
  const { codes, hashes } = await freshRecoveryCodes();
  const activated = await db.totp.activate(user.userId, {
    pendingSecretEnc: s.pendingSecretEnc, step, recoveryHashes: hashes,
  });
  if (!activated) throw SETUP_EXPIRED();
  return { recoveryCodes: codes };
}

// ── Sign-in ─────────────────────────────────────────────────────────────────

/**
 * Is this the account's second factor? A 6-digit code from the app, or one of
 * its recovery codes. Each is spent here, once.
 *
 * @returns {Promise<{method: 'otp'} | {method: 'recovery', recoveryCodesLeft: number}>}
 * @throws 401 TOTP_INVALID, 409 TOTP_NOT_ENROLLED
 */
export async function checkSignInCode(user, code, { now = Date.now() } = {}) {
  const s = await db.totp.getSecrets(user.userId);
  if (!s?.enrolled) throw NOT_ENROLLED();
  const typed = String(code ?? '').trim().replace(/\s+/g, '');

  if (/^\d{6}$/.test(typed)) {
    const step = matchStep(base32Decode(decryptField(s.secretEnc)), typed, now);
    if (step === null || !(await db.totp.claimCounter(user.userId, step))) throw WRONG_CODE();
    return { method: 'otp' };
  }

  const recovery = normaliseRecoveryCode(typed);
  if (!recovery) throw WRONG_CODE();
  // Every hash is checked, matched or not, so the time does not point at a slot.
  const results = await Promise.all(
    s.recoveryHashes.map((h) => verifyPassword(h, recovery).then((r) => r.valid).catch(() => false)),
  );
  const index = results.indexOf(true);
  if (index < 0) throw WRONG_CODE();
  const left = await db.totp.spendRecovery(user.userId, s.recoveryHashes[index]);
  if (left === null) throw WRONG_CODE();
  return { method: 'recovery', recoveryCodesLeft: left };
}

/**
 * Ten new recovery codes, replacing the old ones. Needs a current code from the
 * authenticator app (spent like a sign-in code), never a recovery code.
 */
export async function regenerateRecoveryCodes(user, code, { now = Date.now() } = {}) {
  const s = await db.totp.getSecrets(user.userId);
  if (!s?.enrolled) throw NOT_ENROLLED();
  const step = matchStep(base32Decode(decryptField(s.secretEnc)), String(code ?? '').trim(), now);
  if (step === null || !(await db.totp.claimCounter(user.userId, step))) throw WRONG_CODE();
  const { codes, hashes } = await freshRecoveryCodes();
  if (!(await db.totp.replaceRecovery(user.userId, hashes))) throw NOT_ENROLLED();
  return { recoveryCodes: codes };
}

/**
 * Forget an account's authenticator and end its sessions (an admin's reset;
 * the break-glass script calls the repository with a new password too).
 */
export async function resetEnrolment(userId) {
  return db.totp.reset(userId);
}
