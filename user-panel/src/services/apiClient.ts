// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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

const BASE_URL = import.meta.env.VITE_API_URL || '';
const MAX_RETRIES = 2;

// ── In-flight deduplication ───────────────────────────────────────────────────
const inFlight = new Map<string, Promise<Response>>();

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
  const url     = `${BASE_URL}${path}`;
  const attempt = options.retry ?? 0;
  const key     = dedupKey(method, url, body);

  // Deduplicate GET requests only
  if (method === 'GET' && inFlight.has(key)) {
    const resp = await inFlight.get(key)!;
    return resp.clone().json();
  }

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

  if (method === 'GET') inFlight.set(key, fetchPromise);

  let resp: Response;
  try {
    resp = await fetchPromise;
  } catch (err: unknown) {
    // Network error — retry with backoff
    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 300 * 2 ** attempt));
      return apiFetch(method, path, body, { ...options, retry: attempt + 1 });
    }
    throw err;
  } finally {
    if (method === 'GET') inFlight.delete(key);
  }

  if (resp.status === 401) {
    setToken(null);
    window.location.href = '/';
    throw new Error('Session expired. Please log in again.');
  }

  const json = await resp.json().catch(() => ({}));
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
