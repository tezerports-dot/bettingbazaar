// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * identity.js — revoked tokens, and the signup that creates a player account.
 *
 * ── No identity data is collected ───────────────────────────────────────────
 * KYC (the Aadhaar number, its hash and ciphertext, the verification queue)
 * was removed 2026-10-02 (owner). An account is a mobile and a password; the
 * Telegram contact share proves the mobile belongs to its holder.
 *
 * ── Expiry is enforced by the read ───────────────────────────────────────────
 * `isTokenRevoked` filters on `expires_at`, and `sweepExpired` only reclaims
 * space. A revoked token must not become valid again because a cron job was
 * late — which is exactly what would happen if the read trusted the sweep.
 */
import { pgQuery } from '../client.js';

// ── Revoked tokens ───────────────────────────────────────────────────────────

/**
 * Revoke a token until it would have expired anyway.
 *
 * Idempotent: revoking twice is not an error, and a sign-out that is retried
 * must not fail. The token itself is the primary key, so this is one index
 * probe on a path every authenticated request takes.
 */
export async function revokeToken(token, { ttlSeconds = 86_400 } = {}) {
  if (!token) throw new Error('revokeToken requires a token');
  await pgQuery(
    `INSERT INTO token_blacklist (token, expires_at)
     VALUES ($1, now() + ($2 || ' seconds')::interval)
     ON CONFLICT (token) DO NOTHING`,
    [String(token), String(ttlSeconds)], 'token_revoke',
  );
}

/**
 * Has this token been revoked?
 *
 * Checked on EVERY authenticated request, so it is a primary-key lookup and
 * nothing more. The `expires_at` filter is what makes the sweep optional rather
 * than load-bearing.
 */
export async function isTokenRevoked(token) {
  if (!token) return false;
  const { rows } = await pgQuery(
    `SELECT 1 FROM token_blacklist WHERE token = $1 AND expires_at > now()`,
    [String(token)], 'token_is_revoked',
  );
  return rows.length > 0;
}

/** Reclaim expired revocations. Space only — `isTokenRevoked` decides validity. */
export async function sweepExpired() {
  const { rowCount } = await pgQuery(
    `DELETE FROM token_blacklist WHERE expires_at <= now()`, [], 'token_sweep');
  return { revokedTokens: rowCount ?? 0 };
}


/**
 * Create an account from the SIGNUP FORM, before Telegram has met the person.
 *
 * The account exists BEFORE Telegram is involved; the contact share later
 * proves the mobile is theirs (`linkTelegramToAccount`). The unique index on
 * `(mobile, account_type)` refuses a second player account for one number —
 * that is the guarantee, and the route's read before this is only a courtesy
 * that produces the right sentence.
 */
export async function createAccountFromSignup({
  userId, username, mobile, passwordHash,
  referralCode = null, referredBy = null,
}) {
  if (!userId || !mobile) throw new Error('createAccountFromSignup requires a userId and a mobile');
  if (!passwordHash) throw new Error('createAccountFromSignup requires a passwordHash — the form sets one');

  try {
    // 'PLAYER', stated rather than defaulted. This is the one writer of a
    // player account and the type decides which door can ever read it back.
    const { rows } = await pgQuery(
      `INSERT INTO users (user_id, username, mobile, password_hash, referral_code,
                          referred_by, status, account_type)
       VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', 'PLAYER')
       ON CONFLICT (mobile, account_type) DO NOTHING
       RETURNING user_id`,
      [String(userId), username || `player${String(mobile).slice(-4)}`, String(mobile),
       String(passwordHash), referralCode, referredBy ? String(referredBy) : null],
      'identity_signup',
    );
    if (!rows[0]) return { ok: false, reason: 'mobile_taken' };
    return { ok: true, userId: String(userId) };
  } catch (e) {
    if (e?.code === '23505') {
      if (e.constraint === 'users_mobile_per_account_type') return { ok: false, reason: 'mobile_taken' };
      return { ok: false, reason: 'duplicate' };
    }
    throw e;
  }
}
