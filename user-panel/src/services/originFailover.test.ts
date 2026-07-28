// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * Origin failover — the client's answer to "the hostname stopped responding".
 *
 * These assert the behaviour that matters operationally: the list is walked in
 * the operator's order, the winner is remembered, a dead host is abandoned, and
 * a total outage is reported as such rather than silently pretending to work.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const A = 'https://a.example.com';
const B = 'https://b.example.com';
const C = 'https://c.example.com';

/**
 * Load the module fresh with a given build-time configuration. The candidate
 * list is read from import.meta.env at call time, so each case gets a clean
 * module instance with its own env.
 */
async function load(env: Record<string, string>) {
  vi.unstubAllEnvs();
  vi.stubEnv('VITE_API_URL', env.VITE_API_URL ?? '');
  vi.stubEnv('VITE_API_FALLBACK_URLS', env.VITE_API_FALLBACK_URLS ?? '');
  vi.resetModules();
  return import('./originFailover');
}

/** fetch stub where only the listed origins answer /health/live. */
function fetchOnlyReaching(alive: string[]) {
  return vi.fn(async (url: string) => {
    const origin = String(url).replace('/health/live', '');
    if (alive.includes(origin)) return { ok: true } as Response;
    throw new TypeError('Failed to fetch'); // what a browser throws on DNS/TLS/refused
  });
}

let store: Record<string, string> = {};

beforeEach(() => {
  store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('originFailover', () => {
  describe('candidate list', () => {
    it('is inert for a same-origin deployment', async () => {
      const m = await load({});
      expect(m.originCandidates()).toEqual([]);
      expect(m.failoverAvailable()).toBe(false);
      // '' keeps relative /api paths resolving against the page, exactly as
      // before this module existed.
      expect(m.currentOrigin()).toBe('');
    });

    it('keeps the operator order and drops duplicates', async () => {
      const m = await load({ VITE_API_URL: A, VITE_API_FALLBACK_URLS: `${B}, ${A} ,${C}` });
      expect(m.originCandidates()).toEqual([A, B, C]);
    });

    it('normalises trailing slashes so URLs do not double up', async () => {
      const m = await load({ VITE_API_URL: `${A}/`, VITE_API_FALLBACK_URLS: `${B}//` });
      expect(m.originCandidates()).toEqual([A, B]);
    });

    it('reports no failover when only one origin is configured', async () => {
      const m = await load({ VITE_API_URL: A });
      expect(m.failoverAvailable()).toBe(false);
    });
  });

  describe('resolution', () => {
    it('adopts the first origin that answers', async () => {
      vi.stubGlobal('fetch', fetchOnlyReaching([A, B]));
      const m = await load({ VITE_API_URL: A, VITE_API_FALLBACK_URLS: B });
      expect(await m.resolveWorkingOrigin()).toBe(A);
    });

    it('walks past a dead primary to the first live alternate', async () => {
      vi.stubGlobal('fetch', fetchOnlyReaching([C]));
      const m = await load({ VITE_API_URL: A, VITE_API_FALLBACK_URLS: `${B},${C}` });
      expect(await m.resolveWorkingOrigin()).toBe(C);
      expect(m.currentOrigin()).toBe(C);
    });

    it('returns null when every origin is unreachable — a real outage, not a failover', async () => {
      vi.stubGlobal('fetch', fetchOnlyReaching([]));
      const m = await load({ VITE_API_URL: A, VITE_API_FALLBACK_URLS: B });
      expect(await m.resolveWorkingOrigin()).toBeNull();
    });

    it('remembers the winner so the next load does not re-walk the list', async () => {
      vi.stubGlobal('fetch', fetchOnlyReaching([B]));
      const m = await load({ VITE_API_URL: A, VITE_API_FALLBACK_URLS: B });
      await m.resolveWorkingOrigin();
      expect(JSON.parse(store.bb_api_origin).origin).toBe(B);

      const m2 = await load({ VITE_API_URL: A, VITE_API_FALLBACK_URLS: B });
      expect(m2.currentOrigin()).toBe(B);   // straight to the working host
    });

    it('ignores a remembered origin that is no longer configured', async () => {
      store.bb_api_origin = JSON.stringify({ origin: 'https://retired.example.com', at: Date.now() });
      const m = await load({ VITE_API_URL: A, VITE_API_FALLBACK_URLS: B });
      expect(m.currentOrigin()).toBe(A);
    });

    it('stops trusting a remembered origin once it is stale, so a recovered primary is retried', async () => {
      store.bb_api_origin = JSON.stringify({ origin: B, at: Date.now() - 31 * 60 * 1000 });
      const m = await load({ VITE_API_URL: A, VITE_API_FALLBACK_URLS: B });
      expect(m.currentOrigin()).toBe(A);
    });

    it('survives storage being unavailable (private mode)', async () => {
      vi.stubGlobal('localStorage', {
        getItem: () => { throw new Error('denied'); },
        setItem: () => { throw new Error('denied'); },
        removeItem: () => { throw new Error('denied'); },
      });
      vi.stubGlobal('fetch', fetchOnlyReaching([B]));
      const m = await load({ VITE_API_URL: A, VITE_API_FALLBACK_URLS: B });
      expect(await m.resolveWorkingOrigin()).toBe(B); // works, just not sticky
    });

    it('coalesces concurrent searches into one walk', async () => {
      const fetchMock = fetchOnlyReaching([B]);
      vi.stubGlobal('fetch', fetchMock);
      const m = await load({ VITE_API_URL: A, VITE_API_FALLBACK_URLS: B });

      const [x, y, z] = await Promise.all([
        m.resolveWorkingOrigin(), m.resolveWorkingOrigin(), m.resolveWorkingOrigin(),
      ]);
      expect([x, y, z]).toEqual([B, B, B]);
      // One walk = one probe per candidate, not three.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('reporting a dead origin', () => {
    it('moves to the next live origin', async () => {
      vi.stubGlobal('fetch', fetchOnlyReaching([B]));
      const m = await load({ VITE_API_URL: A, VITE_API_FALLBACK_URLS: B });
      expect(m.currentOrigin()).toBe(A);
      expect(await m.reportOriginUnreachable(A)).toBe(B);
    });

    it('does nothing when there is nowhere else to go', async () => {
      vi.stubGlobal('fetch', fetchOnlyReaching([]));
      const m = await load({ VITE_API_URL: A });
      expect(await m.reportOriginUnreachable(A)).toBeNull();
    });

    it('ignores a report for an origin already moved past', async () => {
      vi.stubGlobal('fetch', fetchOnlyReaching([B]));
      const m = await load({ VITE_API_URL: A, VITE_API_FALLBACK_URLS: B });
      await m.reportOriginUnreachable(A);            // now on B
      // A late failure from the old host must not restart the search.
      expect(await m.reportOriginUnreachable(A)).toBe(B);
    });
  });
});
