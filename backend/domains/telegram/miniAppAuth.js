// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/telegram/miniAppAuth.js — what the Mini App sends, proved.
 *
 * The Mini App is a web page Telegram opens inside its own app. Telegram hands
 * that page two signed strings, and they are the ONLY things the server takes
 * from it on trust (Step 3, owner 2026-10-07):
 *
 *   • `initData` — who is holding the Mini App (`user`), when Telegram signed
 *     it (`auth_date`), and the deep-link parameter it was opened with
 *     (`start_param`), which is how a challenge, a reset or a referral reaches
 *     the page without anything the page could alter.
 *   • the CONTACT — what `WebApp.requestContact()` returns once the person
 *     taps "share". Its `response` string is signed exactly like `initData`
 *     and carries Telegram's own verified phone number for the account.
 *
 * Both are checked the way Telegram documents for Mini Apps: every field but
 * `hash`, sorted by key, joined `key=value` with a line feed; the key is
 * HMAC-SHA256 of the bot token under the constant "WebAppData"; the hex
 * HMAC-SHA256 of the joined string must equal `hash`. Compared in constant
 * time, because a byte-by-byte compare leaks how much of a forgery was right.
 *
 * ── What this module does NOT decide ───────────────────────────────────────
 * Freshness and signature, yes; whether this string was ALREADY USED, no. Use
 * is a fact about the database, so the single-use claim is a primary key in
 * `telegram_init_data_uses`, taken in the transaction that acts on it
 * (`database/repositories/telegram.js`). This module is pure: no I/O, no
 * clock but the one it is handed, so its tests need no bot and no network.
 */
import crypto from 'crypto';
import { normalisePhone } from '../identity/signupFields.js';

/**
 * How long after Telegram signed it a string is accepted, in seconds.
 * Five minutes: a person opening the Mini App, reading what it asks and
 * tapping once needs far less; a string lifted from somewhere has that long
 * at most, and once only.
 */
export const MAX_AGE_SECONDS = 300;
/** A device clock a little ahead of ours is not an attack; a minute is. */
export const FUTURE_SKEW_SECONDS = 30;

/** Why a string was refused. A caller maps these to its own codes. */
export const INIT_DATA_REFUSAL = Object.freeze({
  MALFORMED: 'malformed',
  BAD_SIGNATURE: 'bad_signature',
  STALE: 'stale',
  NO_USER: 'no_user',
});

/** The Mini App key: HMAC-SHA256(key = "WebAppData", message = bot token). */
function secretKeyFor(botToken) {
  return crypto.createHmac('sha256', 'WebAppData').update(String(botToken)).digest();
}

/**
 * The string Telegram signed, from a query string.
 *
 * URLSearchParams decodes each value, which is what Telegram hashes: the
 * DECODED pairs, not the percent-encoded transport form.
 */
function dataCheckString(params) {
  return [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Check one signed Mini App string and return its fields.
 *
 * @param {string} raw            the query string exactly as Telegram gave it
 * @param {object} opts
 * @param {string} opts.botToken  the one bot's token
 * @param {number} [opts.nowSeconds] the clock, in Unix seconds
 * @param {number} [opts.maxAgeSeconds]
 * @returns {{ok: true, params: URLSearchParams, hash: string, authDate: number}
 *          | {ok: false, reason: string}}
 */
function verifySigned(raw, { botToken, nowSeconds = Math.floor(Date.now() / 1000), maxAgeSeconds = MAX_AGE_SECONDS }) {
  if (!botToken) throw new Error('verifySigned requires the bot token');
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) {
    return { ok: false, reason: INIT_DATA_REFUSAL.MALFORMED };
  }
  let params;
  try { params = new URLSearchParams(raw); } catch { return { ok: false, reason: INIT_DATA_REFUSAL.MALFORMED }; }
  const hashes = params.getAll('hash');
  // Exactly one hash, of the right shape. Two would let a forger choose which
  // one a lenient parser reads.
  if (hashes.length !== 1 || !/^[0-9a-f]{64}$/.test(hashes[0])) {
    return { ok: false, reason: INIT_DATA_REFUSAL.MALFORMED };
  }
  // A key repeated is a string Telegram never produces, and the sort above
  // would sign it in an order an attacker picks.
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) return { ok: false, reason: INIT_DATA_REFUSAL.MALFORMED };

  const expected = crypto.createHmac('sha256', secretKeyFor(botToken))
    .update(dataCheckString(params)).digest();
  const given = Buffer.from(hashes[0], 'hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: INIT_DATA_REFUSAL.BAD_SIGNATURE };
  }

  // Checked AFTER the signature, so a forger learns nothing from which of the
  // two refusals they get.
  const authDate = Number(params.get('auth_date'));
  if (!Number.isInteger(authDate) || authDate <= 0) return { ok: false, reason: INIT_DATA_REFUSAL.MALFORMED };
  if (nowSeconds - authDate > maxAgeSeconds || authDate - nowSeconds > FUTURE_SKEW_SECONDS) {
    return { ok: false, reason: INIT_DATA_REFUSAL.STALE };
  }
  return { ok: true, params, hash: hashes[0], authDate };
}

/**
 * `Telegram.WebApp.initData`, proved.
 *
 * @returns {{ok: true, user: {id: string, username: string, firstName: string},
 *            startParam: string, authDate: number, hash: string, expiresAt: Date}
 *          | {ok: false, reason: string}}
 *   `expiresAt` is when this string stops being acceptable — what the
 *   single-use claim stores, so the row may be swept once it is worthless.
 */
export function verifyInitData(raw, opts) {
  const checked = verifySigned(raw, opts);
  if (!checked.ok) return checked;
  const user = safeJson(checked.params.get('user') || '');
  // The user is the whole point: an initData with no user (a Mini App opened
  // from an inline query in a group, for instance) names nobody to act for.
  if (!user || (typeof user.id !== 'number' && typeof user.id !== 'string') || !String(user.id).match(/^\d{1,20}$/)) {
    return { ok: false, reason: INIT_DATA_REFUSAL.NO_USER };
  }
  if (user.is_bot) return { ok: false, reason: INIT_DATA_REFUSAL.NO_USER };
  const maxAge = opts.maxAgeSeconds ?? MAX_AGE_SECONDS;
  return {
    ok: true,
    user: {
      id: String(user.id),
      username: String(user.username || ''),
      firstName: String(user.first_name || ''),
    },
    startParam: String(checked.params.get('start_param') || ''),
    authDate: checked.authDate,
    hash: checked.hash,
    expiresAt: new Date((checked.authDate + maxAge + FUTURE_SKEW_SECONDS) * 1000),
  };
}

/**
 * The contact `WebApp.requestContact()` returned, proved.
 *
 * The page sends the callback's `response` string (never `responseUnsafe`,
 * which is the same data with nothing to check it by).
 *
 * @returns {{ok: true, contact: {userId: string, phone: string|null},
 *            authDate: number, hash: string, expiresAt: Date}
 *          | {ok: false, reason: string}}
 */
export function verifyContact(raw, opts) {
  const checked = verifySigned(raw, opts);
  if (!checked.ok) return checked;
  const contact = safeJson(checked.params.get('contact') || '');
  if (!contact || !String(contact.user_id ?? '').match(/^\d{1,20}$/) || !contact.phone_number) {
    return { ok: false, reason: INIT_DATA_REFUSAL.MALFORMED };
  }
  const maxAge = opts.maxAgeSeconds ?? MAX_AGE_SECONDS;
  return {
    ok: true,
    contact: {
      userId: String(contact.user_id),
      // The same normaliser the signup form uses (signupFields.js), so the
      // form's `9876543210` and Telegram's `+919876543210` are one number.
      phone: normalisePhone(contact.phone_number),
    },
    authDate: checked.authDate,
    hash: checked.hash,
    expiresAt: new Date((checked.authDate + maxAge + FUTURE_SKEW_SECONDS) * 1000),
  };
}
