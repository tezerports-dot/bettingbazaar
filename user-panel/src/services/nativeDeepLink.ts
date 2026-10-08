// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * services/nativeDeepLink.ts — open a link to the public site inside the app.
 *
 * ── What arrives here ──────────────────────────────────────────────────────
 * The App Link filter in AndroidManifest.xml routes taps on
 * `https://<PUBLIC_APP_ORIGIN>/#/…` to this app. The one the platform sends
 * today is the password-reset link the Mini App opens, `/#/reset/<token>`: a
 * player who forgot their password taps it in Telegram and lands on the reset screen in
 * the app they already have, instead of a browser. (Sign-in itself is a form —
 * CLAUDE.md §33 — so no link here grants a session.)
 *
 * The manifest routes the tap; this takes the URL Android hands over and
 * turns it into a navigation inside the app.
 *
 * ── Why only the fragment is used, and never the URL ───────────────────────
 * The incoming URL names the PUBLIC origin; this WebView runs the bundled
 * assets from `https://localhost`. Navigating to the incoming URL would load
 * the live website inside the shell — silently converting a native app into a
 * repackaged web view, which is the one thing capacitor.config.ts exists to
 * prevent (no `server.url`, deliberately). So the origin is used only to decide
 * whether to trust the link, and only the fragment is applied, as a local
 * HashRouter navigation. The token stays in the fragment throughout — it is
 * there so it never reaches a server log or a Referer header.
 *
 * ── Why the origin is checked even though the OS already filtered ──────────
 * MainActivity is `exported="true"` (it must be, to receive an App Link), so
 * any app on the device can send it an explicit VIEW intent carrying a URL of
 * its choosing — the intent-filter constrains what the OS ROUTES, not what can
 * be delivered by name. An unchecked handler would let a hostile app steer this
 * one to an arbitrary route. The allow-list is the deployment's own origins.
 */
import { isNativeShell } from './nativeLifecycle';
import { originCandidates, readEnv } from './originFailover';

/**
 * Origins whose links this app will act on.
 *
 * `VITE_APP_ORIGIN` is the panel's public origin — the one the backend's
 * `PUBLIC_APP_ORIGIN` builds reset links against, and the host the App Link
 * filter claims. The API origins are included because a single-service deploy
 * serves the panel and the API from the same host, and a multi-domain deploy
 * (`network.config.js` DOMAINS) serves the same app from every one of them.
 */
function trustedOrigins(): string[] {
  const appOrigin = readEnv('VITE_APP_ORIGIN');
  const raw = [appOrigin, ...originCandidates()].filter(Boolean);

  const origins = raw
    .map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        return '';                         // a malformed build value trusts nothing
      }
    })
    .filter(Boolean);

  return Array.from(new Set(origins));
}

/**
 * The in-app route a deep link asks for, or null if it asks for nothing this
 * app should act on.
 *
 * Exported for tests: this is the whole trust decision, and it is pure.
 */
export function routeFromDeepLink(rawUrl: string, allowed: string[]): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!allowed.includes(url.origin)) return null;

  // `#/wallet?tab=deposit` — a HashRouter route and nothing else. Anything
  // that is not a hash route (an empty fragment from a bare tap on the site
  // root, `#javascript:…`, a protocol-relative `#//evil.example`) is not a
  // navigation this app performs.
  const hash = url.hash;
  if (!hash.startsWith('#/') || hash.startsWith('#//')) return null;

  return hash;
}

/** The last fragment acted on, so one launch is never redeemed twice. */
let lastHandled: string | null = null;

function applyRoute(hash: string): void {
  // A single-use token that arrives twice — Android can deliver a cold-start
  // URL through both getLaunchUrl() and an appUrlOpen event — would burn itself
  // on the second attempt and drop the player on the failure screen.
  if (hash === lastHandled) return;
  lastHandled = hash;

  // Assignment, not a router navigation: this module has no router context, and
  // HashRouter reads window.location.hash at mount and listens for hashchange
  // after it — so this works whether React has mounted yet or not.
  window.location.hash = hash;
}

let registered = false;

/**
 * Start routing links to the public site into the app. No-op outside the native shell
 * and safe to call more than once.
 *
 * @returns a teardown function, or null when nothing was registered.
 */
export async function registerNativeDeepLinks(): Promise<(() => void) | null> {
  if (!isNativeShell() || registered) return null;
  registered = true;

  const allowed = trustedOrigins();

  try {
    // Lazily imported so the web bundle never pulls in the native plugin.
    const { App } = await import('@capacitor/app');

    // Warm start: the app is already running and Android delivers the new
    // intent to the existing task (launchMode="singleTask" in the manifest).
    const handle = await App.addListener('appUrlOpen', ({ url }) => {
      const route = routeFromDeepLink(url, allowed);
      if (route) applyRoute(route);
    });

    // Cold start: the app was launched BY the link, so the event may have
    // fired before this listener existed. getLaunchUrl() is the only way to
    // see it, and it returns null for an ordinary launcher start.
    try {
      const launch = await App.getLaunchUrl();
      const route = launch?.url ? routeFromDeepLink(launch.url, allowed) : null;
      if (route) applyRoute(route);
    } catch {
      // Not fatal: warm-start delivery still works, and the player can ask the
      // bot for another link.
    }

    return () => {
      handle.remove();
      registered = false;
    };
  } catch (error) {
    // A missing plugin must never stop the app from running — a link falls
    // back to whatever the OS does with the link, which is where it was before.
    console.warn('[native] deep-link listener unavailable:', error);
    registered = false;
    return null;
  }
}
