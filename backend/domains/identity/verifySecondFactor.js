// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/identity/verifySecondFactor.js — check an OTP or a recovery code.
 *
 * Shared by the staff login and the merchant login. They are different tables
 * holding identically named 2FA columns, so this is written once and given the
 * two writes it needs, rather than written twice and left to drift.
 *
 * ── Why the replay guard lives here and not in totp.service ───────────────
 * A TOTP code is valid for its whole 30-second step PLUS the ±1 step of clock
 * drift the verifier allows — so the same six digits are accepted for up to 90
 * seconds. That is exactly the window a shoulder-surfed, phished, or
 * network-observed code needs to be replayed by someone else. totp.service
 * can detect it (it returns the counter a code matched) but cannot prevent it,
 * because preventing it means remembering the highest counter already spent —
 * a write against the account. Arranging that write is this module's job.
 *
 * The guard is strictly monotonic: a code at or below `twoFactorLastCounter`
 * is refused even though it is cryptographically valid. One consequence worth
 * knowing: a user who legitimately logs in twice inside the same 30-second
 * step must wait for the next code. That is the correct trade — the
 * alternative is accepting replays.
 *
 * ── The write is CONDITIONAL, and that is the whole guard ──────────────────
 * This module used to set the counter on the object it was handed and call
 * `.save()`. That is a read-modify-write: two submissions of the same code
 * inside the drift window both read the old counter, both pass the comparison
 * in JavaScript, and both save — so the replay guard failed in exactly the
 * situation it exists for, because a replay IS concurrent. The comparison is
 * now in the UPDATE's WHERE clause, and `spend` reports whether this call was
 * the one that won. A code that verifies but loses the race is refused.
 *
 * The same applies to a recovery code: consuming it is a compare-and-swap on
 * the stored list, so two redemptions of one code yield one success.
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
 * Verify `code` against an account's enrolled second factor, and spend it.
 *
 * @param {object} creds  The account's CREDENTIALS — `getUserCredentials` or
 *                        `getMerchantCredentials`. The ordinary account read
 *                        deliberately omits these columns, so a caller that
 *                        passes the plain account object gets NOT_ENROLLED
 *                        rather than a wrong answer.
 * @param {string} code   6-digit OTP or a recovery code.
 * @param {{spendCounter: (counter:number)=>Promise<boolean>,
 *          consumeBackupCode: (arg:{expected:string[], remaining:string[]})=>Promise<boolean>}} store
 *                        The two conditional writes, bound to this account.
 *                        Passed in rather than imported so one implementation
 *                        serves both tables without knowing either.
 * @returns {Promise<{ ok: boolean, result: string, usedBackupCode?: boolean,
 *                     backupCodesRemaining?: number }>}
 */
export async function verifySecondFactor(creds, code, store) {
  const doc = creds;
  if (!doc?.twoFactorEnabled || !doc.twoFactorSecret) {
    return { ok: false, result: SECOND_FACTOR_RESULT.NOT_ENROLLED };
  }
  if (!store?.spendCounter || !store?.consumeBackupCode) {
    throw new Error('verifySecondFactor requires a store with spendCounter and consumeBackupCode');
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
    // Spending it is the verification. A code that verifies cryptographically
    // but loses the race to spend the counter has been used already, and is
    // refused as INVALID — the same answer a replayed code deserves.
    const spent = await store.spendCounter(verdict.counter);
    if (!spent) return { ok: false, result: SECOND_FACTOR_RESULT.INVALID };
    return { ok: true, result: SECOND_FACTOR_RESULT.OK, usedBackupCode: false };
  }

  // ── Path 2: a single-use recovery code ───────────────────────────────────
  // Only reached when the OTP did not verify, so an intact authenticator
  // never consumes one by accident.
  const stored = doc.backupCodes || [];
  if (stored.length) {
    const consumed = consumeBackupCode(submitted, stored);
    if (consumed.valid) {
      // Compare-and-swap against the list we verified against, so a code
      // redeemed twice concurrently is spent once.
      const took = await store.consumeBackupCode({
        expected: stored, remaining: consumed.remaining,
      });
      if (!took) return { ok: false, result: SECOND_FACTOR_RESULT.INVALID };
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
