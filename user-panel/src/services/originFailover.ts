// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * services/originFailover.ts — reach the backend when its primary origin does not answer.
 *
 * The app is configured with an ordered list of origins that all serve the SAME
 * deployment (the multi-domain redundancy in `backend/config/network.config.js`:
 * every hostname in DOMAINS serves the same app, same routes, same behaviour).
 * If the first one cannot be reached, the client tries the next until one
 * answers, and remembers the winner.
 *
 * ── Scope, stated precisely ─────────────────────────────────────────────────
 * This is ORIGIN availability, not network circumvention. It answers "this
 * hostname stopped responding, is there another one serving the same app?" —
 * a DNS/CDN/origin failure mode. It does not tunnel, proxy, or disguise
 * traffic, and per the hard constraint on the multi-domain design it takes NO
 * client IP, geo or ISP as an input: the candidate order is a static,
 * build-time list, identical for every user.
 *
 * ── Why a probe rather than "retry the next one on error" ───────────────────
 * A failed money request must not be replayed against a different origin on a
 * hunch. A POST that created a payment order but whose response was lost would
 * be re-sent to origin #2 and could be applied twice. So failover happens at
 * the level of "which origin do we talk to", decided by a cheap idempotent GET
 * against /health/live, and only ever between requests. The transport layer
 * asks this module for an origin; it never re-routes a request in flight.
 */

/** How long a single origin gets to answer the health probe. */
const PROBE_TIMEOUT_MS = 4000;

/** Where the last known-good origin is remembered across reloads. */
const STORAGE_KEY = 'bb_api_origin';

/**
 * How long a remembered origin is trusted before it is re-checked against the
 * front of the list. Without this, a client that once failed over to the last
 * candidate would stay there forever, even after the primary recovered.
 */
const STICKY_MS = 30 * 60 * 1000; // 30 minutes

function normalise(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * The ordered candidate list, from build-time configuration.
 *
 *   VITE_API_URL            primary origin (also the only one a normal deploy needs)
 *   VITE_API_FALLBACK_URLS  comma-separated alternates, tried in order
 *
 * An empty result is the normal, correct case for a same-origin web deployment:
 * the panel is served by the very host it calls, relative `/api` works, and
 * there is nothing to fail over to — if that host is unreachable the page did
 * not load either.
 */
/**
 * Build-time configuration. Vite inlines `import.meta.env` into the bundle, so
 * that is the real source in the browser; `process.env` is consulted first only
 * because it is what exists in a non-browser context (tests, any future SSR or
 * prerender step), where `import.meta.env` carries no VITE_ values.
 */
function readEnv(name: string): string {
  const fromProcess = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  if (fromProcess) return fromProcess;
  return (import.meta as any).env?.[name] ?? '';
}

export function originCandidates(): string[] {
  const primaryRaw = readEnv('VITE_API_URL');
  const primary = primaryRaw ? [normalise(primaryRaw)] : [];
  const fallbacks = String(readEnv('VITE_API_FALLBACK_URLS'))
    .split(',')
    .map(normalise)
    .filter(Boolean);

  // Order preserved, duplicates dropped — a repeated origin would double the
  // time spent failing before reaching a live one.
  return Array.from(new Set([...primary, ...fallbacks]));
}

/** True when there is more than one place to look. */
export function failoverAvailable(): boolean {
  return originCandidates().length > 1;
}

type Remembered = { origin: string; at: number };

function readRemembered(): Remembered | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Remembered;
    if (!parsed?.origin || typeof parsed.at !== 'number') return null;
    // Only honour an origin that is still in the configured list; a deployment
    // may have retired the host this browser remembered.
    if (!originCandidates().includes(parsed.origin)) return null;
    if (Date.now() - parsed.at > STICKY_MS) return null;
    return parsed;
  } catch {
    return null; // storage disabled or corrupt — fall back to the list order
  }
}

function remember(origin: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ origin, at: Date.now() }));
  } catch { /* private mode / quota — failover still works, just not sticky */ }
}

function forget(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/** The origin currently in use. Synchronous: callers build URLs with it. */
let active: string | null = null;

/**
 * The origin to send requests to right now.
 *
 * Returns '' for a same-origin deployment, which is what the existing callers
 * already expect from an unset VITE_API_URL — relative paths resolve against
 * the page. That keeps this module inert for the standard web deploy.
 */
export function currentOrigin(): string {
  if (active !== null) return active;
  const remembered = readRemembered();
  active = remembered?.origin ?? originCandidates()[0] ?? '';
  return active;
}

/** Is this origin reachable? A cheap, idempotent, unauthenticated GET. */
async function probe(origin: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // /health/live is the liveness probe: it answers as long as the process is
    // up, without touching a database. Readiness would report unhealthy on a
    // draining instance, which is a reason to prefer another origin — but here
    // we only need to know whether anyone is home.
    const res = await fetch(`${origin}/health/live`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false; // DNS failure, TLS failure, connection refused, timeout, blocked
  } finally {
    clearTimeout(timer);
  }
}

/** Guards against several concurrent failures all starting their own search. */
let inFlight: Promise<string | null> | null = null;

/**
 * Walk the candidate list and adopt the first origin that answers.
 *
 * Sequential, not parallel: the list is in preference order, and racing them
 * would adopt whichever is momentarily fastest rather than the one the operator
 * put first. The cost is bounded — an unreachable origin fails on DNS or
 * connect long before PROBE_TIMEOUT_MS in the common case.
 *
 * @returns the adopted origin, or null when every candidate is unreachable
 *          (which is a genuine outage, not a failover case).
 */
export function resolveWorkingOrigin(): Promise<string | null> {
  if (inFlight) return inFlight;

  const search = (async () => {
    const candidates = originCandidates();
    if (candidates.length === 0) return '';   // same-origin deploy: nothing to do

    for (const candidate of candidates) {
      if (await probe(candidate)) {
        if (candidate !== active) {
          console.info(`[origin] using ${candidate}`);
        }
        active = candidate;
        remember(candidate);
        return candidate;
      }
      console.warn(`[origin] ${candidate} did not answer — trying the next`);
    }

    // Everything is down. Keep the current origin so the app retries against a
    // real host rather than an empty string, and let the caller surface it.
    console.error('[origin] no configured origin answered');
    return null;
  })();

  inFlight = search;
  // Clear the guard only if it still refers to THIS search. Without the
  // identity check, a search that finishes after a newer one started would
  // null out the newer promise and let a third caller start a duplicate walk.
  void search.finally(() => { if (inFlight === search) inFlight = null; });
  return search;
}

/**
 * Report that a request failed at the TRANSPORT level against `origin` — DNS,
 * TLS, connection refused, timeout. NOT for HTTP error statuses: a 500 means
 * the origin answered, and moving away from a host that is talking to us would
 * turn a server bug into a multi-origin outage.
 *
 * Returns the origin to use for the retry, or null if nothing is reachable.
 */
export async function reportOriginUnreachable(origin: string): Promise<string | null> {
  if (!failoverAvailable()) return null;      // single origin — nowhere to go

  // Materialise the active origin first. Reading the module variable directly
  // here was a bug: before anything has resolved it is null, so the very first
  // failure — the one that matters most, when the primary is blocked and the
  // user has not got a request through yet — compared against null, took the
  // "already moved on" branch, and returned null instead of searching.
  const inUse = currentOrigin();
  if (origin !== inUse) return inUse;         // already moved on; use the new one

  forget();
  active = null;
  return resolveWorkingOrigin();
}

/**
 * Kick off a background check at startup so a user whose primary origin is
 * blocked lands on a working one before their first real request, rather than
 * after it times out. Fire-and-forget by design: nothing waits on it, and the
 * app is fully usable if it never completes.
 */
export function primeOrigin(): void {
  if (!failoverAvailable()) return;
  const remembered = readRemembered();
  if (remembered) { active = remembered.origin; return; }
  void resolveWorkingOrigin();
}
