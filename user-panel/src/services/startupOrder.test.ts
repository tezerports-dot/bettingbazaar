// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * Startup order (owner, 2026-10-09): no API, SSE or Socket.IO connection
 * leaves before the API endpoint is discovered and validated, and the first
 * ones then go to the validated origin. Also: a POST is never replayed after a
 * transport failure (it may already have been applied).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const ORIGIN = 'https://api.example.com';
const DISCOVERY = 'https://discover.example.com/e.json';

const ioCalls: string[] = [];
const sseCalls: string[] = [];

vi.mock('socket.io-client', () => ({
  io: (url: string) => {
    ioCalls.push(url);
    const handlers: Record<string, unknown> = {};
    return { on: (e: string, h: unknown) => { handlers[e] = h; }, once: () => {}, off: () => {}, emit: () => {},
      connect: () => {}, disconnect: () => {}, connected: false, io: { uri: url } };
  },
}));

class FakeEventSource {
  constructor(url: string) { sseCalls.push(url); }
  addEventListener() {}
  close() {}
  onopen: unknown; onerror: unknown;
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); ioCalls.length = 0; sseCalls.length = 0; });

async function boot() {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('VITE_API_URL', ORIGIN);
  vi.stubEnv('VITE_API_DISCOVERY_URL', DISCOVERY);
  vi.stubGlobal('EventSource', FakeEventSource);
  const store: Record<string, string> = { auth_token: 'a.eyJpZCI6InUxIn0.c' };
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
  let releaseDiscovery: () => void = () => {};
  const gate = new Promise<void>((r) => { releaseDiscovery = r; });
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(String(url));
    if (url === DISCOVERY) { await gate; return new Response(JSON.stringify({ url: ORIGIN }), { status: 200 }); }
    if (String(url).endsWith('/health/live')) return new Response('{}', { status: 200 });
    if (String(url).includes('/api/v1/client/')) return new Response(null, { status: 204 });
    if (String(url).endsWith('/api/v1/boards')) return new Response('{"boards":[]}', { status: 200 });
    throw new TypeError('Failed to fetch');
  }));
  vi.resetModules();
  const failover = await import('./originFailover');
  return { failover, calls, releaseDiscovery };
}

describe('startup order', () => {
  it('RealBackend opens nothing until the endpoint is validated, then uses that origin', async () => {
    const { failover, calls, releaseDiscovery } = await boot();
    const { RealBackend } = await import('./realBackend');
    const backend = new RealBackend();
    const pending = (backend as any).request('/v1/boards');      // an API call made during the LoadingScreen
    const booting = failover.bootstrapApiEndpoint();
    await new Promise((r) => setTimeout(r, 20));
    expect(sseCalls).toEqual([]);
    expect(ioCalls).toEqual([]);
    expect(calls.filter((u) => u.includes('/api/'))).toEqual([]);  // the API call is still waiting

    releaseDiscovery();
    await booting;
    await pending;
    await new Promise((r) => setTimeout(r, 0));
    expect(sseCalls).toEqual([`${ORIGIN}/api/sse/events`]);
    expect(ioCalls).toEqual([ORIGIN]);
    expect(calls).toContain(`${ORIGIN}/api/v1/boards`);
  });

  it('apiClient waits for the endpoint and never replays a POST after a transport failure', async () => {
    const { failover, calls, releaseDiscovery } = await boot();
    const { apiClient } = await import('./apiClient');
    const post = apiClient.post('/api/payment/order', { size: 500 });
    releaseDiscovery();
    await failover.bootstrapApiEndpoint();
    await expect(post).rejects.toThrow();
    expect(calls.filter((u) => u === `${ORIGIN}/api/payment/order`)).toHaveLength(1);
  });
});
