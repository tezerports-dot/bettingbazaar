// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * gateway/serviceTopology.js — the monolith→microservices seam (CAP-72).
 * Pure/config-driven, no I/O — unit-tested in backend/tests/unit/serviceTopology.test.js.
 *
 * The platform is a MODULAR MONOLITH today: every bounded domain runs in-process.
 * The owner's roadmap is HYBRID (monolith + selected microservices) for 1M DAU.
 * This module is the single place that answers "for domain X, do I call the
 * in-process module, or proxy to a remote service?" — so extracting a service
 * later is a config change (set one env var), not a code rewrite.
 *
 * Resolution (per domain):
 *   local   — in-process (default for every domain; zero-config monolith)
 *   remote  — a separate service, when SERVICE_<DOMAIN>_URL is set
 *
 * This complements services/serviceRegistry.js (in-process cross-cutting
 * services like storage/metrics). Topology is about WHERE a *domain* lives;
 * the service registry is about WHICH implementation of a cross-cutting service
 * is live. Neither replaces direct imports inside the monolith.
 *
 * Nothing here changes runtime behavior until a SERVICE_*_URL is set — the whole
 * platform stays a monolith by default (Bucket B: architecture-ready, dormant).
 */

// The bounded domains that are candidates for extraction, in rough
// split-priority order (highest-value / most-independent first). Naming a domain
// here does NOT extract it — it just makes it addressable by the topology.
export const KNOWN_SERVICES = Object.freeze([
  'support',   // RAG assistant — stateless, external-API-bound: the easiest first split
  'markets',   // game engine / cycles — CPU + real-time
  'payment',   // deposit/withdrawal orchestration
  'merchant',  // merchant ops + assignment
  'wallet',    // money authority (split LAST; strongest consistency needs)
  'identity',  // auth / tokens
  'notification',
]);

const envKey = (name) => `SERVICE_${String(name).toUpperCase()}_URL`;

/**
 * Resolve where a domain's calls should go.
 * @param {string} name domain name (need not be in KNOWN_SERVICES)
 * @param {object} [env=process.env]
 * @returns {{ name, location: 'local'|'remote', baseUrl: string|null }}
 */
export function resolve(name, env = process.env) {
  const url = env[envKey(name)];
  if (url && String(url).trim()) {
    return { name, location: 'remote', baseUrl: String(url).trim().replace(/\/+$/, '') };
  }
  return { name, location: 'local', baseUrl: null };
}

export function isRemote(name, env = process.env) { return resolve(name, env).location === 'remote'; }

/** True once ANY known domain has been pointed at a remote URL (we've gone hybrid). */
export function isHybrid(env = process.env) {
  return KNOWN_SERVICES.some((n) => isRemote(n, env));
}

/** Full topology snapshot for /status dashboards and startup logging. */
export function topologySnapshot(env = process.env) {
  const services = KNOWN_SERVICES.map((n) => resolve(n, env));
  return {
    mode: isHybrid(env) ? 'hybrid' : 'monolith',
    remoteCount: services.filter((s) => s.location === 'remote').length,
    services,
  };
}
