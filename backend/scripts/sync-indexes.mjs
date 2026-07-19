// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * scripts/sync-indexes.mjs — explicit index synchronization (AQ-14).
 *
 * Run this ONCE per deploy when MONGO_AUTO_INDEX=false, so index builds happen
 * in a controlled step instead of on every instance's boot (boot-time index
 * builds can stall a horizontally-scaled fleet and race the first requests).
 *
 * It loads every model and calls syncIndexes(), which creates missing indexes
 * and drops indexes no longer declared in the schema. Because the unique
 * indexes here are the money-path idempotency gates (WalletLedger.txId,
 * AccountingEvent.idempotencyKey, …), this MUST complete successfully before a
 * fresh database serves traffic.
 *
 * Usage:  MONGODB_URI=... node backend/scripts/sync-indexes.mjs
 */
import mongoose from 'mongoose';

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('FATAL: MONGODB_URI is not set — cannot sync indexes.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(uri, { dbName: 'bettingbazaar' });
  // Register every schema/model.
  await import('../models/index.js');

  const results = [];
  for (const [name, model] of Object.entries(mongoose.models)) {
    try {
      await model.syncIndexes();
      results.push(`  ✓ ${name}`);
    } catch (err) {
      results.push(`  ✗ ${name}: ${err.message}`);
    }
  }
  console.log(`Index sync complete for ${Object.keys(mongoose.models).length} models:`);
  console.log(results.join('\n'));

  const failed = results.filter((r) => r.includes('✗'));
  await mongoose.disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('Index sync failed:', err);
  process.exit(1);
});
