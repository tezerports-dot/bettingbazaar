// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/identity/verifySecondFactor.js — check an OTP or a recovery code.
 *
 * Shared by the player/admin login (User model) and the merchant login
 * (Merchant model). They are different collections but hold identically named
 * 2FA fields, so this works against either document rather than being written
 * twice and drifting.
 *
 * ── Why the replay guard lives here and not in totp.service ───────────────
 * A TOTP code is valid for its whole 30-second step PLUS the ±1 step of clock
 * drift the verifier allows — so the same six digits are accepted for up to 90
 * seconds. That is exactly the window a shoulder-surfed, phished, or
 * network-observed code needs to be replayed by someone else. totp.service
 * can detect it (it returns the counter a code matched) but cannot prevent it,
 * because preventing it means remembering the highest counter already spent —
 * i.e. writing to the account document. That write is this module's job.
 *
 * The guard is strictly monotonic: a code at or below `twoFactorLastCounter`
 * is refused even though it is cryptographically valid. One consequence worth
 * knowing: a user who legitimately logs in twice inside the same 30-second
 * step must wait for the next code. That is the correct trade — the
 * alternative is accepting replays.
 *
 * ── Recovery codes ────────────────────────────────────────────────────────
 * Single-use, stored only as hashes, consumed by removing the matched hash.
 * Checked only after the TOTP path fails, so a working authenticator never
 * burns one.
 */
import { verifyToken, consumeBackupCode, decryptSecret } from './totp.service.js';

/** Shapes of failure a caller may want to distinguish in its response. */
export const SECOND_FACTOR_RESULT = {
  OK: 'OK',
  INVALID: 'INVALID',
  NOT_ENROLLED: 'NOT_ENROLLED',
  MALFORMED_SECRET: 'MALFORMED_SECRET',
};

/**
 * Verify `code` against `doc`'s enrolled second factor and persist the
 * anti-replay state. Mutates and SAVES the document on success.
 *
 * @param {mongoose.Document} doc   A User or Merchant with 2FA fields selected
 *                                  (+twoFactorSecret +twoFactorLastCounter
 *                                  +backupCodes) — all are `select: false`, so
 *                                  a caller that forgets them gets
 *                                  NOT_ENROLLED rather than a wrong answer.
 * @param {string} code             6-digit OTP or a recovery code.
 * @returns {Promise<{ ok: boolean, result: string, usedBackupCode?: boolean,
 *                     backupCodesRemaining?: number }>}
 */
export async function verifySecondFactor(doc, code) {
  if (!doc?.twoFactorEnabled || !doc.twoFactorSecret) {
    return { ok: false, result: SECOND_FACTOR_RESULT.NOT_ENROLLED };
  }
  const submitted = String(code || '').trim();
  if (!submitted) return { ok: false, result: SECOND_FACTOR_RESULT.INVALID };

  let secret;
  try {
    secret = decryptSecret(doc.twoFactorSecret);
  } catch {
    // Undecryptable secret — almost always a rotated/incorrect
    // TOTP_ENCRYPTION_KEY. Distinct from a wrong code: nothing the user types
    // can succeed, so the caller should surface an operator-facing error
    // rather than "invalid code" forever.
    return { ok: false, result: SECOND_FACTOR_RESULT.MALFORMED_SECRET };
  }

  // ── Path 1: a live authenticator code ────────────────────────────────────
  const verdict = verifyToken({
    secret,
    token: submitted,
    lastCounter: doc.twoFactorLastCounter ?? null,
  });
  if (verdict.valid) {
    doc.twoFactorLastCounter = verdict.counter;   // spend it — no replay
    await doc.save();
    return { ok: true, result: SECOND_FACTOR_RESULT.OK, usedBackupCode: false };
  }

  // ── Path 2: a single-use recovery code ───────────────────────────────────
  // Only reached when the OTP did not verify, so an intact authenticator
  // never consumes one by accident.
  const stored = doc.backupCodes || [];
  if (stored.length) {
    const consumed = consumeBackupCode(submitted, stored);
    if (consumed.valid) {
      doc.backupCodes = consumed.remaining;
      await doc.save();
      return {
        ok: true,
        result: SECOND_FACTOR_RESULT.OK,
        usedBackupCode: true,
        backupCodesRemaining: consumed.remaining.length,
      };
    }
  }

  return { ok: false, result: SECOND_FACTOR_RESULT.INVALID };
}
