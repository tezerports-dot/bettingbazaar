// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * Endpoint discovery, validation and failover (owner, 2026-10-09).
 *
 * What these pin: the client never adopts an origin outside the build-time
 * allowlist whatever discovery answers; discovery is bounded (timeout, retry)
 * and its failure falls back to the configured origins, then to a reported
 * outage; nothing is ready before validation; failover only ever moves between
 * trusted origins.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const PRIMARY = 'https://api.example.com';
const BACKUP = 'https://api-backup.example.net';
const EXTRA = 'https://edge.example.org';
const DISCOVERY = 'https://discover.example.com/endpoint.json';

async function load(env: Record<string, string>) {
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', env.NODE_ENV ?? 'production');
  for (const k of ['VITE_API_URL', 'VITE_API_BACKUP_URL', 'VITE_API_DISCOVERY_URL', 'VITE_API_ALLOWED_HOSTS']) {
    vi.stubEnv(k, env[k] ?? '');
  }
  vi.resetModules();
  return import('./originFailover');
}

type Route = (url: string, init?: RequestInit) => Promise<Response> | Response;

/** fetch stub: discovery answers `discovery`; only `alive` origins pass /health/live. */
function network({ discovery, alive = [] }: { discovery?: Route; alive?: string[] }) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    if (String(url) === DISCOVERY) {
      if (!discovery) throw new TypeError('Failed to fetch');
      return discovery(String(url), init);
    }
    const origin = String(url).replace('/health/live', '');
    if (alive.includes(origin)) return new Response('{}', { status: 200 });
    throw new TypeError('Failed to fetch');
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('validateApiOrigin — the whole trust decision', () => {
  const policy = { allowedHosts: ['api.example.com', 'edge.example.org'], production: true };

  it.each([
    ['https://api.example.com', 'https://api.example.com'],
    ['https://API.Example.com/', 'https://api.example.com'],
    ['https://api.example.com.', 'https://api.example.com'],
  ])('accepts %s', async (raw, want) => {
    const m = await load({});
    expect(m.validateApiOrigin(raw, policy)).toBe(want);
  });

  it.each([
    ['http instead of https', 'http://api.example.com'],
    ['unauthorized hostname', 'https://evil.example.com'],
    ['look-alike suffix', 'https://api.example.com.evil.net'],
    ['subdomain of an allowed host', 'https://x.api.example.com'],
    ['IPv4 literal', 'https://203.0.113.7'],
    ['IPv6 literal', 'https://[2001:db8::1]'],
    ['credentials', 'https://user:pass@api.example.com'],
    ['a path', 'https://api.example.com/api'],
    ['a query', 'https://api.example.com/?next=evil'],
    ['a fragment', 'https://api.example.com/#x'],
    ['a port', 'https://api.example.com:8443'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,hi'],
    ['file:', 'file:///etc/passwd'],
    ['not a URL', 'api.example.com'],
    ['localhost in production', 'https://localhost'],
  ])('rejects %s', async (_why, raw) => {
    const m = await load({});
    expect(m.validateApiOrigin(raw, policy)).toBeNull();
  });

  it.each([null, undefined, 42, {}, [], ''])('rejects a non-string %p', async (raw) => {
    const m = await load({});
    expect(m.validateApiOrigin(raw, policy)).toBeNull();
  });

  it('allows http://localhost only in a development build', async () => {
    const m = await load({ NODE_ENV: 'development' });
    expect(m.validateApiOrigin('http://localhost:8080', { allowedHosts: ['localhost'], production: false }))
      .toBe('http://localhost:8080');
    expect(m.validateApiOrigin('http://localhost:8080', { allowedHosts: ['localhost'], production: true })).toBeNull();
  });

  it('the allowlist ignores wildcard, URL and IP entries instead of interpreting them', async () => {
    const m = await load({ VITE_API_URL: PRIMARY, VITE_API_ALLOWED_HOSTS: '*.example.org, https://x.example.org, 198.51.100.4, edge.example.org' });
    expect(m.originPolicy().allowedHosts).toEqual(['api.example.com', 'edge.example.org']);
  });
});

describe('bootstrapApiEndpoint — startup discovery', () => {
  it('valid endpoint: adopts the discovered origin, and only then is ready', async () => {
    const m = await load({ VITE_API_URL: PRIMARY, VITE_API_DISCOVERY_URL: DISCOVERY, VITE_API_ALLOWED_HOSTS: 'edge.example.org' });
    network({ discovery: json({ url: EXTRA }), alive: [EXTRA, PRIMARY] });
    let ready = false;
    void m.whenEndpointReady().then(() => { ready = true; });
    expect(m.currentOrigin()).toBe('');      // nothing usable before validation
    expect(await m.bootstrapApiEndpoint()).toBe(EXTRA);
    await Promise.resolve();
    expect(ready).toBe(true);
    expect(m.currentOrigin()).toBe(EXTRA);
  });

  it('discovery request carries no credentials and refuses redirects', async () => {
    const m = await load({ VITE_API_URL: PRIMARY, VITE_API_DISCOVERY_URL: DISCOVERY });
    const { fn } = network({ discovery: json({ url: PRIMARY }), alive: [PRIMARY] });
    await m.bootstrapApiEndpoint();
    const init = fn.mock.calls.find(([u]) => u === DISCOVERY)![1] as RequestInit;
    expect(init.credentials).toBe('omit');
    expect(init.redirect).toBe('error');
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i);
  });

  it('unauthorized hostname in the answer: never adopted, falls back to the configured primary', async () => {
    const m = await load({ VITE_API_URL: PRIMARY, VITE_API_DISCOVERY_URL: DISCOVERY });
    const { calls } = network({ discovery: json({ url: 'https://evil.example.com' }), alive: [PRIMARY, 'https://evil.example.com'] });
    expect(await m.bootstrapApiEndpoint()).toBe(PRIMARY);
    expect(calls.some((u) => u.includes('evil.example.com'))).toBe(false);   // not even probed
    expect(calls.filter((u) => u === DISCOVERY)).toHaveLength(1);              // a rejected answer is not retried
  });

  it.each([
    ['invalid JSON', () => new Response('{nope', { status: 200 })],
    ['invalid URL', json({ url: 'not a url' })],
    ['HTTP instead of HTTPS', json({ url: 'http://api.example.com' })],
    ['IP address', json({ url: 'https://203.0.113.9' })],
    ['wrong shape', json(['https://api.example.com'])],
    ['server error', json({ error: 'x' }, 503)],
    ['oversized body', () => new Response(JSON.stringify({ url: PRIMARY, pad: 'x'.repeat(5000) }), { status: 200 })],
  ])('%s: discovery fails closed and the configured primary is used', async (_why, answer) => {
    const m = await load({ VITE_API_URL: PRIMARY, VITE_API_DISCOVERY_URL: DISCOVERY });
    network({ discovery: answer as Route, alive: [PRIMARY] });
    expect(await m.bootstrapApiEndpoint()).toBe(PRIMARY);
    expect(m.endpointStats.discoveryFailed).toBeGreaterThan(0);
  });

  it('timeout: each attempt is aborted, attempts are bounded, then the backup is used', async () => {
    vi.useFakeTimers();
    const m = await load({ VITE_API_URL: PRIMARY, VITE_API_BACKUP_URL: BACKUP, VITE_API_DISCOVERY_URL: DISCOVERY });
    const hang: Route = (_u, init) => new Promise((_r, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const { calls } = network({ discovery: hang, alive: [BACKUP] });
    const done = m.bootstrapApiEndpoint();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await done).toBe(BACKUP);
    expect(calls.filter((u) => u === DISCOVERY)).toHaveLength(3);
    expect(m.endpointStats.lastEvent).toMatchObject({ kind: 'adopted', origin: BACKUP, source: 'configured' });
  });

  it('discovery server unavailable and nothing configured answers: failed, not ready, retryable', async () => {
    vi.useFakeTimers();
    const m = await load({ VITE_API_URL: PRIMARY, VITE_API_DISCOVERY_URL: DISCOVERY });
    network({ alive: [] });
    const done = m.bootstrapApiEndpoint();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await done).toBeNull();
    expect(m.endpointState()).toBe('failed');
    expect(m.currentOrigin()).toBe('');

    // The retry button: the network is back.
    network({ discovery: json({ url: PRIMARY }), alive: [PRIMARY] });
    expect(await m.bootstrapApiEndpoint()).toBe(PRIMARY);
  });

  it('discovered origin does not answer: the configured origins are tried in order', async () => {
    const m = await load({ VITE_API_URL: PRIMARY, VITE_API_BACKUP_URL: BACKUP, VITE_API_DISCOVERY_URL: DISCOVERY, VITE_API_ALLOWED_HOSTS: 'edge.example.org' });
    network({ discovery: json({ url: EXTRA }), alive: [BACKUP] });
    expect(await m.bootstrapApiEndpoint()).toBe(BACKUP);
  });

  it('reports what happened to the server, by kind only — never a host', async () => {
    const m = await load({ VITE_API_URL: PRIMARY, VITE_API_DISCOVERY_URL: DISCOVERY });
    const { fn } = network({ discovery: json({ url: 'https://evil.example.com' }), alive: [PRIMARY] });
    await m.bootstrapApiEndpoint();
    const post = fn.mock.calls.find(([u]) => String(u).endsWith('/api/v1/client/endpoint-events'));
    expect(post?.[0]).toBe(`${PRIMARY}/api/v1/client/endpoint-events`);   // to the adopted, validated origin
    const body = JSON.parse(String((post![1] as RequestInit).body));
    expect(body.events).toEqual([
      { kind: 'discovery_failed', source: 'discovery', reason: 'rejected_url' },
      { kind: 'adopted', source: 'configured', reason: 'none' },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/example/);
    expect((post![1] as RequestInit).credentials).toBe('omit');
  });

  it('same-origin web deploy: nothing to discover, ready immediately with relative paths', async () => {
    const m = await load({});
    const { fn } = network({});
    expect(await m.bootstrapApiEndpoint()).toBe('');
    expect(fn).not.toHaveBeenCalled();
    expect(m.endpointState()).toBe('ready');
  });

  it('an http:// primary is refused in a production build', async () => {
    const m = await load({ VITE_API_URL: 'http://api.example.com' });
    expect(m.configuredOrigins()).toEqual([]);
  });
});

describe('reportOriginUnreachable — runtime failover', () => {
  it('primary unavailable, backup available: moves to the backup and tells listeners', async () => {
    const m = await load({ VITE_API_URL: PRIMARY, VITE_API_BACKUP_URL: BACKUP });
    network({ alive: [PRIMARY, BACKUP] });
    await m.bootstrapApiEndpoint();
    const seen: string[] = [];
    m.onOriginChange((o) => seen.push(o));
    network({ alive: [BACKUP] });
    expect(await m.reportOriginUnreachable(PRIMARY)).toBe(BACKUP);
    expect(m.currentOrigin()).toBe(BACKUP);
    expect(seen).toEqual([BACKUP]);
    expect(m.endpointStats.failovers).toBe(1);
  });

  it('backup unavailable too: reports null and stays put (no arbitrary host)', async () => {
    const m = await load({ VITE_API_URL: PRIMARY, VITE_API_BACKUP_URL: BACKUP });
    network({ alive: [PRIMARY] });
    await m.bootstrapApiEndpoint();
    const { calls } = network({ alive: [] });
    expect(await m.reportOriginUnreachable(PRIMARY)).toBeNull();
    expect(m.currentOrigin()).toBe(PRIMARY);
    expect(new Set(calls.map((u) => new URL(u).origin))).toEqual(new Set([PRIMARY, BACKUP]));
  });

  it('a TLS failure is just "unreachable" — the next trusted origin, never a relaxed retry', async () => {
    const m = await load({ VITE_API_URL: PRIMARY, VITE_API_BACKUP_URL: BACKUP });
    network({ alive: [PRIMARY] });
    await m.bootstrapApiEndpoint();
    // Browsers surface a certificate failure as the same TypeError as a refused connection.
    network({ alive: [BACKUP] });
    expect(await m.reportOriginUnreachable(PRIMARY)).toBe(BACKUP);
  });

  it('single origin: nowhere to go', async () => {
    const m = await load({ VITE_API_URL: PRIMARY });
    network({ alive: [PRIMARY] });
    await m.bootstrapApiEndpoint();
    expect(m.failoverAvailable()).toBe(false);
    expect(await m.reportOriginUnreachable(PRIMARY)).toBeNull();
  });

  it('concurrent failures share one search, and a burst inside the cooldown does not re-probe', async () => {
    const m = await load({ VITE_API_URL: PRIMARY, VITE_API_BACKUP_URL: BACKUP });
    network({ alive: [PRIMARY] });
    await m.bootstrapApiEndpoint();
    const { fn } = network({ alive: [PRIMARY] });
    const all = await Promise.all([m.reportOriginUnreachable(PRIMARY), m.reportOriginUnreachable(PRIMARY)]);
    expect(all).toEqual([PRIMARY, PRIMARY]);
    const probes = fn.mock.calls.length;
    await m.reportOriginUnreachable(PRIMARY);
    expect(fn.mock.calls.length).toBe(probes);
  });

  it('before the endpoint is validated, failover does nothing', async () => {
    const m = await load({ VITE_API_URL: PRIMARY, VITE_API_BACKUP_URL: BACKUP });
    const { fn } = network({ alive: [BACKUP] });
    expect(await m.reportOriginUnreachable(PRIMARY)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
});
