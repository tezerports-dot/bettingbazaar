// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/telegram/telegramClient.js — the bot, its standbys, and the Bot API.
 *
 * Step 3 (owner, 2026-10-07) left one bot carrying the Mini App that verifies
 * every player and merchant and approves their sign-ins. Since 2026-10-14
 * (owner) up to three STANDBY bots, each with its own Mini App, are saved
 * beside it: the bot in use is the lowest slot Telegram has not refused
 * (`checkBotHealth` suspends one whose token Telegram rejects), and a Mini App
 * opened from any saved bot is proved by that bot's token. Accounts key on
 * the PERSON's Telegram id, so every bot knows every account. Staff have no
 * Telegram (owner, 2026-10-13), so no bot messages anybody. No webhook: the
 * signup channels' join requests are polled (signupChannels.service.js,
 * owner 2026-10-21).
 *
 * ── Why the bot is read per call, through a short cache ───────────────────
 * Telegram suspends gambling bots, so an admin replaces the token at runtime
 * (PUT /api/admin/telegram/bot). A module that captured the token at import
 * would need a restart to follow the swap. `miniAppBots()` reads the rows and
 * keeps them for `BOT_TTL_MS` (5 s); the admin route drops the cache on the instance
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

/**
 * How long the bot rows are reused before they are read again (5 s): short,
 * so a bot suspended on one instance stops being named by every instance
 * within seconds; four rows, so the read is cheap.
 */
const BOT_TTL_MS = Number(process.env.TELEGRAM_CONFIG_TTL_MS || 5_000);

let _cache = null; // { at, bot }

/** Drop the cached bot — called after an admin saves one. */
export function invalidateBotCache() {
  _cache = null;
}

/**
 * Every saved bot, token decrypted, slot order (1 = primary, 2-4 standbys;
 * owner, 2026-10-14). A token that no longer decrypts is left out (logged, so
 * the operator learns the key changed).
 *
 * @returns {Promise<Array<{slot: number, botId: string, botUsername: string,
 *   token: string, miniAppShortName: string, suspended: boolean}>>}
 */
export async function miniAppBots({ force = false } = {}) {
  if (!force && _cache && Date.now() - _cache.at < BOT_TTL_MS) return _cache.bots;
  const rows = await db.telegram.getBotSecrets();
  const bots = [];
  for (const row of rows) {
    const token = safeDecrypt(row.tokenEncrypted);
    if (token) {
      bots.push({
        slot: row.slot, botId: row.botId, botUsername: row.botUsername, token,
        miniAppShortName: row.miniAppShortName || '', suspended: row.suspended,
      });
    }
  }
  _cache = { at: Date.now(), bots };
  return bots;
}

/**
 * The bot in use: the lowest slot not suspended, token decrypted, or null when
 * none is. Every new link (a sign-in, a referral, the entry link) names it.
 *
 * Null is a normal answer: a fresh deployment, every bot suspended, or a token
 * that no longer decrypts. Every caller reads it as "Telegram is not
 * available", never as an error to retry.
 */
export async function miniAppBot({ force = false } = {}) {
  return (await miniAppBots({ force })).find((b) => !b.suspended) ?? null;
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
 * The same Mini App as `miniAppLink`, addressed to the Telegram app itself
 * (`tg://resolve`). On a phone the https link first opens a browser tab at
 * t.me's "Open in Telegram" page; this one opens Telegram straight away. A
 * device without Telegram cannot open it, so a panel keeps `miniAppLink` as
 * the fallback.
 */
export function miniAppAppLink(bot, param) {
  if (!bot?.botUsername) return null;
  if (!START_PARAM_SHAPE.test(String(param))) throw new Error(`miniAppAppLink: start parameter ${param} is not one Telegram accepts`);
  const name = encodeURIComponent(String(bot.botUsername).replace(/^@/, ''));
  const app = bot.miniAppShortName ? `&appname=${encodeURIComponent(bot.miniAppShortName)}` : '';
  return `tg://resolve?domain=${name}${app}&startapp=${param}`;
}

/**
 * The bot's Mini App with no start parameter: the link that opens the player
 * app's way in from Telegram whatever has happened to our own domains, because
 * it is Telegram's address and the Mini App's URL is set in BotFather
 * (docs/governance/DOMAIN_FAILOVER.md). Verify there signs the person in and
 * opens the site at its current address. Null with no bot saved.
 */
export function miniAppEntryLink(bot) {
  if (!bot?.botUsername) return null;
  const name = encodeURIComponent(String(bot.botUsername).replace(/^@/, ''));
  // A named Mini App opens at its own path; without one, `?startapp` opens the bot's main Mini App.
  return bot.miniAppShortName ? `https://t.me/${name}/${encodeURIComponent(bot.miniAppShortName)}` : `https://t.me/${name}?startapp`;
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
 * Telegram's answers that mean a token is dead for good (revoked, bot
 * deleted or banned), as opposed to an outage or a rate limit.
 */
const TOKEN_REFUSED = new Set([401, 403, 404]);

/**
 * How often the bots are asked: every second (owner, 2026-10-14: "make it per
 * second"). `TELEGRAM_BOT_HEALTH_MS=0` turns the check off, for a server that
 * holds a TEST token Telegram would refuse (`test:e2e`, `test:signin-journey`);
 * the scheduler then registers nothing.
 */
export const BOT_HEALTH_EVERY_MS = Number(process.env.TELEGRAM_BOT_HEALTH_MS ?? 1000);

/** A health probe gives up after this, so a slow Telegram never stacks probes. */
const HEALTH_TIMEOUT_MS = 3000;

let _checking = false;

/**
 * Ask Telegram about every bot in use, all at once; suspend one whose token it
 * REFUSES, so new links move to the next standby at once (owner, 2026-10-14).
 * A timeout, a 5xx or a 429 is Telegram's weather and suspends nothing. One
 * `getMe` per bot per second is far inside what Telegram allows a bot.
 * Returns the slots suspended; a call while the last is still out returns []
 * (never two probes of one bot in flight). Run by the scheduler
 * (`telegram-bot-health`, every `BOT_HEALTH_EVERY_MS`; off at 0).
 */
export async function checkBotHealth({
  verify = (token) => verifyBotToken(token, { timeoutMs: HEALTH_TIMEOUT_MS }), onSuspended = () => {},
} = {}) {
  if (_checking) return [];
  _checking = true;
  try {
    // The cached list (5 s), not a read of the table every second. A
    // suspension drops the cache.
    const live = (await miniAppBots()).filter((b) => !b.suspended);
    const answers = await Promise.all(live.map((bot) => verify(bot.token)));
    const suspended = [];
    for (const [i, bot] of live.entries()) {
      const me = answers[i];
      if (me.ok || !TOKEN_REFUSED.has(me.status)) continue;
      const row = await db.telegram.setBotSuspended({
        slot: bot.slot, botId: bot.botId, reason: `Telegram refused the token: ${me.error}`, updatedBy: 'system:bot-health',
      });
      if (row) { suspended.push(bot.slot); onSuspended(bot, me); }
    }
    if (suspended.length) invalidateBotCache();
    return suspended;
  } finally {
    _checking = false;
  }
}

/** Ask Telegram who a token belongs to: the only way a bot is ever named. */
export async function verifyBotToken(token, { timeoutMs } = {}) {
  const res = await callApi(token, 'getMe', {}, timeoutMs ? { timeoutMs } : undefined);
  if (!res.ok) return res;
  if (!res.result?.is_bot || !res.result?.username) return { ok: false, error: 'not_a_bot' };
  return { ok: true, username: res.result.username, id: String(res.result.id) };
}
