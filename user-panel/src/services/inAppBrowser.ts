// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * services/inAppBrowser.ts — is this page running somewhere a session can survive?
 *
 * ── The failure this exists to prevent ─────────────────────────────────────
 * The bot's sign-in link is single-use, and it is spent by whatever context
 * opens it. Tapped inside Telegram on Android, that context is Telegram's own
 * WebView: its own cookie jar, its own localStorage, thrown away when the sheet
 * closes. The player watches themselves get signed in, closes the sheet, opens
 * the app — and is signed out, with the token already burned. Asking the bot
 * again produces another link that takes the same trip.
 *
 * So the token is NOT redeemed in a context that cannot keep the result. The
 * page stops and hands the link back to the player instead, to be opened
 * somewhere it will stick.
 *
 * ── Why not just force it into Chrome ──────────────────────────────────────
 * The usual trick is an `intent://` navigation. It cannot work here: Android
 * rebuilds the target URI from scheme + authority + path + query, and the
 * `#Intent;…;end` block occupies the fragment slot, so a fragment cannot be
 * expressed. The token rides in the FRAGMENT deliberately — that is what keeps
 * it out of access logs and `Referer` headers — so an intent hop would deliver
 * Chrome a tokenless URL and sign nobody in. `x-safari-https:` on iOS has no
 * such limitation, which is why iOS gets a real button and Android gets an
 * instruction.
 *
 * ── Why detection fails OPEN ───────────────────────────────────────────────
 * A false positive here is worse than a false negative: it stops a sign-in that
 * would have worked. Every check below therefore has to be POSITIVELY true of a
 * storage-isolated WebView before it fires, and anything unrecognised is
 * treated as a real browser. The screen it gates also carries a "continue here
 * anyway" escape, so a wrong answer costs a tap and never an account.
 */

/** Where this page is running, as far as keeping a session is concerned. */
export type BrowserContext =
  /** The Capacitor shell. Its storage IS the app's — redeem here. */
  | 'native'
  /** A real browser (or an installed PWA / SFSafariViewController sharing one). */
  | 'browser'
  /** An embedded WebView with its own throwaway storage. Do not redeem here. */
  | 'isolated-webview';

export interface ContextProbe {
  userAgent: string;
  /** True inside the Capacitor shell. */
  native: boolean;
}

/**
 * Classify the current context from the user agent.
 *
 * Exported and pure so the classification can be tested against real user-agent
 * strings rather than through a browser.
 */
export function classifyContext({ userAgent, native }: ContextProbe): BrowserContext {
  if (native) return 'native';

  const ua = userAgent || '';

  // Android: the platform stamps ` wv` into every WebView's user agent, and
  // only a WebView's. Telegram, and every other in-app browser on Android, is
  // one. This is the single most reliable signal available on either platform.
  if (/\bwv\b/.test(ua) && /Android/i.test(ua)) return 'isolated-webview';

  // iOS: a WKWebView omits the `Safari/` token that Safari itself, and
  // SFSafariViewController, both carry.
  //
  // That distinction is the whole point rather than a detail: an app that opens
  // links in SFSafariViewController shares Safari's cookie store, so a session
  // established there is a real one and must NOT be interrupted. Only the
  // WKWebView case is isolated. Telegram's iOS browser has historically used
  // SFSafariViewController, so on iOS this often correctly does nothing.
  const isIos = /iPhone|iPad|iPod/i.test(ua);
  if (isIos && /AppleWebKit/i.test(ua) && !/Safari\//i.test(ua)) return 'isolated-webview';

  // Anything unrecognised is treated as a real browser. See the header: a false
  // positive blocks a sign-in that would have worked.
  return 'browser';
}

/**
 * A URL that opens `href` in Safari from inside an iOS in-app browser.
 *
 * `x-safari-https:` is Safari's own scheme and hands the URL to Safari intact,
 * fragment included — which is exactly what the equivalent Android trick cannot
 * do. Returns null for anything that is not an https URL, so the value is never
 * a way to launch some other scheme.
 */
export function safariEscapeUrl(href: string): string | null {
  if (!href.startsWith('https://')) return null;
  return `x-safari-${href}`;
}

/** Classify the live page. Thin wrapper over the pure function above. */
export function currentContext(): BrowserContext {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const native = !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor?.isNativePlatform?.();
  return classifyContext({ userAgent: nav?.userAgent ?? '', native });
}

/** True only where redeeming a one-time token would throw the session away. */
export function isIsolatedWebView(): boolean {
  return currentContext() === 'isolated-webview';
}
