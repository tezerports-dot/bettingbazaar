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
 *   - minutes-long lifetime, swept by a TTL index;
 *   - stored as a hash, so a database dump yields nothing redeemable;
 *   - bound to the Telegram account it was issued for.
 */
import crypto from 'crypto';
import { TelegramLoginToken } from './telegram.model.js';

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
  const expiresAt = new Date(Date.now() + TTL_MS);

  await TelegramLoginToken.create({
    tokenHash: hashToken(token),
    telegramUserId: String(telegramUserId),
    userId,
    expiresAt,
  });

  const root = String(baseUrl || process.env.PUBLIC_APP_ORIGIN || '').replace(/\/+$/, '');
  return { token, url: `${root}/auth/telegram?token=${token}`, expiresAt };
}

/**
 * Redeem a token, exactly once.
 *
 * The single-use guarantee is the `consumedAt: null` filter inside
 * findOneAndUpdate: two simultaneous redemptions of the same link both run the
 * update, and only one matches a document. Reading the row first and then
 * marking it used would leave a window where both requests see it unconsumed —
 * the same TOCTOU shape as the withdrawal bug removed from this codebase.
 *
 * @returns {Promise<{ok: true, userId, telegramUserId} | {ok: false, reason: string}>}
 */
export async function redeemLoginToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return { ok: false, reason: 'missing' };

  const claimed = await TelegramLoginToken.findOneAndUpdate(
    {
      tokenHash: hashToken(rawToken),
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    },
    { $set: { consumedAt: new Date() } },
    { new: true },
  ).lean();

  // One answer for "never existed", "already used" and "expired". Telling them
  // apart would let someone with a stolen link learn whether it was ever valid.
  if (!claimed) return { ok: false, reason: 'invalid_or_used' };

  return { ok: true, userId: claimed.userId, telegramUserId: claimed.telegramUserId };
}
