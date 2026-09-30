// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * services/apiClient.ts — Unified API client for BettingBazaar
 *
 * Single source of truth for all HTTP requests.
 * Replaces the scattered localStorage.getItem('auth_token') calls.
 *
 * Features:
 *   ✓ Automatic auth header injection (cookie-first, header fallback)
 *   ✓ 401 handling with automatic redirect to login
 *   ✓ Request deduplication (prevents duplicate in-flight calls)
 *   ✓ Retry with exponential backoff (network errors only)
 *   ✓ Typed response helpers
 */

declare global {
  interface Window { __bbAuthToken__?: string | null; }
}

import { currentOrigin, reportOriginUnreachable, failoverAvailable } from './originFailover';

// Resolved per request, not once at module load: when the configured origin
// stops answering, originFailover adopts the next one and every subsequent
// request follows without a reload. With a single configured origin this
// returns exactly what the old `import.meta.env.VITE_API_URL || ''` did.
const MAX_RETRIES = 2;

// ── The channel gate ──────────────────────────────────────────────────────────
/**
 * Betting, games and the wallet require membership of the official Telegram
 * channel, and that channel is replaceable: when an operator swaps it, every
 * cached membership goes stale in the same instant and the server starts
 * answering 403 CHANNEL_MEMBERSHIP_REQUIRED — carrying the NEW invite link.
 *
 * Handled here, once, rather than at each call site. A player who is halfway
 * through a deposit and a player tapping a game must both be told the same
 * thing, and there are dozens of call sites that would each have to remember.
 *
 * The refusal is still thrown to the caller: the page that asked must still see
 * its request fail, so nothing renders as though it had succeeded. This only
 * adds the prompt on top.
 */
export interface ChannelGateEvent {
  code: 'CHANNEL_MEMBERSHIP_REQUIRED' | 'TELEGRAM_NOT_LINKED';
  message: string;
  telegram?: { inviteLink?: string; channelUsername?: string; botUsername?: string; generation?: number } | null;
}

type GateListener = (e: ChannelGateEvent) => void;
const gateListeners = new Set<GateListener>();

export function onChannelGate(fn: GateListener): () => void {
  gateListeners.add(fn);
  return () => { gateListeners.delete(fn); };
}

function announceGate(json: any): void {
  const code = json?.code;
  if (code !== 'CHANNEL_MEMBERSHIP_REQUIRED' && code !== 'TELEGRAM_NOT_LINKED') return;
  const event: ChannelGateEvent = { code, message: json?.message || '', telegram: json?.telegram ?? null };
  // A listener that throws must not swallow the refusal for everyone else.
  gateListeners.forEach(fn => { try { fn(event); } catch { /* ignore */ } });
}

// ── In-flight deduplication ───────────────────────────────────────────────────
/**
 * The map holds the PARSED RESULT, not the `Response`.
 *
 * ── Why, and what the Response version actually did ────────────────────────
 * It used to hold `Promise<Response>`, and the second caller of a duplicated
 * GET did `resp.clone().json()`. `Response.clone()` throws once the body is
 * DISTURBED — and the first caller starts reading the body the instant it
 * stops awaiting, which is the same tick the second caller wakes up on. So the
 * two raced for the body, and whenever the first won, the second threw
 *
 *     Failed to execute 'clone' on 'Response': Response body is already used
 *
 * …into whatever `catch` happened to be around it. On the wallet screen that
 * is `loadMeta`'s, which logs and returns — so the balances, the stake ceiling
 * and the settlement rail were never set, and the player read a wallet of
 * zeroes with no error on the screen. Nondeterministic, silent, and only ever
 * visible with a browser open, which is why it survived every tier (§28).
 *
 * Sharing the parsed value has no such window: it is an ordinary promise, every
 * caller awaits the same settled result, and a rejection reaches all of them.
 * The entry is removed when it settles, so this is deduplication of concurrent
 * calls and never a cache — a later GET goes to the network as it should.
 *
 * What it does NOT change: two callers passing different `AbortSignal`s still
 * share one request, so one aborting ends it for both. That was already true
 * when they shared the Response, and it is the price of deduplicating at all.
 */
const inFlight = new Map<string, Promise<unknown>>();

function dedupKey(method: string, url: string, body?: unknown): string {
  return `${method}:${url}:${JSON.stringify(body ?? '')}`;
}

// ── Token helpers ─────────────────────────────────────────────────────────────
function getToken(): string | null {
  // Prefer HttpOnly cookie (set by server) — no JS access needed.
  // Header token is only used when cookie transport isn't available (dev/mobile).
  return typeof window !== 'undefined'
    ? window.__bbAuthToken__ ?? localStorage.getItem('auth_token')
    : null;
}

// Exposed so AuthContext can refresh it without touching localStorage directly.
export function setToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  (window as any).__bbAuthToken__ = token;
  if (token) localStorage.setItem('auth_token', token);
  else        localStorage.removeItem('auth_token');
}

// ── Core fetch wrapper ────────────────────────────────────────────────────────
async function apiFetch(
  method: string,
  path: string,
  body?: unknown,
  options: { retry?: number; signal?: AbortSignal } = {}
): Promise<unknown> {
  // Deduplicate GET requests only. A retry re-enters through `performFetch`
  // directly, not here, so a retry of a shared call stays that one shared call.
  if (method !== 'GET') return performFetch(method, path, body, options);

  const key = dedupKey('GET', `${currentOrigin()}${path}`, body);
  const running = inFlight.get(key);
  if (running) return running;

  const shared = performFetch(method, path, body, options);
  inFlight.set(key, shared);
  // Settled — not resolved. A rejected request must clear the slot too, or one
  // failure pins every later caller to it for the life of the tab.
  void shared.catch(() => {}).finally(() => { if (inFlight.get(key) === shared) inFlight.delete(key); });
  return shared;
}

async function performFetch(
  method: string,
  path: string,
  body?: unknown,
  options: { retry?: number; signal?: AbortSignal } = {}
): Promise<unknown> {
  const origin  = currentOrigin();
  const url     = `${origin}${path}`;
  const attempt = options.retry ?? 0;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const fetchPromise = fetch(url, {
    method,
    headers,
    credentials: 'include',
    body:        body !== undefined ? JSON.stringify(body) : undefined,
    signal:      options.signal,
  });

  let resp: Response;
  try {
    resp = await fetchPromise;
  } catch (err: unknown) {
    // TRANSPORT failure only — DNS, TLS, connection refused, timeout. An HTTP
    // error status does not land here, which is deliberate: a 500 means the
    // origin answered, and abandoning a host that is talking to us would turn
    // a server-side bug into a multi-origin outage.
    if (attempt < MAX_RETRIES) {
      // Before retrying, give the failover a chance to move to an origin that
      // is actually reachable, so the retry is not aimed at the same dead host.
      if (failoverAvailable()) await reportOriginUnreachable(origin);
      await new Promise(r => setTimeout(r, 300 * 2 ** attempt));
      return performFetch(method, path, body, { ...options, retry: attempt + 1 });
    }
    throw err;
  }

  if (resp.status === 401) {
    setToken(null);
    window.location.href = '/';
    throw new Error('Session expired. Please log in again.');
  }

  const json = await resp.json().catch(() => ({}));
  if (resp.status === 403) announceGate(json);
  if (!resp.ok) throw Object.assign(new Error(json?.message ?? resp.statusText), { status: resp.status, data: json });
  return json;
}

// ── Public helpers ────────────────────────────────────────────────────────────
export const apiClient = {
  get:    <T = unknown>(path: string, signal?: AbortSignal) =>
            apiFetch('GET',    path, undefined, { signal }) as Promise<T>,
  post:   <T = unknown>(path: string, body?: unknown) =>
            apiFetch('POST',   path, body) as Promise<T>,
  put:    <T = unknown>(path: string, body?: unknown) =>
            apiFetch('PUT',    path, body) as Promise<T>,
  patch:  <T = unknown>(path: string, body?: unknown) =>
            apiFetch('PATCH',  path, body) as Promise<T>,
  delete: <T = unknown>(path: string) =>
            apiFetch('DELETE', path) as Promise<T>,
};

export default apiClient;
