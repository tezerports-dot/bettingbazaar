// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * services/telegramEntry.ts — the Telegram link that always opens Betting
 * Bazaar (`GET /api/v1/client/telegram-entry`, backend `miniAppEntryLink`).
 *
 * It is Telegram's address, not ours, so it keeps working when the site's own
 * domain is blocked (docs/governance/DOMAIN_FAILOVER.md). The app fetches it
 * once connected and remembers it in this browser, so the "Can't connect"
 * screen can still show it when nothing of ours answers. A per-viewer
 * convenience: storage may be absent, and then the screen just does not show it.
 *
 * Only a plain `https://t.me/<bot>` or `https://t.me/<bot>/<app>` link is ever
 * kept or shown, whatever a server or storage says.
 */
import { platform } from './api';

const STORE = 'bb_telegram_entry';
const SHAPE = /^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}(\/[A-Za-z0-9_]{3,64}|\?startapp)$/;

/** True for a link of the one shape this app shows. */
export function isTelegramEntryUrl(url: unknown): url is string {
  return typeof url === 'string' && SHAPE.test(url);
}

/** The link this browser last learned, or ''. */
export function rememberedTelegramEntry(): string {
  try {
    const v = globalThis.localStorage?.getItem(STORE) ?? '';
    return isTelegramEntryUrl(v) ? v : '';
  } catch { return ''; }
}

/** Ask the server once more; keep a valid answer, forget it when there is no bot. Never throws. */
export async function refreshTelegramEntry(): Promise<string> {
  let url: unknown;
  try {
    url = (await platform.telegramEntry())?.url;
  } catch (err) {
    // 404: no bot is saved any more, so the kept link is stale. Anything else
    // (offline, a 5xx) says nothing about the link: keep it.
    if ((err as { status?: unknown })?.status !== 404) return rememberedTelegramEntry();
  }
  if (isTelegramEntryUrl(url)) {
    try { globalThis.localStorage?.setItem(STORE, url); } catch { /* shown this run only */ }
    return url;
  }
  try { globalThis.localStorage?.removeItem(STORE); } catch { /* nothing kept */ }
  return '';
}
