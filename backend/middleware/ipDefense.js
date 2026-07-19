// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * middleware/ipDefense.js — Defense against IP-rotation rate-limit evasion
 * (item 12). 2026-07-13.
 *
 * THE PROBLEM (owner's words): attackers bypass per-IP rate limits "by using
 * multiple IP". A brute-forcer with a proxy pool cycles source IPs so each one
 * stays under the per-IP limit while the ATTACK in aggregate sails past it.
 *
 * TWO layers on top of the existing per-IP limiters (middleware/security.js),
 * both admin-editable (SystemConfig.ipDefense), both origin/traffic-shape only
 * — no geo/ISP lookups, no third-party reputation (that stays out of scope):
 *
 *   1. SUBNET AGGREGATION (default ON, the primary defense). Proxy pools and
 *      botnets very often rotate WITHIN a block (a /24 of IPv4, a /64 of IPv6 —
 *      one hosting range, one CGNAT pool). A second limiter keyed by the subnet
 *      PREFIX means cycling the last octet no longer resets the counter. The
 *      subnet cap is a GENEROUS multiple of the per-IP cap (default ×8) so
 *      legitimate users sharing a carrier NAT are safe, while a single IP
 *      hammering 50 addresses in one /24 is still caught.
 *
 *   2. GLOBAL SURGE BREAKER (default OFF, opt-in). For a DISTRIBUTED rotation
 *      (IPs spread across many subnets), the only signal is the aggregate: total
 *      hits to ONE sensitive endpoint across ALL clients in a window. When the
 *      owner knows their baseline they can set a hard ceiling; past it the
 *      endpoint sheds 429 until the window passes. Off by default because a
 *      too-low ceiling would block a legitimate traffic spike (marketing push).
 *
 * Both share the cross-instance Redis counter store (redisRateLimitStore.js) so
 * the aggregation actually holds across a horizontally-scaled fleet, and both
 * degrade to per-instance counting without Redis (same contract as everything
 * else). Client IP is used ONLY to compute a rate-limit key here — this file is
 * a rate limiter, never a router; nothing downstream branches on who the client
 * is (the DNS/geo constraint is about ROUTING, not counting).
 */
import { rateLimit } from 'express-rate-limit';
import { createRateLimitStore } from './redisRateLimitStore.js';
import { RATE_LIMIT_TIERS } from '../config/security.config.js';

// ── Subnet key ────────────────────────────────────────────────────────────────
/**
 * subnetKey — collapse an IP to its block prefix. IPv4 → first 3 octets (/24);
 * IPv6 → first `hextets` groups (default 4 = /64). Handles IPv4-mapped IPv6
 * (::ffff:a.b.c.d) and falls back to the raw value for anything unparseable.
 */
export function subnetKey(ip, { ipv6Hextets = 4 } = {}) {
  if (!ip) return 'unknown';
  let s = String(ip);
  const mapped = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i); // IPv4-mapped IPv6
  if (mapped) s = mapped[1];
  if (s.includes('.') && !s.includes(':')) {               // IPv4
    const o = s.split('.');
    return o.length === 4 ? `${o[0]}.${o[1]}.${o[2]}.0/24` : s;
  }
  if (s.includes(':')) {                                   // IPv6
    const groups = s.split(':').filter(Boolean).slice(0, ipv6Hextets);
    return `${groups.join(':')}::/${ipv6Hextets * 16}`;
  }
  return s;
}

// ── Admin-editable config (cached, env/default fallback) ─────────────────────
const DEFAULTS = {
  enabled: true,
  subnetMultiplier: Number(process.env.IP_DEFENSE_SUBNET_MULT || 8),
  ipv6Hextets: 4, // /64
};
let cfg = { ...DEFAULTS };
if (String(process.env.IP_DEFENSE_ENABLED).toLowerCase() === 'false') cfg.enabled = false;
let refreshTimer = null;

async function refreshConfig() {
  try {
    const mongoose = (await import('mongoose')).default;
    const SystemConfig = mongoose.model('SystemConfig');
    const doc = await SystemConfig.findOne({ key: 'main' }).select('ipDefense').lean();
    const s = doc?.ipDefense;
    if (s) {
      cfg = {
        enabled: s.enabled !== undefined ? !!s.enabled : DEFAULTS.enabled,
        subnetMultiplier: Number.isFinite(s.subnetMultiplier) && s.subnetMultiplier > 0 ? s.subnetMultiplier : DEFAULTS.subnetMultiplier,
        ipv6Hextets: DEFAULTS.ipv6Hextets,
        surge: s.surge || {},
      };
    }
  } catch { /* DB not ready — keep env/defaults */ }
}
export function startIpDefenseConfigRefresh(everyMs = 30_000) {
  if (refreshTimer) return;
  refreshConfig();
  refreshTimer = setInterval(refreshConfig, everyMs);
  if (refreshTimer.unref) refreshTimer.unref();
}
export function _ipDefenseConfig() { return { ...cfg }; }
export function _setIpDefenseConfig(p) { cfg = { ...cfg, ...p }; } // tests only

// ── Layer 1: per-subnet limiter ──────────────────────────────────────────────
/**
 * createSubnetLimiter — a subnet-keyed backstop for a sensitive tier. Chain it
 * AFTER the existing per-IP limiter on the same route (per-IP catches the
 * single abuser fast; this catches the rotation within a block). Its `max` is
 * evaluated per-request from the cached admin config, so the multiplier tunes
 * live. When ipDefense.enabled is false it lets everything through (the per-IP
 * limiter still runs) by returning a very high max.
 *
 * @param {'auth'|'adminAuth'|'withdrawal'|'bet'} tierName  a RATE_LIMIT_TIERS key
 */
export function createSubnetLimiter(tierName) {
  const tier = RATE_LIMIT_TIERS[tierName];
  return rateLimit({
    store: createRateLimitStore(`rl:subnet:${tierName}:`),
    windowMs: tier.windowMs,
    max: () => (cfg.enabled ? Math.max(1, Math.round(tier.max * cfg.subnetMultiplier)) : 1e9),
    standardHeaders: true,
    legacyHeaders: false,
    // AQ-6: subnetKey() intentionally collapses the IP to its block prefix
    // (/24 IPv4, /64 IPv6) — that IS the IPv6 normalization, so disable
    // express-rate-limit v8's ipKeyGenerator check (it can't see through the
    // custom key function and would warn spuriously).
    validate: { keyGeneratorIpFallback: false },
    keyGenerator: (req) => subnetKey(req.ip, { ipv6Hextets: cfg.ipv6Hextets }),
    message: { success: false, message: 'Too many attempts from your network. Please try again later.' },
    handler: (req, res) => {
      // Distinct log so the ops team can tell subnet-level evasion apart from a
      // single noisy IP.
      console.warn('🛡️  IP-ROTATION DEFENSE: subnet rate limit hit', {
        subnet: subnetKey(req.ip, { ipv6Hextets: cfg.ipv6Hextets }), tier: tierName, path: req.path,
      });
      res.status(429).json({ success: false, message: 'Too many attempts from your network. Please try again later.' });
    },
  });
}

// ── Layer 2: global surge breaker ────────────────────────────────────────────
const surgeStores = new Map(); // name -> store (one counter per endpoint)
/**
 * globalSurgeBreaker — aggregate ceiling for one endpoint across ALL clients.
 * Reads its threshold from SystemConfig.ipDefense.surge[name] = { windowSec, max }.
 * A max of 0 (or missing) = OFF (default). This is the distributed-rotation
 * backstop: it doesn't care which IPs are calling, only that the TOTAL rate to a
 * sensitive endpoint has left normal territory.
 *
 * @param {string} name  key under ipDefense.surge (e.g. 'auth','withdrawal','funding')
 */
export function globalSurgeBreaker(name) {
  if (!surgeStores.has(name)) surgeStores.set(name, createRateLimitStore(`rl:surge:${name}:`));
  const store = surgeStores.get(name);
  return async (req, res, next) => {
    try {
      const s = cfg.surge?.[name];
      const max = Number(s?.max) || 0;
      if (!cfg.enabled || max <= 0) return next(); // breaker off
      const windowMs = (Number(s?.windowSec) || 60) * 1000;
      store.init({ windowMs });
      const { totalHits } = await store.increment('global'); // ONE shared counter for this endpoint
      if (totalHits > max) {
        console.warn('🛡️  IP-ROTATION DEFENSE: global surge breaker tripped', { endpoint: name, totalHits, max });
        res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
        return res.status(429).json({ success: false, message: 'This service is temporarily busy. Please try again shortly.' });
      }
    } catch { /* counter unavailable — fail open (per-IP + subnet still guard) */ }
    return next();
  };
}
