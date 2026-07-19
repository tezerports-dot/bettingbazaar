// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * registry.js — PaymentProvider and CasinoProvider registry.
 *
 * Register providers at startup in server.js or a dedicated bootstrap file:
 *
 *   import { providerRegistry } from './providers/registry.js';
 *   import { MerchantUPIProvider } from './providers/payment/merchant/MerchantUPIProvider.js';
 *   providerRegistry.payment.register(new MerchantUPIProvider());
 *
 * Access anywhere without coupling to a specific implementation:
 *
 *   const provider = providerRegistry.payment.get('merchant_upi');
 *   const result   = await provider.createDepositSession(order);
 */

function makeRegistry(label) {
  const _map = new Map();
  return {
    register(provider) {
      if (!provider.id) throw new Error(`${label} provider missing .id`);
      _map.set(provider.id, provider);
      console.info(`[registry] ${label} provider registered: ${provider.id} v${provider.version}`);
    },
    get(id) {
      const p = _map.get(id);
      if (!p) throw new Error(`${label} provider '${id}' not registered. Available: [${[..._map.keys()].join(', ')}]`);
      return p;
    },
    getAvailable() {
      return [..._map.values()].filter(p => p.isAvailable?.() !== false);
    },
    all()  { return [..._map.values()]; },
    ids()  { return [..._map.keys()]; },
    has(id){ return _map.has(id); },
  };
}

export const providerRegistry = {
  payment:    makeRegistry('Payment'),
  casino:     makeRegistry('Casino'),
  sportsbook: makeRegistry('Sportsbook'),
  // Storage Abstraction (plan item 51, 2026-07-13) — object storage behind the
  // same interface pattern; implementations in providers/storage/, registered
  // at boot by server.js's registerCoreServices (S3 when configured, local
  // disk fallback otherwise).
  storage:    makeRegistry('Storage'),
};
