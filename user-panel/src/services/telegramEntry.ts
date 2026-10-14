// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * services/telegramEntry.ts — the Telegram links that always open Betting
 * Bazaar (`GET /api/v1/client/telegram-entry`, backend `miniAppEntryLink`):
 * the bot in use first, then its standby bots (owner, 2026-10-14).
 *
 * They are Telegram's addresses, not ours, so they keep working when the
 * site's own domain is blocked, and a standby keeps working when Telegram bans
 * the bot in use (docs/governance/DOMAIN_FAILOVER.md). The app fetches them
 * once connected and remembers them in this browser, so the "Can't connect"
 * screen can still show them when nothing of ours answers. A per-viewer
 * convenience: storage may be absent, and then the screen just does not show them.
 *
 * Only a plain `https://t.me/<bot>` or `https://t.me/<bot>/<app>` link is ever
 * kept or shown, whatever a server or storage says.
 */
import { platform } from './api';

const STORE = 'bb_telegram_entry';
const SHAPE = /^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}(\/[A-Za-z0-9_]{3,64}|\?startapp)$/;
/** The primary and three standbys (backend BOT_SLOTS). */
const MAX_LINKS = 4;

/** True for a link of the one shape this app shows. */
export function isTelegramEntryUrl(url: unknown): url is string {
  return typeof url === 'string' && SHAPE.test(url);
}

/** Only well-shaped links, once each, at most MAX_LINKS. */
function clean(urls: unknown[]): string[] {
  return [...new Set(urls.filter(isTelegramEntryUrl))].slice(0, MAX_LINKS);
}

/** Every link this browser last learned, the bot in use first; [] when none. */
export function rememberedTelegramEntries(): string[] {
  try {
    // One link per line; a value kept before the standbys is a list of one.
    return clean((globalThis.localStorage?.getItem(STORE) ?? '').split('\n'));
  } catch { return []; }
}

/** The link of the bot in use, as this browser last learned it, or ''. */
export function rememberedTelegramEntry(): string {
  return rememberedTelegramEntries()[0] ?? '';
}

/**
 * Ask the server once more; keep a valid answer, forget the links when there
 * is no bot. Resolves to the link of the bot in use, or ''. Never throws.
 */
export async function refreshTelegramEntry(): Promise<string> {
  let answer: { url?: unknown; urls?: unknown } | undefined;
  try {
    answer = await platform.telegramEntry();
  } catch (err) {
    // 404: no bot is in use any more, so the kept links are stale. Anything
    // else (offline, a 5xx) says nothing about the links: keep them.
    if ((err as { status?: unknown })?.status !== 404) return rememberedTelegramEntry();
  }
  const urls = clean([answer?.url, ...(Array.isArray(answer?.urls) ? answer.urls : [])]);
  if (urls.length) {
    try { globalThis.localStorage?.setItem(STORE, urls.join('\n')); } catch { /* shown this run only */ }
    return urls[0];
  }
  try { globalThis.localStorage?.removeItem(STORE); } catch { /* nothing kept */ }
  return '';
}
