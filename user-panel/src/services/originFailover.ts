// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * services/originFailover.ts — which API origin this app talks to, and when it
 * may start talking to it.
 *
 * ── Startup order (owner, 2026-10-09) ───────────────────────────────────────
 *   Launch → LoadingScreen → discover → VALIDATE → adopt (API client ready)
 *   → session → realtime → application state → main app.
 * Nothing may open an API, game or realtime connection before `whenEndpointReady()`
 * resolves: `apiClient`, `realBackend` (HTTP, SSE and Socket.IO) all await it.
 * `App.tsx`'s `EndpointGate` drives `bootstrapApiEndpoint()` and shows the
 * retry screen when it fails.
 *
 * ── Where an origin can come from — all fixed at BUILD time ─────────────────
 *   VITE_API_URL             primary origin
 *   VITE_API_BACKUP_URL      ONE explicitly configured backup origin
 *   VITE_API_DISCOVERY_URL   HTTPS URL answering {"url": "https://…"}
 *   VITE_API_ALLOWED_HOSTS   extra exact hostnames discovery may name
 *
 * The discovery answer is UNTRUSTED input. It can only choose among hosts this
 * build already trusts (the primary's, the backup's, and the allowed list):
 * exact hostname match, no wildcard, no IP literal, https only (http only for
 * localhost in a dev build), no credentials, port, path, query or fragment.
 * Nothing it says can add a host. TLS validation is the platform's and is
 * never relaxed — a certificate failure is just an unreachable origin.
 *
 * ── Why a probe rather than "retry the next one on error" ───────────────────
 * A failed money request must not be replayed against another origin: a POST
 * whose response was lost may have been applied. Failover therefore changes
 * which origin the NEXT request goes to, decided by an idempotent GET of
 * /health/live; only idempotent requests are retried (see `apiClient`).
 *
 * This is availability engineering (a configured host stopped answering), not
 * circumvention: every candidate is set at build time and identical for every
 * user, and the client takes no IP, geo or ISP as input.
 */

/** How long a single origin gets to answer the health probe. */
const PROBE_TIMEOUT_MS = 4000;
/** How long one discovery request may take. */
const DISCOVERY_TIMEOUT_MS = 5000;
/** Discovery attempts before falling back to the configured origins. */
const DISCOVERY_ATTEMPTS = 3;
/** Backoff before discovery attempt n+1 (ms). */
const DISCOVERY_BACKOFF_MS = [500, 1500];
/** A discovery answer larger than this is not a `{url}` document. */
const DISCOVERY_MAX_BYTES = 4096;
/** Transport failures closer together than this share one failover search. */
const FAILOVER_COOLDOWN_MS = 10_000;

/**
 * Build-time configuration. Vite inlines `import.meta.env` into the bundle, so
 * that is the real source in the browser; `process.env` is consulted first only
 * because it is what exists in a non-browser context (tests), where
 * `import.meta.env` carries no VITE_ values.
 */
export function readEnv(name: string): string {
  const fromProcess = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  if (fromProcess) return fromProcess;
  return (import.meta as any).env?.[name] ?? '';
}

function isProductionBuild(): boolean {
  const mode = readEnv('MODE') || ((import.meta as any).env?.PROD ? 'production' : '');
  return mode === 'production' || readEnv('NODE_ENV') === 'production';
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function hostOf(origin: string): string {
  try { return new URL(origin).hostname.toLowerCase().replace(/\.$/, ''); } catch { return ''; }
}

// ── Policy ────────────────────────────────────────────────────────────────────
export type OriginPolicy = { allowedHosts: string[]; production: boolean };

/**
 * Validate an origin against the policy. Returns the normalised origin
 * (`https://host`) or null. Pure — this is the whole trust decision.
 */
export function validateApiOrigin(raw: unknown, policy: OriginPolicy): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return null;
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const loopback = LOOPBACK.has(host);
  const devLoopback = !policy.production && loopback;

  if (url.protocol !== 'https:' && !(devLoopback && url.protocol === 'http:')) return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (url.port && !devLoopback) return null;
  if (loopback && policy.production) return null;
  // An address is never an API origin here: certificates are issued for
  // names, and a name is what the operator allowlisted.
  if (!loopback && (IPV4.test(host) || host.includes(':') || host.startsWith('['))) return null;
  if (!policy.allowedHosts.includes(host)) return null;
  return `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`;
}

/** The configured origins, normalised; malformed or non-https ones are dropped. */
function configuredOrigin(name: string, production: boolean): string {
  const raw = readEnv(name).trim();
  if (!raw) return '';
  // Configured origins are trusted for their HOST, but still held to the
  // transport rules: a build with an http:// primary refuses it rather than
  // speak plaintext (scripts/assert-native-env.mjs refuses the native build).
  return validateApiOrigin(raw.replace(/\/+$/, ''), { allowedHosts: [hostOf(raw)], production }) ?? '';
}

export function originPolicy(): OriginPolicy {
  const production = isProductionBuild();
  const listed = readEnv('VITE_API_ALLOWED_HOSTS')
    .split(',').map((h) => h.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean)
    // An entry that is not a plain hostname (a wildcard, a URL, an address)
    // is dropped, never interpreted.
    .filter((h) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h) && !IPV4.test(h));
  const fromConfig = [configuredOrigin('VITE_API_URL', production), configuredOrigin('VITE_API_BACKUP_URL', production)]
    .filter(Boolean).map(hostOf);
  return { allowedHosts: Array.from(new Set([...fromConfig, ...listed])), production };
}

/** Primary then backup — the explicitly configured origins, in order. */
export function configuredOrigins(): string[] {
  const production = isProductionBuild();
  return Array.from(new Set(
    [configuredOrigin('VITE_API_URL', production), configuredOrigin('VITE_API_BACKUP_URL', production)].filter(Boolean),
  ));
}

/** Every origin this build trusts, as https origins (deep links use this). */
export function trustedApiOrigins(): string[] {
  const { allowedHosts } = originPolicy();
  return Array.from(new Set([...configuredOrigins(), ...allowedHosts.map((h) => `https://${h}`)]));
}

export function discoveryUrl(): string {
  const raw = readEnv('VITE_API_DISCOVERY_URL').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const devLoopback = !isProductionBuild() && LOOPBACK.has(u.hostname);
    if (u.protocol !== 'https:' && !(devLoopback && u.protocol === 'http:')) return '';
    if (u.username || u.password) return '';
    return u.toString();
  } catch { return ''; }
}

// ── Observability (client side) ──────────────────────────────────────────────
// Counters the app can show or report; never a token, never a user id.
export type EndpointEvent =
  | { kind: 'discovery_ok'; origin: string; ms: number }
  | { kind: 'discovery_failed'; reason: string; attempt: number }
  | { kind: 'adopted'; origin: string; source: 'discovery' | 'configured' | 'same-origin' }
  | { kind: 'failover'; from: string; to: string | null }
  | { kind: 'unavailable' };

export const endpointStats = {
  discoveryOk: 0, discoveryFailed: 0, failovers: 0, lastEvent: null as EndpointEvent | null,
};

// Reported to the server (`POST /api/v1/client/endpoint-events`, counted on
// /metrics as bb_client_endpoint_events_total) once an origin is reachable:
// kinds, sources and reasons only — never a host, a token or an id.
type Report = { kind: EndpointEvent['kind']; source: string; reason: string };
const pending: Report[] = [];
const MAX_PENDING = 20;

function reportOf(e: EndpointEvent): Report {
  switch (e.kind) {
    case 'discovery_ok': return { kind: e.kind, source: 'discovery', reason: 'none' };
    case 'discovery_failed': return { kind: e.kind, source: 'discovery', reason: e.reason };
    case 'adopted': return { kind: e.kind, source: e.source, reason: 'none' };
    case 'failover': return { kind: e.kind, source: e.to ? 'configured' : 'none', reason: e.to ? 'none' : 'unreachable' };
    default: return { kind: e.kind, source: 'none', reason: 'unreachable' };
  }
}

function flushReports(): void {
  if (state !== 'ready' || pending.length === 0) return;
  const events = pending.splice(0, pending.length);
  try {
    void fetch(`${active}/api/v1/client/endpoint-events`, {
      method: 'POST', credentials: 'omit', keepalive: true, redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events }),
    }).catch(() => { /* telemetry is best-effort */ });
  } catch { /* no fetch — nothing to report with */ }
}

function record(e: EndpointEvent): void {
  // A same-origin deploy discovered nothing; there is nothing to report.
  const sameOrigin = e.kind === 'adopted' && e.source === 'same-origin';
  if (!sameOrigin && pending.length < MAX_PENDING) pending.push(reportOf(e));
  endpointStats.lastEvent = e;
  if (e.kind === 'discovery_ok') endpointStats.discoveryOk += 1;
  if (e.kind === 'discovery_failed') endpointStats.discoveryFailed += 1;
  if (e.kind === 'failover') endpointStats.failovers += 1;
  const level = e.kind === 'discovery_failed' || e.kind === 'unavailable' ? 'warn' : 'info';
  console[level]('[endpoint]', e);
}

// ── State ─────────────────────────────────────────────────────────────────────
type State = 'idle' | 'resolving' | 'ready' | 'failed';
let state: State = 'idle';
let active = '';
let discovered = '';
let lastSearchAt = 0;

let readyResolve: (o: string) => void = () => {};
const readyPromise: Promise<string> = new Promise((r) => { readyResolve = r; });

type Listener = (origin: string) => void;
const listeners = new Set<Listener>();

/** Called with the new origin whenever the adopted origin changes. */
export function onOriginChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function adopt(origin: string, source: 'discovery' | 'configured' | 'same-origin'): string {
  const changed = state === 'ready' && origin !== active;
  active = origin;
  state = 'ready';
  record({ kind: 'adopted', origin: origin || '(same origin)', source });
  readyResolve(origin);
  flushReports();
  if (changed) listeners.forEach((fn) => { try { fn(origin); } catch { /* a listener never stops failover */ } });
  return origin;
}

export function endpointState(): State { return state; }

/**
 * Resolves with the adopted origin once the endpoint is validated. Every
 * connection-opening path awaits this; it never resolves to an unvalidated host.
 */
export function whenEndpointReady(): Promise<string> { return readyPromise; }

/**
 * The origin to send requests to right now. '' means same-origin (relative
 * paths) — and is also what is returned before the endpoint is ready, so a URL
 * built early (an <img> on the loading screen) resolves against the page
 * itself and never against an unvalidated host.
 */
export function currentOrigin(): string {
  return state === 'ready' ? active : '';
}

/** True when there is somewhere else to go. */
export function failoverAvailable(): boolean {
  return candidateOrder().length > 1;
}

/**
 * Where to look, in order: the discovered origin (Admin > Settings > API Host),
 * the configured primary, the configured backup, then every other host on the
 * build-time allowlist (VITE_API_ALLOWED_HOSTS). Each is a host this build
 * already trusts, so failing over across all of them adds no trust.
 */
export function candidateOrder(): string[] {
  return Array.from(new Set([discovered, ...trustedApiOrigins()].filter(Boolean)));
}

// ── Network ───────────────────────────────────────────────────────────────────
async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await run(controller.signal); } finally { clearTimeout(timer); }
}

/** Is this origin reachable? A cheap, idempotent, unauthenticated GET. */
export async function probe(origin: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    const res = await withTimeout(timeoutMs, (signal) => fetch(`${origin}/health/live`, {
      method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error', signal,
    }));
    return res.ok;
  } catch {
    return false; // DNS failure, TLS failure, connection refused, timeout
  }
}

/**
 * One discovery request. Throws a short reason on any failure; returns the
 * VALIDATED origin. No credentials or auth headers are sent, redirects are
 * refused (a redirect is a second, unvalidated host), and the body is capped.
 */
export async function discoverOnce(url: string, policy: OriginPolicy): Promise<string> {
  const res = await withTimeout(DISCOVERY_TIMEOUT_MS, (signal) => fetch(url, {
    method: 'GET', cache: 'no-store', credentials: 'omit', redirect: 'error',
    referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal,
  })).catch((e) => { throw new Error(e?.name === 'AbortError' ? 'timeout' : 'unreachable'); });
  if (!res.ok) throw new Error(`http_${res.status}`);
  const text = await res.text();
  if (text.length > DISCOVERY_MAX_BYTES) throw new Error('too_large');
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new Error('invalid_json'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_shape');
  const origin = validateApiOrigin((body as { url?: unknown }).url, policy);
  if (!origin) throw new Error('rejected_url');
  return origin;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let bootInFlight: Promise<string | null> | null = null;

/**
 * Discover, validate and adopt the API origin. Resolves with the origin, or
 * null when nothing trusted answered — the caller shows the retry screen and
 * calls this again. Never adopts an origin that failed validation.
 *
 *   1. No discovery URL and no configured origin: a same-origin web deploy.
 *   2. Discovery (bounded attempts, each with a timeout) → validate → probe.
 *   3. Discovery failed, or its origin did not answer: the configured primary,
 *      the configured backup, then every allowlisted host, each probed.
 */
export function bootstrapApiEndpoint(): Promise<string | null> {
  if (state === 'ready') return Promise.resolve(active);
  if (bootInFlight) return bootInFlight;
  state = 'resolving';

  const run = (async () => {
    const dUrl = discoveryUrl();
    const configured = configuredOrigins();
    if (!dUrl && configured.length === 0) return adopt('', 'same-origin');

    if (dUrl) {
      const policy = originPolicy();
      for (let attempt = 1; attempt <= DISCOVERY_ATTEMPTS; attempt += 1) {
        const started = Date.now();
        try {
          const origin = await discoverOnce(dUrl, policy);
          record({ kind: 'discovery_ok', origin, ms: Date.now() - started });
          discovered = origin;
          break;
        } catch (e: any) {
          record({ kind: 'discovery_failed', reason: String(e?.message || 'error'), attempt });
          // A rejected answer is not retried: asking again gets the same answer.
          if (e?.message === 'rejected_url' || attempt === DISCOVERY_ATTEMPTS) break;
          await sleep(DISCOVERY_BACKOFF_MS[attempt - 1] ?? 1500);
        }
      }
    }

    for (const candidate of candidateOrder()) {
      if (await probe(candidate)) return adopt(candidate, candidate === discovered ? 'discovery' : 'configured');
    }
    // A single configured origin with no discovery: nothing to compare it
    // with, so adopt it and let requests report the outage (the old behaviour).
    if (!dUrl && configured.length === 1) return adopt(configured[0], 'configured');

    state = 'failed';
    record({ kind: 'unavailable' });
    return null;
  })();

  bootInFlight = run;
  void run.finally(() => { if (bootInFlight === run) bootInFlight = null; });
  return run;
}

let searchInFlight: Promise<string | null> | null = null;

/**
 * Report that a request failed at the TRANSPORT level against `origin` — DNS,
 * TLS, connection refused, timeout. NOT for HTTP error statuses: a 500 means
 * the origin answered, and leaving a host that is talking to us would turn a
 * server bug into a multi-origin outage.
 *
 * Probes the trusted candidates (discovered, primary, backup, the rest of the
 * allowlist) in order and
 * adopts the first that answers. Returns the origin to use next, or null.
 */
export function reportOriginUnreachable(origin: string): Promise<string | null> {
  if (state !== 'ready' || !failoverAvailable()) return Promise.resolve(null);
  if (origin !== active) return Promise.resolve(active);   // already moved on
  if (searchInFlight) return searchInFlight;
  if (Date.now() - lastSearchAt < FAILOVER_COOLDOWN_MS) return Promise.resolve(active);
  lastSearchAt = Date.now();

  const search = (async () => {
    for (const candidate of candidateOrder()) {
      if (await probe(candidate)) {
        if (candidate !== active) {
          record({ kind: 'failover', from: active, to: candidate });
          adopt(candidate, candidate === discovered ? 'discovery' : 'configured');
        }
        return candidate;
      }
    }
    record({ kind: 'failover', from: active, to: null });
    return null;   // reported with the next successful adoption
  })();
  searchInFlight = search;
  void search.finally(() => { if (searchInFlight === search) searchInFlight = null; });
  return search;
}
