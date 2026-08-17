// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { vi } from 'vitest';
// Same process-global Mongoose options the app applies (updatePipeline etc.), so
// integration tests exercise the pipeline-update paths under the real setting
// regardless of how each test file imports its models.
import '../startup/mongooseGlobalOptions.js';

// Test-only env — must exist BEFORE any test file imports app modules:
// backend/routes.js throws at import time if JWT_SECRET is missing.
process.env.NODE_ENV ||= 'test';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
process.env.AADHAAR_HMAC_SECRET ||= 'test-only-aadhaar-hmac-secret';

let replset;
// Captured in beforeAll when DATABASE_URL is set, so beforeEach can keep the PG
// money tables cleared in lockstep with the Mongo collections (below).
//
// The table list is READ FROM THE SCHEMA, never typed. It used to be a literal
// array of eight names, and it silently stopped covering the schema the moment
// a table was added: merchant_wallets, merchant_wallet_entries,
// merchant_settlements and merchant_settlement_transitions were all missing
// from it. `test:pg` runs first against the SAME database and leaves fixtures
// behind, so a table nobody truncates keeps them — and runReconcile then
// reported those wallets as orphans and failed a drift assertion on stale
// fixtures rather than on any real disagreement. Reproduced exactly:
// orphansInPg = 2. Deriving the list means adding a table can never again
// poison an unrelated suite.
let pgTruncate = null;

// Mocking Redis globally for tests
vi.mock('../../services/cache.service.js', () => ({
  initCache: vi.fn().mockResolvedValue(true),
  CacheService: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(true),
    del: vi.fn().mockResolvedValue(true),
    invalidatePattern: vi.fn().mockResolvedValue(true),
  }
}));

beforeAll(async () => {
  // An EXTERNAL MongoDB wins when one is offered. `npm run stack:up` starts a
  // real single-node replica set in Docker, and pointing at it is what lets
  // these suites run somewhere other than GitHub Actions — the download host
  // for the in-memory server's binary is firewalled in some environments, and
  // "only CI can run this" is not an acceptable property for the tests that
  // guard money.
  //
  // It MUST be a replica set either way: 31 call sites open a Mongo
  // transaction, and MongoDB refuses those on a standalone server. A plain
  // mongod here would pass a smoke test and fail every money path, which is
  // also why docker-compose.test.yml initiates rs0 rather than just starting
  // a container.
  const external = process.env.MONGODB_URI;
  if (external) {
    await mongoose.connect(external);
  } else {
    // Version pinned for reproducibility; MONGOMS_SYSTEM_BINARY (env) lets a
    // preinstalled mongod be used where the download host is firewalled.
    replset = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
      binary: { version: process.env.MONGOMS_VERSION || '7.0.14' },
    });
    await mongoose.connect(replset.getUri());
  }
  // Wait for every model's index builds. The UNIQUE indexes (WalletLedger
  // txId, AccountingEvent idempotencyKey, ...) are the durable idempotency
  // gates the concurrency tests exercise — without this await, a test can
  // race an index that doesn't exist yet and "prove" a double-spend that
  // production (where indexes long exist) can't produce.
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

  // Hybrid money DB: when a real Postgres is wired (CI sets DATABASE_URL), the
  // money models' post-save hooks fire-and-forget mirror into PG. Apply the
  // schema ONCE globally so those mirrors have tables to write to in EVERY
  // integration file — not just postgresDualWrite's. Without this, unrelated
  // money-path tests flood logs with "relation ... does not exist" (harmless,
  // fire-safe — but noisy and misleading).
  if (process.env.DATABASE_URL) {
    const { applySchema, pgQuery } = await import('../postgres/pgClient.js');
    await applySchema();
    const { rows } = await pgQuery(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
    const tables = rows.map((r) => r.tablename);
    pgTruncate = tables.length
      // One statement, so foreign keys between the tables cannot order-fail.
      ? () => pgQuery(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`).catch(() => {})
      : null;
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  if (replset) await replset.stop();
});

beforeEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany();
  }
  // Keep Postgres money tables cleared in lockstep with Mongo so no
  // integration file inherits stray mirrored rows from a prior test.
  if (pgTruncate) await pgTruncate();
});
