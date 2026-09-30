// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * Two screens asking for the same thing at the same moment must BOTH get it.
 *
 * ── The defect this exists for ──────────────────────────────────────────────
 * The GET deduplicator used to hold the `Response` and hand the second caller
 * `resp.clone().json()`. A `Response` may only be cloned while its body is
 * UNDISTURBED, and the first caller starts reading the body on the same tick
 * the second one wakes up — so the two raced, and when the first won, the
 * second threw `Failed to execute 'clone' on 'Response': Response body is
 * already used`.
 *
 * On the wallet screen that rejection landed in `loadMeta`'s catch, which logs
 * and returns, so the balances, the stake ceiling and the settlement rail were
 * simply never set: a player looking at a wallet of zeroes with nothing on the
 * screen saying anything had gone wrong. It was found with a browser open and
 * could not have been found any other way (§28) — no route test has two
 * components in it.
 *
 * `fetch` here counts calls and returns a REAL `Response`, because a plain
 * object with a `json()` method cannot reproduce the bug: the whole defect
 * lives in the body-disturbed rule, which only a real Response has.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const body = { success: true, deposit: 1000, winnings: 250 };

async function load(fetchImpl: typeof fetch) {
  vi.resetModules();
  vi.stubGlobal('fetch', fetchImpl);
  vi.stubGlobal('localStorage', {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
  } as unknown as Storage);
  return (await import('./apiClient')).apiClient;
}

/** One real Response per call, resolving on a later tick so callers overlap. */
function countingFetch() {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string) => {
    calls.push(String(url));
    await new Promise((r) => setTimeout(r, 5));
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

describe('apiClient GET deduplication', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('gives BOTH concurrent callers the parsed body, from one request', async () => {
    const { calls, impl } = countingFetch();
    const api = await load(impl);

    const [a, b] = await Promise.all([
      api.get<typeof body>('/api/user/bet-limits'),
      api.get<typeof body>('/api/user/bet-limits'),
    ]);

    // The point of the deduplicator: one network call.
    expect(calls.length).toBe(1);
    // The point of this test: the SECOND caller is not handed an exception.
    expect(a).toEqual(body);
    expect(b).toEqual(body);
  });

  it('is deduplication, not a cache — a later call goes to the network', async () => {
    const { calls, impl } = countingFetch();
    const api = await load(impl);

    await api.get('/api/user/bet-limits');
    await api.get('/api/user/bet-limits');

    expect(calls.length).toBe(2);
  });

  it('does not conflate two different paths', async () => {
    const { calls, impl } = countingFetch();
    const api = await load(impl);

    await Promise.all([
      api.get('/api/user/bet-limits'),
      api.get('/api/v1/system/config'),
    ]);

    expect(calls.length).toBe(2);
  });

  it('a failed request clears its slot instead of pinning every later caller', async () => {
    let attempt = 0;
    const impl = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response(JSON.stringify({ message: 'nope' }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(body), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const api = await load(impl);

    await expect(api.get('/api/user/bet-limits')).rejects.toThrow();
    // A slot left holding a rejection would make this reject too, forever.
    await expect(api.get('/api/user/bet-limits')).resolves.toEqual(body);
  });

  it('both concurrent callers see the same rejection, not one silent success', async () => {
    const impl = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return new Response(JSON.stringify({ message: 'nope' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const api = await load(impl);

    const results = await Promise.allSettled([
      api.get('/api/user/bet-limits'),
      api.get('/api/user/bet-limits'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  });
});
