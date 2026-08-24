// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/telegram/telegramClient.js — the Bot API, and the active config.
 *
 * Everything that talks to Telegram goes through here, for one reason: the bot
 * token is replaceable at runtime. If a module captured a token at import time,
 * swapping a banned bot from the admin panel would require a restart — which is
 * precisely the outage the replaceability requirement exists to prevent. So the
 * active config is resolved per call, from one cached document.
 *
 * ── Failure posture ─────────────────────────────────────────────────────────
 * Telegram is a third party and will be unreachable sometimes. Calls here
 * return a verdict rather than throwing on transport failure, so a caller can
 * decide whether "we could not check" means allow or deny. That decision is
 * NOT made here — for channel membership it is made in the gate, where the
 * safe answer (deny betting, keep the session) is a policy choice.
 */
import { TelegramConfig } from './telegram.model.js';
import { decryptField } from '../identity/fieldCrypto.util.js';

const API_ROOT = 'https://api.telegram.org';

/** How long the active config is reused before re-reading it. */
const CONFIG_TTL_MS = Number(process.env.TELEGRAM_CONFIG_TTL_MS || 30_000);

let _cache = { at: 0, config: null };

/** Drop the cached config — called after an admin activates a new generation. */
export function invalidateConfigCache() {
  _cache = { at: 0, config: null };
}

/**
 * The active bot/channel configuration, with secrets decrypted.
 *
 * Returns null when nothing is configured yet, which is the state a fresh
 * deployment starts in. Callers must treat that as "Telegram auth is not
 * available", never as an error to retry.
 */
export async function activeConfig({ force = false } = {}) {
  if (!force && _cache.config && Date.now() - _cache.at < CONFIG_TTL_MS) {
    return _cache.config;
  }
  const doc = await TelegramConfig.findOne({ active: true })
    .select('+botTokenEncrypted +webhookSecret +recoveryBotTokenEncrypted +recoveryWebhookSecret')
    .lean();
  if (!doc) { _cache = { at: Date.now(), config: null }; return null; }

  const config = {
    generation:        doc.generation,
    botUsername:       doc.botUsername,
    botToken:          safeDecrypt(doc.botTokenEncrypted),
    webhookSecret:     doc.webhookSecret,
    recoveryBotUsername: doc.recoveryBotUsername || '',
    recoveryBotToken:  doc.recoveryBotTokenEncrypted ? safeDecrypt(doc.recoveryBotTokenEncrypted) : null,
    recoveryWebhookSecret: doc.recoveryWebhookSecret || null,
    channelId:         doc.channelId,
    channelUsername:   doc.channelUsername || '',
    channelInviteLink: doc.channelInviteLink || '',
  };
  _cache = { at: Date.now(), config };
  return config;
}

/**
 * Decrypt, or return null.
 *
 * A token that cannot be decrypted means IDENTITY_ENCRYPTION_KEY changed or the
 * row was tampered with. Returning null degrades to "Telegram unavailable",
 * which the caller already handles; throwing here would take down every request
 * that merely wanted to know the channel's invite link.
 */
function safeDecrypt(ciphertext) {
  try { return decryptField(ciphertext); } catch (err) {
    console.error('[telegram] bot token could not be decrypted — check IDENTITY_ENCRYPTION_KEY:', err.message);
    return null;
  }
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
      // 429 carries the wait in parameters.retry_after. Surfacing it lets the
      // caller back off rather than hammering a bot that is already limited.
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

// ── Convenience wrappers, all resolving the active config per call ──────────

export async function sendMessage(chatId, text, extra = {}) {
  const cfg = await activeConfig();
  if (!cfg) return { ok: false, error: 'not_configured' };
  return callApi(cfg.botToken, 'sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra,
  });
}

export async function sendRecoveryMessage(chatId, text, extra = {}) {
  const cfg = await activeConfig();
  if (!cfg?.recoveryBotToken) return { ok: false, error: 'recovery_not_configured' };
  return callApi(cfg.recoveryBotToken, 'sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra,
  });
}

/**
 * Ask Telegram whether someone is in the channel RIGHT NOW.
 *
 * This is the expensive, authoritative answer. It is deliberately NOT what the
 * request path calls — see telegramMembership.js, which serves a cache kept
 * fresh by `chat_member` webhook updates. At the member counts this programme
 * is sized for, one getChatMember per request would exceed the Bot API's limits
 * long before it exceeded ours.
 */
export async function fetchChatMemberStatus(telegramUserId) {
  const cfg = await activeConfig();
  if (!cfg) return { ok: false, error: 'not_configured' };
  const res = await callApi(cfg.botToken, 'getChatMember', {
    chat_id: cfg.channelId, user_id: Number(telegramUserId),
  });
  if (!res.ok) {
    // "user not found" / "chat member not found" is a definite answer: they are
    // not in the channel. Anything else is genuinely unknown.
    if (/not found/i.test(res.error || '')) {
      return { ok: true, status: 'left', generation: cfg.generation };
    }
    return res;
  }
  return { ok: true, status: res.result?.status || 'unknown', generation: cfg.generation };
}

/** Register the webhook for the primary bot. Called when a config is activated. */
export async function setWebhook({ token, url, secret, allowedUpdates }) {
  return callApi(token, 'setWebhook', {
    url,
    secret_token: secret,
    // `chat_member` is what makes membership event-driven instead of polled,
    // and Telegram only delivers it when explicitly requested.
    allowed_updates: allowedUpdates || ['message', 'chat_member', 'my_chat_member', 'callback_query'],
    drop_pending_updates: true,
  });
}

/** Confirm a token works and belongs to the username an admin typed. */
export async function verifyBotToken(token) {
  const res = await callApi(token, 'getMe');
  if (!res.ok) return res;
  return { ok: true, username: res.result?.username, id: res.result?.id };
}
