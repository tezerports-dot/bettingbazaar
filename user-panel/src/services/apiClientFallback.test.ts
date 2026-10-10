// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * A display read asked with `staleOnError` survives an outage with its last
 * good answer; nothing else does.
 *
 * The board list, the rules text and the game catalogue are the same for every
 * viewer and only describe what is on offer (the server still refuses a bet on
 * a board switched off since). Showing yesterday's list through a dropped
 * connection beats an empty screen. A balance or an order is never asked this
 * way (services/api/wallet.ts, payments.ts), and these cases hold the line the
 * fallback must not cross: a 4xx is an answer, an untagged read gets no cache,
 * and an answer past the window is not used.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const BOARDS = { success: true, boards: [{ key: 'b1' }] };

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
    key: () => null,
    get length() { return m.size; },
  } as Storage;
}

/** Answers from the queue in order; `'down'` is a transport failure. */
function scripted(queue: Array<{ status: number; body: unknown } | 'down'>) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string) => {
    calls.push(String(url));
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    if (next === 'down') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(next.body), {
      status: next.status, headers: { 'Content-Type': 'application/json' },
    });
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

async function load(fetchImpl: typeof fetch, storage: Storage) {
  vi.resetModules();
  vi.stubGlobal('fetch', fetchImpl);
  vi.stubGlobal('localStorage', storage);
  await (await import('./originFailover')).bootstrapApiEndpoint();
  return (await import('./apiClient')).apiClient;
}

describe('apiClient last-good fallback', () => {
  let storage: Storage;
  beforeEach(() => { vi.unstubAllGlobals(); storage = memoryStorage(); });

  it('answers a transport failure with the last good answer', async () => {
    const api = await load(scripted([{ status: 200, body: BOARDS }, 'down']).impl, storage);
    expect(await api.get('/api/v1/boards', { staleOnError: true })).toEqual(BOARDS);
    // Every retry fails too; the kept answer is what the screen gets.
    expect(await api.get('/api/v1/boards', { staleOnError: true })).toEqual(BOARDS);
  });

  it('answers a 5xx with the last good answer', async () => {
    const api = await load(scripted([
      { status: 200, body: BOARDS }, { status: 503, body: { message: 'down for maintenance' } },
    ]).impl, storage);
    await api.get('/api/v1/boards', { staleOnError: true });
    expect(await api.get('/api/v1/boards', { staleOnError: true })).toEqual(BOARDS);
  });

  it('passes a 4xx through: the server answered, and its answer stands', async () => {
    const api = await load(scripted([
      { status: 200, body: BOARDS }, { status: 404, body: { message: 'gone' } },
    ]).impl, storage);
    await api.get('/api/v1/boards', { staleOnError: true });
    await expect(api.get('/api/v1/boards', { staleOnError: true })).rejects.toMatchObject({ status: 404 });
  });

  it('keeps nothing for a read that did not ask, and serves it nothing', async () => {
    const api = await load(scripted([{ status: 200, body: { success: true, deposit: 100 } }, 'down']).impl, storage);
    await api.get('/api/user/bet-limits');
    expect(storage.getItem('bb_api_fallback:/api/user/bet-limits')).toBeNull();
    await expect(api.get('/api/user/bet-limits')).rejects.toThrow();
  });

  it('does not use an answer older than the window', async () => {
    storage.setItem('bb_api_fallback:/api/v1/boards',
      JSON.stringify({ ts: Date.now() - 25 * 60 * 60 * 1000, data: BOARDS }));
    const api = await load(scripted(['down']).impl, storage);
    await expect(api.get('/api/v1/boards', { staleOnError: true })).rejects.toThrow();
  });

  it('throws as before when there is nothing kept', async () => {
    const api = await load(scripted(['down']).impl, storage);
    await expect(api.get('/api/v1/boards', { staleOnError: true })).rejects.toThrow('Failed to fetch');
  });
});
