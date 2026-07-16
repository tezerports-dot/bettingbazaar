// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * config/network.config.js — Network Configuration (plan item 28) +
 * the domain list for Multi-Domain Architecture (plan item 29). 2026-07-13.
 *
 * Ports, public URLs, and the active-domain list centralized as DATA — read
 * from env exactly as before (portability: env stays the injection mechanism,
 * this module is the single parse/shape point instead of scattered reads).
 *
 * MULTI-DOMAIN (item 29, scope as locked in the plan): every hostname in
 * DOMAINS serves the SAME app, same routes, same behavior — plain redundancy/
 * branding, no per-domain logic anywhere. CANONICAL_HOST (optional) is the
 * one-time canonical-URL decision: when set, an origin-side 301 normalizes
 * every other configured domain to it (SEO); when unset, all domains are
 * equal peers. NOTE (hard constraint from the plan): nothing in this module —
 * or anything consuming it — may take client IP/geo/ISP as an input. Domains
 * are a static admin-provided list; the canonical redirect keys ONLY on the
 * requested Host header, which is part of the URL the client asked for, not
 * who the client is.
 */

function parseList(v) {
  return String(v || '').split(',').map(s => s.trim()).filter(Boolean);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseTrustProxy(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || raw === 'false' || raw === '0' || raw === 'none' || raw === 'direct') return false;
  if (raw === 'true') return true;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0) return n;
  return value;
}

export const network = {
  // Port the app listens on (platform-injected on PaaS).
  port: Number(process.env.PORT || 8080),

  // Public base URL of the primary deployment (links in emails, share URLs).
  appBaseUrl: process.env.APP_BASE_URL || '',

  // Item 29: every domain this deployment serves (bare hostnames). Empty =
  // single-domain deploy, nothing changes. TLS per domain is the host
  // platform's job (Railway custom domains / Caddy automatic HTTPS) — verify
  // certs actually issue for EACH domain after DNS points here.
  domains: parseList(process.env.DOMAINS),

  // Item 29 canonical decision: '' = all domains equal; a hostname = 301
  // every other configured domain to it. Applies consistently everywhere.
  canonicalHost: (process.env.CANONICAL_HOST || '').trim().toLowerCase(),

  // CORS allowlist (unchanged semantics — server.js consumes).
  allowedOrigins: parseList(process.env.ALLOWED_ORIGINS),

  // Fail closed for portability: direct/self-hosted deployments do not trust
  // X-Forwarded-* unless TRUST_PROXY is explicitly configured (e.g. 1 behind Caddy).
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),

  // Outbound requests use the standard Node connection pool only. This is the
  // central configuration point for service-to-service HTTP, not a proxy or
  // fingerprint-routing mechanism.
  outboundRequestTimeoutMs: positiveInteger(process.env.OUTBOUND_HTTP_TIMEOUT_MS, 10_000),
  outboundUserAgent: (process.env.OUTBOUND_HTTP_USER_AGENT || 'BettingBazaar/1.0').trim(),
};

/**
 * canonicalRedirect — origin-side host normalization (item 29). Mounted only
 * when CANONICAL_HOST is set. 301s GET/HEAD requests arriving on any OTHER
 * configured domain to the canonical one (never redirects API calls or
 * non-configured hosts — a health checker hitting the raw platform hostname
 * must keep working). Inputs: requested Host + path ONLY.
 */
export function canonicalRedirect(req, res, next) {
  const canon = network.canonicalHost;
  if (!canon) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api') || req.path === '/health' || req.path === '/metrics') return next();
  const host = String(req.headers.host || '').toLowerCase().split(':')[0];
  if (host && host !== canon && network.domains.includes(host)) {
    return res.redirect(301, `https://${canon}${req.originalUrl}`);
  }
  next();
}
