// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * repositories/totp.js — the STAFF authenticator's rows (`staff_totp`), and the
 * one writer of them (owner, 2026-10-13: staff sign in with mobile, password
 * and an authenticator app; no Telegram).
 *
 * What is stored is ciphertext and hashes only: the secret is encrypted by the
 * caller (`encryptField`) before it reaches here, and a recovery code arrives
 * as its argon2id hash. Nothing here sees a code or a plain secret.
 *
 * ── Every "once" is an UPDATE's WHERE (§32 S6) ─────────────────────────────
 *   a 30-second step     `claimCounter`: `last_counter < $step`, so a replayed
 *                        code, an older code, or the second of two identical
 *                        codes arriving together updates no row.
 *   a recovery code      `spendRecovery`: the hash must still be in the array
 *                        the same statement removes it from.
 *   an enrolment         `activate`: the pending ciphertext the code was
 *                        checked against must still be the pending one, and
 *                        fresh by the DATABASE clock.
 */
import { pgQuery, withTransaction } from '../client.js';

/** How long a pending (scanned, not yet confirmed) secret stays usable. */
export const PENDING_TTL_SECONDS = 30 * 60;

const asCount = (v) => (v == null ? 0 : Number(v));

/**
 * What an account's authenticator looks like, without any secret: what the
 * admin panel's Account screen and the Sub-admins list render.
 */
export async function getState(userId) {
  const { rows } = await pgQuery(
    `SELECT enrolled_at, recovery_generated_at,
            jsonb_array_length(recovery_hashes) AS recovery_left
       FROM staff_totp WHERE user_id = $1`,
    [String(userId)], 'totp_state',
  );
  const r = rows[0];
  return {
    enrolled: Boolean(r?.enrolled_at),
    enrolledAt: r?.enrolled_at ?? null,
    recoveryCodesLeft: r?.enrolled_at ? asCount(r.recovery_left) : 0,
    recoveryGeneratedAt: r?.recovery_generated_at ?? null,
  };
}

/**
 * The ciphertexts and the recovery hashes, for the service that checks a code.
 * `pendingLive` is the pending secret's age judged by the database clock.
 */
export async function getSecrets(userId) {
  const { rows } = await pgQuery(
    `SELECT secret_enc, pending_secret_enc, last_counter, enrolled_at, recovery_hashes,
            (pending_at IS NOT NULL
              AND pending_at > now() - make_interval(secs => $2)) AS pending_live
       FROM staff_totp WHERE user_id = $1`,
    [String(userId), PENDING_TTL_SECONDS], 'totp_secrets',
  );
  const r = rows[0];
  if (!r) return null;
  return {
    secretEnc: r.secret_enc,
    pendingSecretEnc: r.pending_secret_enc,
    pendingLive: r.pending_live === true,
    lastCounter: r.last_counter == null ? null : Number(r.last_counter),
    enrolled: Boolean(r.enrolled_at),
    recoveryHashes: Array.isArray(r.recovery_hashes) ? r.recovery_hashes : [],
  };
}

/**
 * Store a new pending secret (the QR the person is about to scan). Refused —
 * `null` — for an account that is already enrolled: only an admin's reset or
 * the break-glass script replaces a secret. A non-STAFF account is refused by
 * the row's foreign key and CHECK.
 */
export async function savePending(userId, pendingSecretEnc) {
  const { rows } = await pgQuery(
    `INSERT INTO staff_totp (user_id, pending_secret_enc, pending_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE
        SET pending_secret_enc = EXCLUDED.pending_secret_enc, pending_at = now(), updated_at = now()
      WHERE staff_totp.secret_enc IS NULL
     RETURNING user_id`,
    [String(userId), String(pendingSecretEnc)], 'totp_save_pending',
  );
  return rows[0] ? { ok: true } : null;
}

/**
 * Turn the pending secret into the account's secret, with its first step
 * spent and its recovery codes, in one statement. True when it took.
 *
 * @param {string} userId
 * @param {object} o
 * @param {string} o.pendingSecretEnc  the ciphertext the code was checked
 *        against — a second setup in between replaced it, and this refuses
 * @param {number} o.step              the 30-second step the code matched
 * @param {string[]} o.recoveryHashes  argon2id hashes of the 10 codes
 */
export async function activate(userId, { pendingSecretEnc, step, recoveryHashes }) {
  const { rowCount } = await pgQuery(
    `UPDATE staff_totp
        SET secret_enc = pending_secret_enc, pending_secret_enc = NULL, pending_at = NULL,
            enrolled_at = now(), last_counter = $3,
            recovery_hashes = $4::jsonb, recovery_generated_at = now(), updated_at = now()
      WHERE user_id = $1 AND secret_enc IS NULL AND pending_secret_enc = $2
        AND pending_at > now() - make_interval(secs => $5)`,
    [String(userId), String(pendingSecretEnc), step, JSON.stringify(recoveryHashes), PENDING_TTL_SECONDS],
    'totp_activate',
  );
  return rowCount === 1;
}

/**
 * Spend one 30-second step. True exactly once per step, and never for a step
 * at or below the last one accepted.
 */
export async function claimCounter(userId, step) {
  const { rowCount } = await pgQuery(
    `UPDATE staff_totp SET last_counter = $2, updated_at = now()
      WHERE user_id = $1 AND secret_enc IS NOT NULL
        AND (last_counter IS NULL OR last_counter < $2)`,
    [String(userId), step], 'totp_claim_counter',
  );
  return rowCount === 1;
}

/**
 * Spend one recovery code by its stored hash. The number left, or null when
 * that hash was not there to spend (already used, or a race lost).
 */
export async function spendRecovery(userId, hash) {
  const { rows } = await pgQuery(
    `UPDATE staff_totp
        SET recovery_hashes = recovery_hashes - $2::text, updated_at = now()
      WHERE user_id = $1 AND secret_enc IS NOT NULL AND recovery_hashes ? $2::text
      RETURNING jsonb_array_length(recovery_hashes) AS left_count`,
    [String(userId), String(hash)], 'totp_spend_recovery',
  );
  return rows[0] ? asCount(rows[0].left_count) : null;
}

/** Replace every recovery code (an enrolled account only). True when it took. */
export async function replaceRecovery(userId, recoveryHashes) {
  const { rowCount } = await pgQuery(
    `UPDATE staff_totp
        SET recovery_hashes = $2::jsonb, recovery_generated_at = now(), updated_at = now()
      WHERE user_id = $1 AND secret_enc IS NOT NULL`,
    [String(userId), JSON.stringify(recoveryHashes)], 'totp_replace_recovery',
  );
  return rowCount === 1;
}

/**
 * Forget a STAFF account's authenticator and end every session it holds, in
 * one transaction: the next sign-in enrols again. With `passwordHash` (the
 * break-glass script) the password is replaced in the same transaction.
 *
 * @returns {Promise<{ok: boolean, hadAuthenticator: boolean}>} `ok` false when
 *          no STAFF account has this id
 */
export async function reset(userId, { passwordHash = null } = {}) {
  return withTransaction(async (client) => {
    const { rowCount: moved } = await client.query(
      `UPDATE users
          SET sessions_valid_from = now(),
              password_hash = COALESCE($2, password_hash),
              updated_at = now()
        WHERE user_id = $1 AND account_type = 'STAFF'`,
      [String(userId), passwordHash],
    );
    if (moved !== 1) return { ok: false, hadAuthenticator: false };
    const { rowCount } = await client.query(
      'DELETE FROM staff_totp WHERE user_id = $1', [String(userId)],
    );
    return { ok: true, hadAuthenticator: rowCount === 1 };
  });
}

/** Which of these accounts have finished enrolling. */
export async function enrolledAmong(userIds) {
  const ids = (userIds || []).map(String);
  if (!ids.length) return new Set();
  const { rows } = await pgQuery(
    `SELECT user_id FROM staff_totp WHERE user_id = ANY($1::text[]) AND enrolled_at IS NOT NULL`,
    [ids], 'totp_enrolled_among',
  );
  return new Set(rows.map((r) => r.user_id));
}
