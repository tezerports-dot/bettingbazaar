// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/telegram/telegramClient.js — the one bot, and the Bot API.
 *
 * Step 3 (owner, 2026-10-07) left ONE bot: it carries the Mini App that
 * verifies every account, approves staff and merchant sign-ins, signs players
 * in with "Login with Telegram" and resets passwords, and it sends staff their
 * security alerts. There is no fleet, no channel, no recovery bot, no webhook.
 *
 * ── Why the bot is read per call, through a short cache ───────────────────
 * Telegram suspends gambling bots, so an admin replaces the token at runtime
 * (PUT /api/admin/telegram/bot). A module that captured the token at import
 * would need a restart to follow the swap. `miniAppBot()` reads the one row and
 * keeps it for `BOT_TTL_MS`; the admin route drops the cache on the instance
 * that saved, and the other instances follow within the window (stated in
 * CLAUDE.md §2, "Live bot").
 *
 * ── Failure posture ─────────────────────────────────────────────────────────
 * Telegram is a third party and will be unreachable sometimes. `callApi`
 * returns a verdict rather than throwing on transport failure, and no request
 * a person makes waits on Telegram: the Mini App's proofs are verified locally
 * (miniAppAuth.js), so an outage at Telegram stops alerts, not sign-ins.
 */
import { db } from '#db';
import { decryptField } from '../identity/fieldCrypto.util.js';

const API_ROOT = 'https://api.telegram.org';

/** How long the bot row is reused before it is read again (30 s). */
const BOT_TTL_MS = Number(process.env.TELEGRAM_CONFIG_TTL_MS || 30_000);

let _cache = null; // { at, bot }

/** Drop the cached bot — called after an admin saves one. */
export function invalidateBotCache() {
  _cache = null;
}

/**
 * The bot, token decrypted, or null when none is configured.
 *
 * Null is a normal answer: a fresh deployment, or a token that no longer
 * decrypts (logged, so the operator learns the key changed). Every caller
 * reads it as "Telegram is not available", never as an error to retry.
 *
 * @returns {Promise<null | {botId: string, botUsername: string, token: string,
 *   miniAppShortName: string}>}
 */
export async function miniAppBot({ force = false } = {}) {
  if (!force && _cache && Date.now() - _cache.at < BOT_TTL_MS) return _cache.bot;
  const row = await db.telegram.getBotSecrets();
  let bot = null;
  if (row) {
    const token = safeDecrypt(row.tokenEncrypted);
    if (token) {
      bot = {
        botId: row.botId, botUsername: row.botUsername, token,
        miniAppShortName: row.miniAppShortName || '',
      };
    }
  }
  _cache = { at: Date.now(), bot };
  return bot;
}

function safeDecrypt(ciphertext) {
  try { return decryptField(ciphertext); } catch (err) {
    console.error('[telegram] bot token could not be decrypted — check IDENTITY_ENCRYPTION_KEY:', err.message);
    return null;
  }
}

/** What Telegram allows as a Mini App start parameter. */
export const START_PARAM_SHAPE = /^[A-Za-z0-9_-]{1,512}$/;

/**
 * The deep link that opens the Mini App with `param`.
 *
 * `https://t.me/<bot>/<short>?startapp=` for a Mini App registered under a
 * short name, `https://t.me/<bot>?startapp=` for the bot's main Mini App.
 * Telegram signs `param` into the page's `initData` as `start_param`, which is
 * how the page learns what it was opened for without anything it could alter.
 */
export function miniAppLink(bot, param) {
  if (!bot?.botUsername) return null;
  if (!START_PARAM_SHAPE.test(String(param))) throw new Error(`miniAppLink: start parameter ${param} is not one Telegram accepts`);
  const name = encodeURIComponent(String(bot.botUsername).replace(/^@/, ''));
  const short = bot.miniAppShortName ? `/${encodeURIComponent(bot.miniAppShortName)}` : '';
  return `https://t.me/${name}${short}?startapp=${param}`;
}

/**
 * One Bot API call.
 *
 * @returns {{ok: true, result: any} | {ok: false, error: string, status?: number, retryAfter?: number}}
 */
export async function callApi(token, method, payload = {}, { timeoutMs = 10_000 } = {}) {
  if (!token) return { ok: false, error: 'no_token' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_ROOT}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok !== true) {
      return {
        ok: false,
        error: body.description || `HTTP ${res.status}`,
        status: res.status,
        retryAfter: body.parameters?.retry_after,
      };
    }
    return { ok: true, result: body.result };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A direct message from the bot. The bot can reach only somebody who opened
 * it, which every linked account did to verify (and a staff member's Mini App
 * asks `requestWriteAccess` for exactly this).
 */
export async function sendDirectMessage(chatId, text, extra = {}) {
  const bot = await miniAppBot();
  if (!bot) return { ok: false, error: 'not_configured' };
  return callApi(bot.token, 'sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra,
  });
}

/** Ask Telegram who a token belongs to: the only way a bot is ever named. */
export async function verifyBotToken(token) {
  const res = await callApi(token, 'getMe');
  if (!res.ok) return res;
  if (!res.result?.is_bot || !res.result?.username) return { ok: false, error: 'not_a_bot' };
  return { ok: true, username: res.result.username, id: String(res.result.id) };
}
