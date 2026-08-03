// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * services/apiUrl.ts — turn an API path into a fully-resolved URL.
 *
 * ── The bug this exists to kill ────────────────────────────────────────────
 * `fetch('/api/game/games')` resolves the path against the PAGE's origin. On the
 * web that is the site itself and it works, which is why it survived review.
 * Inside the Capacitor Android shell `window.location.origin` is
 * `https://localhost`, so the very same line asks the HANDSET for the API and
 * every such request fails — while the app installs, opens and renders
 * perfectly. That is the exact failure `capacitor.config.ts` and
 * `scripts/assert-native-env.mjs` were written to prevent for the API base, and
 * it reappears anywhere a component reaches for the global `fetch` instead of
 * going through the service layer.
 *
 * It also bypasses origin failover: when the primary host stops answering,
 * `originFailover` adopts the next candidate and everything routed through
 * `apiClient` follows, but a hardcoded relative path keeps aiming at the dead
 * origin.
 *
 * ── Why this and not apiClient ─────────────────────────────────────────────
 * `apiClient` is the better door and new code should use it: auth headers,
 * 401 handling, dedup, retries. But it also THROWS on a non-2xx response, while
 * the call sites this fixes are written around `const r = await fetch(...);
 * const d = await r.json(); if (d.success)`. Converting them wholesale changes
 * error handling in eight shipped pages at once.
 *
 * So this helper deliberately changes exactly one thing — the origin — and
 * nothing else. Same method, same headers, same credentials, same error
 * semantics. It is the smallest edit that makes those pages work on Android,
 * which is what you want when the alternative is an eight-page refactor of
 * money-adjacent screens.
 *
 * New code: use `apiClient`. This is for making existing `fetch` calls correct
 * without rewriting them.
 */
import { currentOrigin } from './originFailover';

/**
 * Absolute URL for an API path.
 *
 * Resolved per call rather than cached at module load, so a failover that
 * happens mid-session is picked up by the next request without a reload —
 * matching how `apiClient` resolves its own origin.
 *
 * With a single configured origin (the normal same-origin web deploy)
 * `currentOrigin()` returns '' and the result is byte-identical to the relative
 * path that was there before, so the web path is provably unchanged.
 *
 * @param path an API path beginning with '/', e.g. '/api/game/games'
 */
export function apiUrl(path: string): string {
  return `${currentOrigin()}${path}`;
}

export default apiUrl;
