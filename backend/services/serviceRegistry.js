// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * services/serviceRegistry.js — Service Registry (plan item 4). 2026-07-13.
 *
 * A minimal named-service registry, deliberately small per the plan ("start
 * small; this doesn't need to be elaborate for a monolith"): internal services
 * register at startup under a stable name; consumers that must not hard-couple
 * to a file path look them up by name. This complements — does not replace —
 * direct imports: single-authority modules (walletAuthority, riskValidation)
 * KEEP being imported directly per governance §1; the registry is for
 * swappable/cross-cutting services (storage, alerting, metrics, queue) where
 * the consumer shouldn't care which implementation is live.
 *
 * Registration happens in server.js (registerCoreServices) right after module
 * load — before any consumer can run a lookup.
 */

const services = new Map();

export function registerService(name, service) {
  if (!name || typeof name !== 'string') throw new Error('Service name required');
  if (services.has(name)) throw new Error(`Service '${name}' already registered`);
  services.set(name, service);
  console.info(`[serviceRegistry] registered: ${name}`);
  return service;
}


