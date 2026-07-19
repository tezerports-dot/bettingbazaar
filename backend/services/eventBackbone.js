// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * services/eventBackbone.js — external event-backbone seam (CAP-74).
 * Unit-tested in backend/tests/unit/eventBackbone.test.js.
 *
 * The domain eventBus (services/eventBus.service.js) is an in-process
 * EventEmitter — ideal for a monolith, but events never leave the process. As
 * the platform goes hybrid, some events must reach OTHER services with durable,
 * replayable delivery — i.e. a message log (Kafka / NATS / Redis Streams). This
 * module is the seam between the in-process bus and that transport: publish()
 * on the bus forwards every event here, and here we fan out to any DRIVER.
 *
 * Default: ZERO drivers → forward() is a pure no-op → the monolith behaves
 * exactly as before. That is precisely why wiring it into the hot publish path
 * is safe: unless KAFKA_BROKERS is set, this adds a single array-length check.
 *
 * IS KAFKA NEEDED TODAY? No — see docs/governance/HYBRID_ARCHITECTURE.md §Kafka. In-process
 * events + Redis pub/sub (realtime fan-out) + BullMQ (durable jobs) already
 * cover the monolith. Kafka earns its operational cost only once independent
 * services need a shared, replayable event log across the network. This seam is
 * what makes adopting it later a config flip instead of a refactor.
 */

const drivers = [];
let configured = false;

export function registerDriver(driver) {
  if (!driver || typeof driver.publish !== 'function') {
    throw new Error('backbone driver needs a publish(event, envelope) method');
  }
  drivers.push(driver);
  return driver;
}

export function listDrivers() { return drivers.map((d) => d.name || 'driver'); }
export function hasDrivers() { return drivers.length > 0; }

/**
 * Forward a domain event envelope to every driver. NEVER throws and NEVER
 * blocks the caller — a backbone outage must not break in-process publishing
 * (the in-process bus is the source of truth).
 * @param {{event:string, payload:any, ts:number}} envelope
 */
export function forward(envelope) {
  if (!drivers.length) return; // no-op fast path (monolith default)
  for (const d of drivers) {
    try {
      const r = d.publish(envelope.event, envelope);
      if (r && typeof r.catch === 'function') {
        r.catch((e) => console.error(`[backbone:${d.name || 'driver'}] publish failed:`, e.message));
      }
    } catch (e) {
      console.error(`[backbone:${d.name || 'driver'}] publish threw:`, e.message);
    }
  }
}

/**
 * Attach drivers from the environment. Called once at boot (server.js). Safe to
 * call when nothing is configured — it leaves the backbone empty (no-op mode).
 */
export async function configureFromEnv(env = process.env) {
  if (configured) return listDrivers();
  configured = true;
  if (env.KAFKA_BROKERS && env.KAFKA_BROKERS.trim()) {
    const { createKafkaDriver } = await import('./backbone/kafkaDriver.js');
    registerDriver(await createKafkaDriver(env));
    console.log(`✅ Event backbone: Kafka driver attached (${env.KAFKA_BROKERS})`);
  }
  return listDrivers();
}

/** Test/shutdown helper — closes and clears all drivers. */
export async function resetBackbone() {
  for (const d of drivers) { try { await d.close?.(); } catch { /* closing */ } }
  drivers.length = 0;
  configured = false;
}
