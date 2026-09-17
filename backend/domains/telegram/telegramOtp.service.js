// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/telegram/telegramOtp.service.js — signing in without leaving the site.
 *
 * ── What changed, and what did not ──────────────────────────────────────────
 * Signing up still happens in the bot, once: it is the contact share that
 * proves the phone number, and Telegram's verified number is the whole reason
 * this platform can treat a Telegram message as a second factor at all. A bot
 * also simply cannot message somebody who has never started a chat with it, so
 * there is no version of a first signup that avoids the trip.
 *
 * Every login AFTER that is on-site (owner decision 2026-09-08): the player
 * types their mobile, the bot DMs a six-digit code, they type it back. No
 * redirect, no app switch, no link to click.
 *
 * ── The properties that make six digits safe ────────────────────────────────
 * A short numeric code is only as good as what surrounds it, so:
 *
 *   - HASHED at rest, both the code and the MOBILE. A phone number is a
 *     ten-digit space, so a plain digest of one is reversible by enumeration in
 *     seconds — this table would otherwise be a list of every player's number
 *     next to a live credential. Both use HMAC with a server secret, which an
 *     attacker holding only a database dump does not have.
 *   - SINGLE USE, enforced by the atomic UPDATE that redeems it rather than by
 *     a read-then-write two requests fit between.
 *   - FIVE ATTEMPTS, counted in the same statement. Unbounded, 10^6 falls to a
 *     script; at five it is 1-in-200000 and the row burns itself at the cap.
 *   - MINUTES, checked by the READ so a late sweep can never revive one.
 *   - MATCHED ON THE KYC NUMBER. The mobile typed is compared to `users.mobile`
 *     — the number captured at signup, immutable, and the one the Aadhaar is
 *     against. NOT to the linked Telegram account's own number, which account
 *     recovery rewrites. Delivery goes to the active identity; identification
 *     does not.
 *   - PACED. `loginPaceLimiter` allows one request per 10 seconds per actor,
 *     which is what stops the request endpoint being used to spam a player's
 *     Telegram with codes they did not ask for.
 *
 * ── And the property that is not about the code ─────────────────────────────
 * The request endpoint answers IDENTICALLY whether or not the number belongs to
 * anybody. A login form that says "no such account" is a way to test whether a
 * given person gambles here, and that is not a thing this platform should
 * answer to anyone who can type a phone number.
 */
import crypto from 'crypto';
import { db } from '#db';
import { sendMessage } from './telegramClient.js';
import { normalisePhone } from './telegramOnboarding.service.js';

/** Short enough that a code read over a shoulder is usually already dead. */
const TTL_MS = Number(process.env.TELEGRAM_OTP_TTL_MS || 5 * 60 * 1000);
const MAX_ATTEMPTS = Number(process.env.TELEGRAM_OTP_MAX_ATTEMPTS || 5);

/**
 * The secret both hashes are keyed with.
 *
 * Falls back to JWT_SECRET the way ORDER_HMAC_SECRET does — key separation is
 * better, but a deployment that has set neither must fail LOUDLY here rather
 * than degrade. Unlike the order tag, this is not optional tamper-evidence: an
 * unkeyed hash of a phone number is a phone number, so there is nothing safe to
 * fall back to.
 */
function secret() {
  const s = process.env.TELEGRAM_OTP_SECRET || process.env.ORDER_HMAC_SECRET || process.env.JWT_SECRET;
  if (!s) throw new Error('telegramOtp: TELEGRAM_OTP_SECRET, ORDER_HMAC_SECRET or JWT_SECRET must be set');
  return s;
}

const tag = (label, value) =>
  crypto.createHmac('sha256', secret()).update(`${label}:${value}:v1`).digest('hex');

/**
 * ONE owner for "what is this phone number, really".
 *
 * This file had its own digits-only version, and the two disagreed the moment
 * anybody typed a country code: `+91 98765 43210` normalised to twelve digits
 * here and to the ten-digit subscriber number at signup, so the lookup matched
 * nothing and the player was told a code had been sent that was never minted.
 * A silent failure with no error anywhere — the exact shape §1 exists to
 * prevent. `normalisePhone` is the owner; this module imports it.
 */

/**
 * Six digits from a CSPRNG.
 *
 * `randomInt` and not `Math.random()`, and not `randomBytes % 1000000` either:
 * the modulo of 2^n by 10^6 is not uniform, and the low codes would come up
 * measurably more often — which is exactly the bias a guesser starts from.
 */
function mintCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Send a sign-in code, if that number belongs to a live linked account.
 *
 * @returns {Promise<{sent: boolean}>} — `sent` is for LOGS and tests, never for
 *   a response body. The route reports the same thing either way.
 */
export async function requestLoginCode(mobile) {
  const digits = normalisePhone(mobile);
  // 6–15 digits covers every E.164 national number. A blank or absurd input is
  // not worth a database round trip.
  if (!digits || digits.length < 6 || digits.length > 15) return { sent: false, reason: 'malformed' };

  // Matched on the KYC-linked `users.mobile`, NOT on the number the linked
  // Telegram account happens to carry (owner rule 2026-09-08). After an account
  // recovery those diverge, and keying on the Telegram number would let someone
  // sign in with a number that was never verified against their identity.
  const target = await db.telegram.getLoginTargetByMobile(digits);
  if (!target) return { sent: false, reason: 'unlinked' };

  // A blocked account is refused HERE, before a code is minted or sent. Letting
  // it through to the verify step would tell a blocked player their credentials
  // still work, and would send them a code that can never be redeemed.
  const user = await db.users.getUser(target.userId);
  if (!user || user.isBlocked || user.status === 'BLOCKED' || user.status === 'DELETED') {
    return { sent: false, reason: 'not_eligible' };
  }

  const code = mintCode();
  const { expiresAt } = await db.telegram.issueLoginCode({
    mobileHash: tag('mobile', digits),
    codeHash: tag('code', `${digits}:${code}`),
    userId: target.userId,
    telegramUserId: target.telegramUserId,
    ttlSeconds: Math.max(1, Math.round(TTL_MS / 1000)),
  });

  const minutes = Math.max(1, Math.round(TTL_MS / 60000));
  const res = await sendMessage(target.telegramUserId,
    `<b>${code}</b> is your sign-in code.\n\n`
    + `It expires in ${minutes} minute${minutes === 1 ? '' : 's'} and can be used once.\n\n`
    + 'If you did not ask to sign in, ignore this message — nobody can use the '
    + 'code without it. We will never ask you to forward it to anyone.');

  // The row is left in place on a delivery failure rather than deleted. The
  // player may still receive it (Telegram's API reporting an error does not
  // prove nothing was delivered), and deleting it would let the next request
  // mint a second live code for the same number.
  if (!res?.ok) console.error('[telegram-otp] code not delivered:', res?.error || 'unknown');

  return { sent: Boolean(res?.ok), expiresAt };
}

/**
 * Redeem a code.
 *
 * @returns {Promise<{userId: string}|null>} — null for wrong, expired, unknown,
 *   already used, or out of attempts. The caller must not distinguish them.
 */
export async function verifyLoginCode(mobile, code) {
  const digits = normalisePhone(mobile);
  const typed = String(code || '').replace(/\D/g, '');
  if (!digits || typed.length !== 6) return null;

  const consumed = await db.telegram.consumeLoginCode({
    mobileHash: tag('mobile', digits),
    codeHash: tag('code', `${digits}:${typed}`),
    maxAttempts: MAX_ATTEMPTS,
  });
  if (!consumed) return null;

  // Re-checked against the ROW, not carried from the request that issued the
  // code. An account blocked in the five minutes between the two steps must not
  // get a session out of a code minted while it was still live.
  const user = await db.users.getUser(consumed.userId);
  if (!user || user.isBlocked || user.status === 'BLOCKED' || user.status === 'DELETED') return null;

  return { userId: consumed.userId, telegramUserId: consumed.telegramUserId };
}
