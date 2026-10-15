// @vitest-environment-options {"url": "https://play.example.com/"}
// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The web build (the site, and the installed web app on Android and iPhone)
 * when its own address is blocked (docs/governance/DOMAIN_FAILOVER.md).
 *
 * The page runs at https://play.example.com with no VITE_API_URL: a
 * same-origin deploy. With a gateway key built in, its own origin is its
 * primary, so it learns the signed standby pool while the site is up and
 * moves to a standby when the site stops answering. Without a key it stays the
 * plain same-origin deploy it always was.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { generateKeyPairSync, sign, createPublicKey } from 'node:crypto';

const SELF = 'https://play.example.com';
const MIRROR = 'https://cdn.example.net/gateway.json';
const STANDBY = 'https://standby.example.net';
const { privateKey } = generateKeyPairSync('ed25519');
const KEY = createPublicKey(privateKey).export({ format: 'jwk' }).x as string;

function doc(hosts: string[], version = 2) {
  const bytes = Buffer.from(JSON.stringify({
    format: 'bb-gateway-config/1', version, issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), hosts,
  }));
  return JSON.stringify({ payload: bytes.toString('base64url'), signature: sign(null, bytes, privateKey).toString('base64url') });
}

async function load(env: Record<string, string>, { keepStorage = false } = {}) {
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'production');
  for (const k of ['VITE_API_URL', 'VITE_API_BACKUP_URL', 'VITE_API_DISCOVERY_URL', 'VITE_API_ALLOWED_HOSTS',
    'VITE_GATEWAY_CONFIG_PUBLIC_KEY', 'VITE_GATEWAY_CONFIG_URLS']) {
    vi.stubEnv(k, env[k] ?? '');
  }
  if (!keepStorage) localStorage.clear();
  vi.resetModules();
  return import('./originFailover');
}

/** `alive` origins answer /health/live; `hang` ones never answer until aborted; `routes` answer as given. */
function network({ alive = [], hang = [], routes = {} }: { alive?: string[]; hang?: string[]; routes?: Record<string, string> }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    if (routes[String(url)]) return new Response(routes[String(url)], { status: 200 });
    const origin = String(url).replace('/health/live', '');
    if (alive.includes(origin)) return new Response('{}', { status: 200 });
    if (hang.includes(origin)) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    throw new TypeError('Failed to fetch');
  }));
  return { calls };
}

afterEach(async () => {
  await (await import('./originFailover')).gatewayRefreshSettled();
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
});

describe('a web build whose own address may be blocked', () => {
  it('with no gateway key: the plain same-origin deploy, relative paths, nothing fetched', async () => {
    const m = await load({});
    const { calls } = network({ alive: [SELF] });
    expect(await m.bootstrapApiEndpoint()).toBe('');
    expect(calls).toEqual([]);
  });

  it('with a key: its own origin is the primary, and once up it learns the standby pool', async () => {
    const m = await load({ VITE_GATEWAY_CONFIG_PUBLIC_KEY: KEY, VITE_GATEWAY_CONFIG_URLS: MIRROR });
    const { calls } = network({ alive: [SELF], routes: { [MIRROR]: doc(['standby.example.net']) } });
    expect(await m.bootstrapApiEndpoint()).toBe(SELF);
    await m.gatewayRefreshSettled();
    expect(calls).toEqual(expect.arrayContaining([MIRROR, `${SELF}/api/v1/client/gateway-config`]));
    expect(m.candidateOrder()).toEqual([SELF, STANDBY]);
  });

  it('the site is blocked on the next launch: it opens from cache and moves to the signed standby', async () => {
    const first = await load({ VITE_GATEWAY_CONFIG_PUBLIC_KEY: KEY, VITE_GATEWAY_CONFIG_URLS: MIRROR });
    network({ alive: [SELF], routes: { [MIRROR]: doc(['standby.example.net']) } });
    await first.bootstrapApiEndpoint();
    await first.gatewayRefreshSettled();

    // Next launch: same storage, the site's address no longer answers, the mirror is blocked too.
    const m = await load({ VITE_GATEWAY_CONFIG_PUBLIC_KEY: KEY, VITE_GATEWAY_CONFIG_URLS: MIRROR }, { keepStorage: true });
    network({ alive: [STANDBY] });
    expect(await m.bootstrapApiEndpoint()).toBe(STANDBY);
    expect(m.currentOrigin()).toBe(STANDBY);
  });

  it('a first launch that finds the site blocked fetches the pool from a mirror and moves', async () => {
    const m = await load({ VITE_GATEWAY_CONFIG_PUBLIC_KEY: KEY, VITE_GATEWAY_CONFIG_URLS: MIRROR });
    network({ alive: [STANDBY], routes: { [MIRROR]: doc(['standby.example.net']) } });
    expect(await m.bootstrapApiEndpoint()).toBe(STANDBY);
  });

  it('while running, a blocked site fails over to the standby', async () => {
    const m = await load({ VITE_GATEWAY_CONFIG_PUBLIC_KEY: KEY, VITE_GATEWAY_CONFIG_URLS: MIRROR });
    network({ alive: [SELF], routes: { [MIRROR]: doc(['standby.example.net']) } });
    await m.bootstrapApiEndpoint();
    await m.gatewayRefreshSettled();
    network({ alive: [STANDBY] });
    expect(await m.reportOriginUnreachable(SELF)).toBe(STANDBY);
  });

  it('a pool of hosts that all hang costs one probe timeout, and order still decides', async () => {
    const pool = Array.from({ length: 6 }, (_, i) => `sb${i}.example.net`);
    const first = await load({ VITE_GATEWAY_CONFIG_PUBLIC_KEY: KEY, VITE_GATEWAY_CONFIG_URLS: MIRROR });
    network({ alive: [SELF], routes: { [MIRROR]: doc(pool) } });
    await first.bootstrapApiEndpoint();
    await first.gatewayRefreshSettled();

    const m = await load({ VITE_GATEWAY_CONFIG_PUBLIC_KEY: KEY }, { keepStorage: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Everything hangs except the last two standbys; the earlier of them must win.
    const { calls } = network({ hang: [SELF, ...pool.slice(0, 4).map((h) => `https://${h}`)], alive: [`https://${pool[4]}`, `https://${pool[5]}`] });
    let adopted: string | null | undefined;
    void m.bootstrapApiEndpoint().then((o) => { adopted = o; });
    const tick = () => new Promise((r) => setImmediate(r));
    // Every probe is out before any has answered: they run at once. Waited
    // for by the clock (vi.waitFor keeps real timers), not a fixed count of
    // ticks, which a slow CI runner ran out of before the signed document
    // was verified.
    await vi.waitFor(() => expect(calls.filter((u) => u.endsWith('/health/live'))).toHaveLength(7), { timeout: 5000, interval: 5 });
    await vi.advanceTimersByTimeAsync(4100);   // one PROBE_TIMEOUT_MS, not five of them
    for (let i = 0; i < 20 && adopted === undefined; i += 1) await tick();
    expect(adopted).toBe(`https://${pool[4]}`);
  });
});
