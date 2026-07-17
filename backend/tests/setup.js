// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { vi } from 'vitest';

// Test-only env — must exist BEFORE any test file imports app modules:
// backend/routes.js throws at import time if JWT_SECRET is missing.
process.env.NODE_ENV ||= 'test';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';
process.env.AADHAAR_HMAC_SECRET ||= 'test-only-aadhaar-hmac-secret';

let replset;
// Captured in beforeAll when DATABASE_URL is set, so beforeEach can keep the PG
// money tables cleared in lockstep with the Mongo collections (below).
let pgTruncate = null;
const PG_MONEY_TABLES = ['wallet_ledger', 'wallets', 'accounting_events', 'transactions',
                         'payment_orders', 'utr_registry', 'merchant_wallet_ledger', 'user_kyc'];

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
  // Replica set so Mongo multi-document transactions work in tests.
  // Version pinned for reproducibility; MONGOMS_SYSTEM_BINARY (env) lets a
  // preinstalled mongod be used where the download host is firewalled.
  replset = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    binary: { version: process.env.MONGOMS_VERSION || '7.0.14' },
  });
  const uri = replset.getUri();
  await mongoose.connect(uri);
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
    pgTruncate = async () => {
      for (const t of PG_MONEY_TABLES) {
        await pgQuery(`TRUNCATE ${t} RESTART IDENTITY CASCADE`).catch(() => {});
      }
    };
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
