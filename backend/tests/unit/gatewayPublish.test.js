// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * scripts/gateway-publish.mjs — one signed document onto every mirror, and the
 * weekly check of what the mirrors serve (docs/governance/DOMAIN_FAILOVER.md).
 *
 * The network is a fake that behaves like each service's real API (GitHub
 * contents, Cloudflare KV, a kubo node, the public read URLs), so these prove
 * what is sent where and what is refused before anything is sent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GATEWAY_FORMAT, rawPublicKey, signGatewayPayload } from '../../domains/configuration/gatewayConfig.js';
import { configuredTargets, judge, main } from '../../../scripts/gateway-publish.mjs';

const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const { privateKey } = generateKeyPairSync('ed25519');
const PUBLIC = rawPublicKey(privateKey);

const signed = (version, { days = 90, hosts = ['live.example.com', 'standby.example.net'] } = {}) => JSON.stringify(signGatewayPayload({
  format: GATEWAY_FORMAT, version, issuedAt: new Date(NOW).toISOString(),
  expiresAt: new Date(NOW + days * 86_400_000).toISOString(), hosts,
}, privateKey));

const ENV = {
  GATEWAY_MIRROR_GITHUB_REPO: 'bb/gateway', GATEWAY_MIRROR_GITHUB_TOKEN: 'gh-token',
  GATEWAY_MIRROR_CF_ACCOUNT_ID: 'acct', GATEWAY_MIRROR_CF_NAMESPACE_ID: 'ns', GATEWAY_MIRROR_CF_TOKEN: 'cf-token',
  GATEWAY_MIRROR_CF_URL: 'https://bb-gateway.example.workers.dev/gateway.json',
  GATEWAY_MIRROR_IPFS_API: 'http://127.0.0.1:5001',
};
const IPNS = 'k51qzi5uqu5dlexample';

/** A fake internet: the three upload APIs write into `served`, every public URL reads from it. */
function fakeNet(initial = '') {
  const served = { github: initial, cloudflare: initial, ipfs: initial };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
    const text = (t) => (t ? new Response(t, { status: 200 }) : new Response('nope', { status: 404 }));
    if (url.startsWith('https://api.github.com/')) {
      if ((init.method || 'GET') === 'GET') return served.github ? json({ sha: 'abc' }) : json({}, 404);
      served.github = Buffer.from(JSON.parse(init.body).content, 'base64').toString().trim();
      return json({ content: {} }, 201);
    }
    if (url.startsWith('https://purge.jsdelivr.net/')) return json({ status: 'ok' });
    if (url.startsWith('https://api.cloudflare.com/')) { served.cloudflare = init.body; return json({ success: true }); }
    if (url.startsWith('http://127.0.0.1:5001/api/v0/key/list')) return json({ Keys: [{ Name: 'bb-gateway', Id: IPNS }] });
    if (url.startsWith('http://127.0.0.1:5001/api/v0/add')) {
      served.pendingIpfs = (await init.body.get('file').text()).trim();
      return json({ Hash: 'bafyexample' });
    }
    if (url.startsWith('http://127.0.0.1:5001/api/v0/name/publish')) { served.ipfs = served.pendingIpfs; return json({ Name: IPNS }); }
    if (url.includes('raw.githubusercontent.com') || url.includes('cdn.jsdelivr.net')) return text(served.github);
    if (url.includes('workers.dev')) return text(served.cloudflare);
    if (url.includes(IPNS)) return text(served.ipfs);
    return new Response('', { status: 404 });
  };
  return { served, calls, fetchImpl };
}

const run = async (argv, net, env = ENV) => {
  const lines = []; const errors = [];
  const code = await main(argv, { out: (l) => lines.push(l), err: (l) => errors.push(l), env, fetchImpl: net.fetchImpl, now: NOW });
  return { code, out: lines.join('\n'), err: errors.join('\n') };
};

describe('scripts/gateway-publish.mjs', () => {
  let dir;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'bb-gateway-publish-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
  const docFile = (name, text) => { const f = join(dir, name); writeFileSync(f, `${text}\n`); return f; };

  it('names the stable URL of every configured mirror, for VITE_GATEWAY_CONFIG_URLS', async () => {
    const res = await run(['urls'], fakeNet());
    expect(res.code).toBe(0);
    expect(res.out.split(',')).toEqual([
      'https://raw.githubusercontent.com/bb/gateway/main/gateway.json',
      'https://cdn.jsdelivr.net/gh/bb/gateway@main/gateway.json',
      'https://bb-gateway.example.workers.dev/gateway.json',
      `https://ipfs.io/ipns/${IPNS}`, `https://${IPNS}.ipns.dweb.link/`,
    ]);
    expect(res.err).toMatch(/dir not configured/);
  });

  it('publishes one document to every target, each with only its own token, and reads each back', async () => {
    const net = fakeNet();
    const text = signed(4);
    const res = await run(['publish', '--public-key', PUBLIC, '--document', docFile('v4.json', text)], net);
    expect(res.code).toBe(0);
    expect(net.served).toMatchObject({ github: text, cloudflare: text, ipfs: text });
    expect(res.out.match(/serving now/g)).toHaveLength(5);
    // GitHub's token goes only to GitHub, Cloudflare's only to Cloudflare; no read sends any.
    for (const c of net.calls) {
      const auth = c.headers.Authorization || '';
      if (c.url.startsWith('https://api.github.com/')) expect(auth).toBe('Bearer gh-token');
      else if (c.url.startsWith('https://api.cloudflare.com/')) expect(auth).toBe('Bearer cf-token');
      else expect(auth).toBe('');
    }
    // The IPNS record is long-lived, so the name resolves while the node is briefly away.
    expect(net.calls.find((c) => c.url.includes('name/publish')).url).toMatch(/lifetime=8760h/);
  });

  it('writes into each local directory', async () => {
    const out = join(dir, 'static-site');
    const text = signed(1);
    const res = await run(['publish', '--public-key', PUBLIC, '--document', docFile('d.json', text), '--targets', 'dir'], fakeNet(), { GATEWAY_MIRROR_DIRS: out });
    expect(res.code).toBe(0);
    expect(readFileSync(join(out, 'gateway.json'), 'utf8').trim()).toBe(text);
  });

  it('refuses before sending anything: a document that does not verify, or one older than a mirror serves', async () => {
    const other = rawPublicKey(generateKeyPairSync('ed25519').privateKey);
    const net = fakeNet(signed(9));
    const wrongKey = await run(['publish', '--public-key', other, '--document', docFile('a.json', signed(10))], net);
    expect(wrongKey).toMatchObject({ code: 1, err: expect.stringMatching(/GATEWAY_BAD_SIGNATURE/) });

    const older = await run(['publish', '--public-key', PUBLIC, '--document', docFile('b.json', signed(8))], net);
    expect(older).toMatchObject({ code: 1, err: expect.stringMatching(/already serves version 9/) });

    const twin = await run(['publish', '--public-key', PUBLIC, '--document', docFile('c.json', signed(9, { hosts: ['other.example.com'] }))], net);
    expect(twin).toMatchObject({ code: 1, err: expect.stringMatching(/different document under version 9/) });
    expect(net.calls.filter((c) => c.method === 'PUT' || c.url.includes('/api/v0/add'))).toHaveLength(0);

    // The same document again is fine: re-running after a partial failure finishes the job.
    const same = await run(['publish', '--public-key', PUBLIC, '--document', docFile('d.json', signed(9))], fakeNet(signed(9)));
    expect(same.code).toBe(0);
  });

  it('--dry-run checks everything and uploads nothing', async () => {
    const net = fakeNet();
    const res = await run(['publish', '--public-key', PUBLIC, '--document', docFile('e.json', signed(2)), '--dry-run'], net);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/would publish to github, cloudflare, ipfs/);
    expect(net.calls.filter((c) => c.method === 'PUT' || c.url.includes('/api/v0/'))).toHaveLength(0);
  });

  it('refuses a target that is not configured, and names what it lacks', async () => {
    expect(configuredTargets({ GATEWAY_MIRROR_GITHUB_REPO: 'bb/gateway' }).missing.github).toEqual(['GATEWAY_MIRROR_GITHUB_TOKEN']);
    const res = await run(['publish', '--public-key', PUBLIC, '--document', docFile('f.json', signed(1)), '--targets', 'cloudflare'], fakeNet(), {});
    expect(res).toMatchObject({ code: 1, err: expect.stringMatching(/cloudflare is not configured/) });
  });

  it('check: passes on agreeing, valid mirrors; fails on a dead, stale or soon-expiring one', async () => {
    const urls = 'https://raw.githubusercontent.com/bb/gateway/main/gateway.json,https://bb-gateway.example.workers.dev/gateway.json';
    const net = fakeNet(signed(5));
    expect((await run(['check', '--public-key', PUBLIC, '--urls', urls], net)).code).toBe(0);

    net.served.cloudflare = signed(4);
    expect(await run(['check', '--public-key', PUBLIC, '--urls', urls], net)).toMatchObject({ code: 1, err: expect.stringMatching(/disagree: versions 4, 5/) });

    net.served.cloudflare = '';
    expect(await run(['check', '--public-key', PUBLIC, '--urls', urls], net)).toMatchObject({ code: 1, err: expect.stringMatching(/workers\.dev.*no valid document \(HTTP 404\)/) });

    const soon = fakeNet(signed(6, { days: 10 }));
    expect(await run(['check', '--public-key', PUBLIC, '--urls', urls], soon)).toMatchObject({ code: 1, err: expect.stringMatching(/expires in 10 days/) });
    expect((await run(['check', '--public-key', PUBLIC, '--urls', urls, '--warn-days', '5'], soon)).code).toBe(0);
  });

  it('judge reads a mirror the way an app does: a forged or oversized answer is not valid', () => {
    const { problems } = judge([{ url: 'https://m.example/x', error: 'GATEWAY_BAD_SIGNATURE' }], { now: NOW });
    expect(problems[0]).toMatch(/no valid document/);
  });
});
