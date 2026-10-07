// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * tests/miniAppFixture.js — sign Mini App strings the way Telegram does.
 *
 * Tests never reach Telegram and never hold a real bot token (Step 3 brief).
 * They sign `initData` and contacts with their OWN obviously-fake token, the
 * algorithm `miniAppAuth.js` verifies: every field but `hash`, sorted, joined
 * `key=value` by a line feed, HMAC-SHA256 keyed by
 * HMAC-SHA256("WebAppData", token).
 *
 * `saveTestBot` stores that token as the platform's one bot through the
 * repository — the admin route would ask Telegram's `getMe`, which a test must
 * not do — and drops the client's cache so the next request reads it.
 */
import crypto from 'crypto';

/** A token shaped like a real one and valid for nothing. */
export const TEST_BOT_TOKEN = '7000000001:TEST-only-token-never-a-real-bot_0123456789';
export const TEST_BOT = { botId: '7000000001', username: 'bb_test_miniapp_bot' };

function sign(fields, token) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    params.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * `Telegram.WebApp.initData` for one Telegram user.
 * @param {object} o
 * @param {string|number} o.telegramUserId
 * @param {string} [o.startParam]
 * @param {number} [o.authDate]  Unix seconds; default now
 * @param {string} [o.token]
 * @param {string} [o.queryId]   distinguishes two otherwise identical strings
 */
export function signInitData({
  telegramUserId, startParam, authDate = nowSeconds(), token = TEST_BOT_TOKEN,
  username = 'tester', firstName = 'Test', queryId = crypto.randomBytes(8).toString('hex'),
}) {
  return sign({
    query_id: queryId,
    user: { id: Number(telegramUserId), first_name: firstName, username, language_code: 'en' },
    auth_date: authDate,
    start_param: startParam,
  }, token);
}

/** The signed `response` string `WebApp.requestContact()` hands the page. */
export function signContact({
  telegramUserId, phone, authDate = nowSeconds(), token = TEST_BOT_TOKEN,
}) {
  return sign({
    contact: { user_id: Number(telegramUserId), phone_number: String(phone), first_name: 'Test' },
    auth_date: authDate,
  }, token);
}

/** A fresh, never-used Telegram user id for one test. */
export function freshTelegramUserId() {
  return String(5_000_000_000 + crypto.randomInt(0, 999_999_999));
}
