// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Which origins the player panel may put a game in an `<iframe>` from.
 *
 * ── The defect this exists to fix ──────────────────────────────────────────
 * `CSP_DIRECTIVES` had no `frame-src` at all. CSP falls back `frame-src` →
 * `child-src` → `default-src`, and `default-src` is `'self'`, so **every
 * provider game was blocked by the browser**. Three player screens —
 * `CasinoPage`, `CrashPage` and `SportsPage` — build an iframe around a
 * `launchUrl` whose origin is the provider's `api_url`, and all three rendered
 * their chrome around a blank frame.
 *
 * Nothing was red. The backend builds those launch URLs correctly for five
 * provider integrations, signs their webhooks, and opens a session; the route
 * tests pass; the panel calls a route that exists so `check:ui-coverage` is
 * satisfied. The only thing missing was one directive, and the failure appears
 * in the browser's console rather than in any response. `security.config.js`
 * even says out loud that iframes are expected — it turns COEP off
 * "(provider iframes/CDN images break under COEP require-corp — deliberate)" —
 * so the intent was recorded and the permission was not.
 *
 * ── Why it is DERIVED and not a list ──────────────────────────────────────
 * A hardcoded allowlist of provider domains is a second owner of "who are our
 * suppliers" (§2, §5): an admin adds a provider through the panel, the game
 * still will not load, and nothing says why. So the directive reads the same
 * `game_providers` rows the launcher reads.
 *
 * **Enabled providers only.** A provider an operator has switched off must not
 * be frameable — that toggle is how a supplier is cut off in a hurry, and a CSP
 * that kept honouring them would leave the one lever that matters half-connected.
 *
 * ── Why there is a cache, and what it costs ───────────────────────────────
 * Helmet evaluates a directive function ONCE PER RESPONSE and that function
 * must be SYNCHRONOUS — it cannot await a query. So the origins are refreshed
 * in the background and read synchronously.
 *
 * Staleness window: `REFRESH_MS` (60s), plus an immediate refresh whenever a
 * provider is created, updated or deleted, so an operator toggling one does not
 * wait out the timer. A stale read is bounded in both directions and neither is
 * dangerous: a provider just enabled is blocked for up to a minute, which is
 * the behaviour today; a provider just disabled stays frameable for up to a
 * minute, and the launcher has already stopped issuing URLs for it, so there is
 * nothing to put in the frame.
 *
 * ── Failing closed ────────────────────────────────────────────────────────
 * Before the first refresh completes, and if a refresh throws, this returns an
 * empty list. That is `default-src 'self'` — exactly what shipped — so the
 * failure mode is the status quo rather than a wildcard. It is the right way
 * round: a CSP that fails OPEN on a database error would hand an attacker who
 * can break the query a way to frame anything.
 */
import { listProviders } from '#db/repositories/games.js';

/**
 * How long a change can take to reach the header. Documented here at the cache
 * definition, as §6 requires of any cached config.
 */
const REFRESH_MS = 60_000;

/** The origins, ready to hand to helmet. Never null — see "Failing closed". */
let origins = [];
let timer = null;

/**
 * The ORIGIN of a provider's API url, or null when it is not a usable one.
 *
 * CSP matches a frame source by origin; a path in the directive is legal and
 * pointless, and a trailing path segment on one provider would silently stop
 * matching the day they moved their launcher. `new URL` also throws out the
 * junk a half-configured provider row can hold — an empty string, a hostname
 * with no scheme, a placeholder somebody typed.
 *
 * `http:` is refused as well as unparseable values. A game iframe carries a
 * session token in its query string, and on a page served over https the
 * browser blocks mixed content anyway — allowing it here would only produce a
 * permission that cannot be exercised.
 */
export function providerOrigin(apiUrl) {
  if (!apiUrl) return null;
  try {
    const url = new URL(String(apiUrl).trim());
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Re-read the enabled providers. Safe to call at any time and from anywhere;
 * a failure leaves the previous answer in place rather than emptying it, since
 * a transient database blip should not blank the lobby.
 */
export async function refreshProviderFrameSources() {
  try {
    const providers = await listProviders({ enabledOnly: true });
    origins = [...new Set(providers.map((p) => providerOrigin(p.apiUrl)).filter(Boolean))];
    return origins;
  } catch (err) {
    console.error('[csp] could not refresh provider frame sources:', err.message);
    return origins;
  }
}

/**
 * The PROVIDER origins. Just those — `'self'` is added by the directive builder
 * (`helmetOptionsFraming`), which is the one place that decides what a
 * `frame-src` list contains. Adding it here too is how the first version of
 * this emitted `frame-src 'self' 'self' https://…`.
 *
 * Synchronous, because the thing that consumes it is building a header.
 * Returns a copy: the array is handed out on every rebuild, and an accidental
 * mutation by a caller would persist into every later response.
 */
export function providerFrameSources() {
  return [...origins];
}

/** Start the background refresh. Idempotent — a second call is a no-op. */
export function startProviderFrameSourceRefresh() {
  if (timer) return timer;
  // `unref` so this timer alone cannot hold the process open during a shutdown.
  timer = setInterval(() => { refreshProviderFrameSources(); }, REFRESH_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

// There is no `stop`. One was written here "for tests" and nothing called it,
// which is §22 — code nothing imports is not code, and a stop nobody calls is
// worse than none because it reads as though the lifecycle is managed. The
// interval is `unref`'d, so it holds nothing open and a test that never starts
// it never has one to stop.

/** Test seam: set the origins directly, without a database. */
export function __setProviderFrameSourcesForTest(list) {
  origins = [...new Set((list || []).map(providerOrigin).filter(Boolean))];
}
