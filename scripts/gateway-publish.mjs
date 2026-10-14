#!/usr/bin/env node
// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * gateway-publish.mjs — puts ONE signed gateway document on every mirror, and
 * checks what the mirrors serve (docs/governance/DOMAIN_FAILOVER.md).
 *
 * It never signs and never sees the private key: the document is signed
 * offline first (`scripts/gateway-config.mjs sign`). Every app verifies it
 * against its build-time key, so a mirror (or whoever holds a mirror's upload
 * token) can withhold the document or serve an older one, and nothing more:
 * an older version is below the floor each install keeps. That is why the
 * upload tokens below may live on the machine that runs this, and the signing
 * key may not.
 *
 *   node scripts/gateway-publish.mjs publish --public-key <base64url> --document <file> [--targets a,b] [--dry-run]
 *       Verifies the document, refuses one older than what any mirror already
 *       serves, uploads it to every configured target (or only --targets), then
 *       reads every public URL back and says what each serves now.
 *
 *   node scripts/gateway-publish.mjs urls
 *       Prints the public URLs of the configured targets as one comma-separated
 *       line: the value for VITE_GATEWAY_CONFIG_URLS (and the Android build's
 *       ANDROID_GATEWAY_CONFIG_URLS). Bake it into every build.
 *
 *   node scripts/gateway-publish.mjs check --public-key <base64url> [--urls a,b] [--warn-days 21]
 *       Fetches every mirror as an app would and verifies it. Exits 1 when a
 *       mirror serves nothing valid, the mirrors disagree on the version, or the
 *       document expires within --warn-days. Needs no secret: CI runs it weekly
 *       (.github/workflows/gateway-watch.yml).
 *
 * Targets, each configured by environment (keep these in a local file you
 * `source`, never in git; each token can write only its own mirror):
 *
 *   github      GATEWAY_MIRROR_GITHUB_REPO (owner/repo, public), _BRANCH (main),
 *               _PATH (gateway.json), _TOKEN (fine-grained: Contents read and
 *               write on that one repository). Served at raw.githubusercontent.com
 *               and through jsDelivr (cdn.jsdelivr.net/gh/…), two mirrors from one
 *               push; jsDelivr's copy is purged after each push.
 *   cloudflare  GATEWAY_MIRROR_CF_ACCOUNT_ID, _CF_NAMESPACE_ID, _CF_TOKEN (Workers
 *               KV Storage: Edit), _CF_KEY (gateway.json), _CF_URL (the public URL
 *               of the Worker in deploy/gateway-mirror/, e.g.
 *               https://bb-gateway.<you>.workers.dev/gateway.json).
 *   ipfs        GATEWAY_MIRROR_IPFS_API (a kubo node's RPC, http://127.0.0.1:5001),
 *               _IPFS_KEY (the IPNS key name, bb-gateway; made on first use).
 *               Published under one IPNS name, so the URL never changes while
 *               the content does; the node must stay online to keep the name
 *               resolvable (it holds the IPNS key, never the signing key).
 *   dir         GATEWAY_MIRROR_DIRS (comma-separated local directories): writes
 *               gateway.json into each, e.g. a static site's checkout or the copy
 *               you then place at every API server's GATEWAY_CONFIG_FILE. No URL.
 *
 * Arweave is not a target: every upload there gets a new address, so no URL
 * could be baked into a build ahead of time (a stable name needs ArNS, a paid
 * registration). Every target here keeps one URL across versions.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATEWAY_MAX_DOCUMENT_BYTES, verifyGatewayDocument } from '../backend/domains/configuration/gatewayConfig.js';

const DAY_MS = 86_400_000;
const FETCH_TIMEOUT_MS = 10_000;
export const TARGETS = ['github', 'cloudflare', 'ipfs', 'dir'];
export const DEFAULT_WARN_DAYS = 21;

function fail(message) {
  return Object.assign(new Error(message), { cli: true });
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw fail(`unexpected argument ${arg}`);
    if (arg === '--dry-run') { flags['dry-run'] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw fail(`${arg} needs a value`);
    flags[arg.slice(2)] = value;
    i += 1;
  }
  return flags;
}

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

/** What is configured, from the environment. A target missing a required value is absent, with the reason. */
export function configuredTargets(env = process.env) {
  const out = {};
  const missing = {};
  const need = (name, keys) => {
    const lacking = keys.filter((k) => !env[k]);
    if (lacking.length) missing[name] = lacking;
    return lacking.length === 0;
  };
  if (need('github', ['GATEWAY_MIRROR_GITHUB_REPO', 'GATEWAY_MIRROR_GITHUB_TOKEN'])) {
    const repo = env.GATEWAY_MIRROR_GITHUB_REPO;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw fail('GATEWAY_MIRROR_GITHUB_REPO must be owner/repo');
    const branch = env.GATEWAY_MIRROR_GITHUB_BRANCH || 'main';
    const path = (env.GATEWAY_MIRROR_GITHUB_PATH || 'gateway.json').replace(/^\/+/, '');
    out.github = {
      repo, branch, path, token: env.GATEWAY_MIRROR_GITHUB_TOKEN,
      urls: [
        `https://raw.githubusercontent.com/${repo}/${branch}/${path}`,
        `https://cdn.jsdelivr.net/gh/${repo}@${branch}/${path}`,
      ],
    };
  }
  if (need('cloudflare', ['GATEWAY_MIRROR_CF_ACCOUNT_ID', 'GATEWAY_MIRROR_CF_NAMESPACE_ID', 'GATEWAY_MIRROR_CF_TOKEN', 'GATEWAY_MIRROR_CF_URL'])) {
    out.cloudflare = {
      account: env.GATEWAY_MIRROR_CF_ACCOUNT_ID, namespace: env.GATEWAY_MIRROR_CF_NAMESPACE_ID,
      token: env.GATEWAY_MIRROR_CF_TOKEN, key: env.GATEWAY_MIRROR_CF_KEY || 'gateway.json',
      urls: [env.GATEWAY_MIRROR_CF_URL],
    };
  }
  if (need('ipfs', ['GATEWAY_MIRROR_IPFS_API'])) {
    out.ipfs = {
      api: env.GATEWAY_MIRROR_IPFS_API.replace(/\/+$/, ''), keyName: env.GATEWAY_MIRROR_IPFS_KEY || 'bb-gateway',
      // Filled in from the node (the IPNS name is the key's id); see ipfsUrls.
      name: env.GATEWAY_MIRROR_IPFS_NAME || '', urls: [],
    };
    if (out.ipfs.name) out.ipfs.urls = ipfsUrls(out.ipfs.name);
  }
  if (need('dir', ['GATEWAY_MIRROR_DIRS'])) {
    out.dir = { dirs: list(env.GATEWAY_MIRROR_DIRS), urls: [] };
  }
  return { targets: out, missing };
}

/**
 * Public gateways for an IPNS name, both of which answer without a redirect
 * (the app refuses redirects): ipfs.io's path form and dweb.link's subdomain form.
 */
export function ipfsUrls(name) {
  return [`https://ipfs.io/ipns/${name}`, `https://${name}.ipns.dweb.link/`];
}

async function timed(fetchImpl, url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try { return await fetchImpl(url, { ...init, signal: controller.signal }); } finally { clearTimeout(timer); }
}

async function ok(res, what) {
  if (res.ok) return res;
  let detail = '';
  try { detail = (await res.text()).slice(0, 300); } catch { /* nothing to add */ }
  throw fail(`${what}: HTTP ${res.status} ${detail}`.trim());
}

/**
 * Read one mirror as an app reads it: no credentials, redirects refused, the
 * size cap, then verification. Resolves `{ url, payload, text }` or `{ url, error }`.
 */
export async function readMirror(url, publicKey, { fetchImpl = fetch, now = Date.now() } = {}) {
  try {
    const res = await timed(fetchImpl, url, { method: 'GET', redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!res.ok) return { url, error: `HTTP ${res.status}` };
    const text = (await res.text()).trim();
    if (Buffer.byteLength(text, 'utf8') > GATEWAY_MAX_DOCUMENT_BYTES) return { url, error: 'GATEWAY_TOO_LARGE' };
    return { url, text, payload: verifyGatewayDocument(text, publicKey, { now }) };
  } catch (e) {
    return { url, error: e.code || (e.name === 'AbortError' ? 'timeout' : e.message) };
  }
}

/** One line per mirror, then the problems. Pure over the readings. */
export function judge(readings, { now = Date.now(), warnDays = DEFAULT_WARN_DAYS } = {}) {
  const lines = []; const problems = [];
  for (const r of readings) {
    if (r.error) { lines.push(`✗ ${r.url}: ${r.error}`); problems.push(`${r.url} serves no valid document (${r.error})`); continue; }
    const days = Math.floor((Date.parse(r.payload.expiresAt) - now) / DAY_MS);
    lines.push(`✓ ${r.url}: version ${r.payload.version}, ${r.payload.hosts.length} hosts, expires ${r.payload.expiresAt} (${days} days)`);
    if (days < warnDays) problems.push(`${r.url} expires in ${days} days; sign and publish a new version`);
  }
  const versions = [...new Set(readings.filter((r) => r.payload).map((r) => r.payload.version))];
  if (versions.length > 1) problems.push(`mirrors disagree: versions ${versions.sort((a, b) => a - b).join(', ')}; publish the newest to every mirror`);
  return { lines, problems };
}

// ── Uploads, one per target ───────────────────────────────────────────────────
async function toGithub(t, text, { fetchImpl, version }) {
  const api = `https://api.github.com/repos/${t.repo}/contents/${t.path.split('/').map(encodeURIComponent).join('/')}`;
  const headers = { Authorization: `Bearer ${t.token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'bettingbazaar-gateway-publish', 'X-GitHub-Api-Version': '2022-11-28' };
  const existing = await timed(fetchImpl, `${api}?ref=${encodeURIComponent(t.branch)}`, { headers });
  let sha;
  if (existing.status === 200) sha = (await existing.json()).sha;
  else if (existing.status !== 404) await ok(existing, 'github read');
  await ok(await timed(fetchImpl, api, {
    method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `gateway document version ${version}`, content: Buffer.from(`${text}\n`).toString('base64'), branch: t.branch, ...(sha ? { sha } : {}) }),
  }), 'github write');
  // jsDelivr caches a branch for hours; ask it to drop its copy. Best effort.
  try { await timed(fetchImpl, `https://purge.jsdelivr.net/gh/${t.repo}@${t.branch}/${t.path}`); } catch { /* the cache expires on its own */ }
}

async function toCloudflare(t, text, { fetchImpl }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(t.account)}/storage/kv/namespaces/${encodeURIComponent(t.namespace)}/values/${encodeURIComponent(t.key)}`;
  await ok(await timed(fetchImpl, url, { method: 'PUT', headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'text/plain' }, body: text }), 'cloudflare kv write');
}

async function ipfsRpc(fetchImpl, t, path, body) {
  const res = await ok(await timed(fetchImpl, `${t.api}/api/v0/${path}`, { method: 'POST', ...(body ? { body } : {}) }), `ipfs ${path.split('?')[0]}`);
  return res.json();
}

/** The IPNS name of `t.keyName`, made on first use. */
export async function ipfsName(t, fetchImpl = fetch) {
  const keys = await ipfsRpc(fetchImpl, t, 'key/list?l=true');
  const found = (keys.Keys || []).find((k) => k.Name === t.keyName);
  if (found) return found.Id;
  return (await ipfsRpc(fetchImpl, t, `key/gen?arg=${encodeURIComponent(t.keyName)}&type=ed25519`)).Id;
}

async function toIpfs(t, text, { fetchImpl }) {
  const form = new FormData();
  form.append('file', new Blob([`${text}\n`], { type: 'application/json' }), 'gateway.json');
  const added = await ipfsRpc(fetchImpl, t, 'add?pin=true&cid-version=1', form);
  const name = t.name || await ipfsName(t, fetchImpl);
  // A year's lifetime and a one-minute TTL: gateways re-resolve soon, and the
  // record does not lapse if the node is briefly away.
  await ipfsRpc(fetchImpl, t, `name/publish?arg=${encodeURIComponent(`/ipfs/${added.Hash}`)}&key=${encodeURIComponent(t.keyName)}&lifetime=8760h&ttl=1m`);
  t.name = name;
  t.urls = ipfsUrls(name);
}

function toDirs(t, text) {
  for (const dir of t.dirs) {
    mkdirSync(resolve(dir), { recursive: true });
    writeFileSync(join(resolve(dir), 'gateway.json'), `${text}\n`);
  }
}

const UPLOAD = { github: toGithub, cloudflare: toCloudflare, ipfs: toIpfs, dir: toDirs };

/**
 * Publish `text` to `names` of `targets`. Verifies first, refuses a version
 * below (or a different document at) what any configured mirror serves.
 */
export async function publish({ text, publicKey, targets, names, dryRun = false, fetchImpl = fetch, now = Date.now(), out = console.log }) {
  if (Buffer.byteLength(text, 'utf8') > GATEWAY_MAX_DOCUMENT_BYTES) throw fail('the document is over the size cap; the app would refuse it');
  const payload = verifyGatewayDocument(text, publicKey, { now });
  if (names.length === 0) throw fail('no target is configured; see the header of scripts/gateway-publish.mjs');

  if (targets.ipfs && !targets.ipfs.name && !dryRun) {
    targets.ipfs.name = await ipfsName(targets.ipfs, fetchImpl);
    targets.ipfs.urls = ipfsUrls(targets.ipfs.name);
  }
  const urls = names.flatMap((n) => targets[n].urls);
  const before = await Promise.all(urls.map((u) => readMirror(u, publicKey, { fetchImpl, now })));
  for (const r of before) {
    if (!r.payload) continue;
    if (r.payload.version > payload.version) throw fail(`${r.url} already serves version ${r.payload.version}; apps would refuse ${payload.version}. Sign a higher version.`);
    if (r.payload.version === payload.version && r.text !== text) throw fail(`${r.url} serves a different document under version ${payload.version}; apps refuse a second document under one number. Sign a higher version.`);
  }
  out(`document: version ${payload.version}, ${payload.hosts.length} hosts, expires ${payload.expiresAt}`);
  if (dryRun) { out(`dry run: would publish to ${names.join(', ')}`); return { payload, published: [] }; }

  const published = [];
  for (const n of names) {
    try {
      await UPLOAD[n](targets[n], text, { fetchImpl, version: payload.version });
      published.push(n);
      out(`published to ${n}`);
    } catch (e) {
      out(`NOT published to ${n}: ${e.message}`);
    }
  }
  const after = await Promise.all(names.filter((n) => published.includes(n)).flatMap((n) => targets[n].urls).map((u) => readMirror(u, publicKey, { fetchImpl, now })));
  for (const r of after) {
    out(r.payload?.version === payload.version ? `  serving now: ${r.url}` : `  not yet (cache or propagation): ${r.url} (${r.error || `version ${r.payload.version}`})`);
  }
  if (published.length !== names.length) throw fail(`published to ${published.length} of ${names.length} targets; fix the others and run again (the same document is accepted again)`);
  return { payload, published };
}

/** Run one command. Returns the exit code. */
export async function main(argv, { out = console.log, err = console.error, env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const [command, ...rest] = argv;
  try {
    const flags = parseArgs(rest);
    if (command === 'urls') {
      const { targets, missing } = configuredTargets(env);
      if (targets.ipfs && !targets.ipfs.name) {
        targets.ipfs.name = await ipfsName(targets.ipfs, fetchImpl);
        targets.ipfs.urls = ipfsUrls(targets.ipfs.name);
      }
      for (const [name, keys] of Object.entries(missing)) err(`(${name} not configured: ${keys.join(', ')})`);
      out(Object.values(targets).flatMap((t) => t.urls).join(','));
      return 0;
    }
    if (command === 'publish') {
      if (!flags['public-key'] || !flags.document) throw fail('publish needs --public-key <base64url> and --document <file>');
      const { targets } = configuredTargets(env);
      const names = flags.targets ? list(flags.targets) : TARGETS.filter((n) => targets[n]);
      for (const n of names) if (!targets[n]) throw fail(`target ${n} is not configured (see the header of scripts/gateway-publish.mjs)`);
      await publish({
        text: readFileSync(resolve(flags.document), 'utf8').trim(), publicKey: flags['public-key'],
        targets, names, dryRun: Boolean(flags['dry-run']), fetchImpl, now, out,
      });
      return 0;
    }
    if (command === 'check') {
      if (!flags['public-key']) throw fail('check needs --public-key <base64url>');
      const urls = flags.urls ? list(flags.urls) : list(env.VITE_GATEWAY_CONFIG_URLS);
      if (urls.length === 0) throw fail('check needs --urls, or VITE_GATEWAY_CONFIG_URLS set');
      const warnDays = flags['warn-days'] === undefined ? DEFAULT_WARN_DAYS : Number(flags['warn-days']);
      if (!Number.isSafeInteger(warnDays) || warnDays < 0) throw fail('--warn-days must be a whole number');
      const readings = await Promise.all(urls.map((u) => readMirror(u, flags['public-key'], { fetchImpl, now })));
      const { lines, problems } = judge(readings, { now, warnDays });
      lines.forEach((l) => out(l));
      problems.forEach((p) => err(`problem: ${p}`));
      return problems.length ? 1 : 0;
    }
    throw fail('usage: gateway-publish.mjs publish | urls | check (see the header of scripts/gateway-publish.mjs)');
  } catch (e) {
    err(`gateway-publish: ${e.code ? `${e.code}: ` : ''}${e.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

