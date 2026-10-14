// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * deploy/gateway-mirror/worker.js — a Cloudflare Worker that serves the signed
 * gateway document from Workers KV at `/gateway.json`, one of the mirrors the
 * player app reads (docs/governance/DOMAIN_FAILOVER.md).
 *
 * It serves the bytes `scripts/gateway-publish.mjs` put in KV and nothing else.
 * It cannot sign: the app verifies every document against its build-time key,
 * so this Worker (or whoever controls the Cloudflare account) can withhold the
 * document, never change a host. Any origin may read it (the player site and
 * an installed web app read it cross-origin); it carries nothing secret.
 *
 * Deploy once: `npx wrangler deploy` in this directory, after putting your KV
 * namespace id in wrangler.toml.
 */
const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'public, max-age=60',
  'access-control-allow-origin': '*',
  'x-content-type-options': 'nosniff',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...HEADERS, 'access-control-allow-methods': 'GET, HEAD', 'access-control-allow-headers': 'Accept' } });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('', { status: 405, headers: HEADERS });
    if (new URL(request.url).pathname !== '/gateway.json') return new Response('', { status: 404, headers: HEADERS });
    const text = await env.GATEWAY.get(env.GATEWAY_KEY || 'gateway.json');
    if (!text) return new Response('', { status: 404, headers: HEADERS });
    return new Response(request.method === 'HEAD' ? null : text, { headers: HEADERS });
  },
};
