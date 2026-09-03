// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/telegram/telegramLogin.service.js — one-time login links.
 *
 * Players never type a password, so the bot has to hand the browser something
 * it can trade for a session. That something travels through a Telegram chat,
 * which means it can be screenshotted, forwarded, or read over a shoulder — so
 * it is built to be worth as little as possible for as short a time as possible:
 *
 *   - single use, enforced by the atomic update that redeems it, not by a
 *     read-then-write a second request could interleave with;
 *   - minutes-long lifetime, enforced by the READ — every redemption filters on
 *     expiry, so the sweep that reclaims the rows only reclaims space and a
 *     late sweep can never make a stale token redeemable;
 *   - stored as a hash, so a database dump yields nothing redeemable;
 *   - bound to the Telegram account it was issued for.
 */
import crypto from 'crypto';
import { db } from '#db';

/** Short enough that a forwarded link is usually already dead. */
const TTL_MS = Number(process.env.TELEGRAM_LOGIN_TTL_MS || 5 * 60 * 1000);

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

/**
 * Mint a login link for an established identity.
 *
 * @returns {Promise<{token: string, url: string, expiresAt: Date}>}
 */
export async function issueLoginToken({ userId, telegramUserId, baseUrl }) {
  // 32 bytes of CSPRNG. base64url so it survives a URL and a chat client's
  // link detection without escaping.
  const token = crypto.randomBytes(32).toString('base64url');

  const issued = await db.telegram.issueLoginToken({
    tokenHash: hashToken(token),
    telegramUserId,
    userId,
    ttlSeconds: Math.max(1, Math.round(TTL_MS / 1000)),
  });

  // The token rides in the FRAGMENT, not the query string. A fragment is never
  // sent to the server, so the one credential in this link stays out of access
  // logs, out of any reverse proxy's request log, and out of the Referer header
  // the browser attaches to whatever the page loads next. The panel is a
  // HashRouter, so this is also just its ordinary route form.
  const root = String(baseUrl || process.env.PUBLIC_APP_ORIGIN || '').replace(/\/+$/, '');
  // The expiry the ROW carries, not the one computed here. The database
  // stamps it from its own clock, and that is the one the redemption is
  // checked against — quoting a locally computed time would tell the player
  // a deadline the gate does not use.
  return { token, url: `${root}/#/auth/telegram?token=${token}`, expiresAt: issued.expiresAt };
}

/**
 * Redeem a token, exactly once.
 *
 * The single-use guarantee is the `consumed_at IS NULL` clause inside the
 * UPDATE that redeems it: two simultaneous redemptions of the same link both
 * run the statement, and only one matches a row. Reading the row first and then
 * marking it used would leave a window where both requests see it unconsumed —
 * the same TOCTOU shape as the withdrawal bug removed from this codebase.
 *
 * @returns {Promise<{ok: true, userId, telegramUserId} | {ok: false, reason: string}>}
 */
export async function redeemLoginToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return { ok: false, reason: 'missing' };

  const claimed = await db.telegram.consumeLoginToken({ tokenHash: hashToken(rawToken) });

  // One answer for "never existed", "already used" and "expired". Telling them
  // apart would let someone with a stolen link learn whether it was ever valid.
  if (!claimed) return { ok: false, reason: 'invalid_or_used' };

  return { ok: true, userId: claimed.userId, telegramUserId: claimed.telegramUserId };
}
