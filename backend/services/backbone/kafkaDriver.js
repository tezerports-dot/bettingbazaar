// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * services/backbone/kafkaDriver.js — Kafka driver for the event backbone (CAP-74).
 *
 * A real kafkajs producer, LAZY-imported so kafkajs loads only when KAFKA_BROKERS
 * is set (the same dormant-dependency pattern the platform uses for pg/bullmq:
 * the package is installed, activation is env-gated). Instantiated by
 * eventBackbone.configureFromEnv(); never imported on the monolith's default path.
 *
 * Topic mapping: a domain event like 'payment.order.paid' publishes to topic
 * '<prefix><domain>' where domain = text before the first dot ('payment'), so a
 * domain's events share one partitioned, ordered topic. Partition key =
 * payload.userId || payload.orderId when present, so a single entity's events
 * stay ordered within a partition.
 *
 * Producer is idempotent (exactly-once-ish producer semantics) to avoid dupes on
 * retry. Delivery is fire-and-forget from the caller's perspective — the backbone
 * swallows errors so a Kafka blip can't break in-process publishing.
 *
 * Env: KAFKA_BROKERS (csv), KAFKA_CLIENT_ID, KAFKA_SSL=true,
 *      KAFKA_SASL_MECHANISM/USERNAME/PASSWORD, KAFKA_TOPIC_PREFIX (default 'bb.').
 */
export async function createKafkaDriver(env = process.env) {
  const { Kafka, logLevel } = await import('kafkajs');
  const brokers = String(env.KAFKA_BROKERS).split(',').map((s) => s.trim()).filter(Boolean);
  if (!brokers.length) throw new Error('KAFKA_BROKERS is empty');

  const kafka = new Kafka({
    clientId: env.KAFKA_CLIENT_ID || 'bettingbazaar',
    brokers,
    ssl: env.KAFKA_SSL === 'true' || undefined,
    sasl: env.KAFKA_SASL_USERNAME
      ? {
          mechanism: env.KAFKA_SASL_MECHANISM || 'plain',
          username: env.KAFKA_SASL_USERNAME,
          password: env.KAFKA_SASL_PASSWORD || '',
        }
      : undefined,
    logLevel: logLevel.ERROR,
  });

  const producer = kafka.producer({ allowAutoTopicCreation: true, idempotent: true });
  await producer.connect();
  const prefix = env.KAFKA_TOPIC_PREFIX || 'bb.';

  return {
    name: 'kafka',
    async publish(event, envelope) {
      const domain = String(event).split('.')[0] || 'events';
      const key = envelope?.payload?.userId || envelope?.payload?.orderId || null;
      await producer.send({
        topic: `${prefix}${domain}`,
        messages: [{ key: key != null ? String(key) : undefined, value: JSON.stringify(envelope) }],
      });
    },
    async close() { try { await producer.disconnect(); } catch { /* closing */ } },
  };
}
