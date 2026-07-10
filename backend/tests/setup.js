// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { vi } from 'vitest';

// Test-only env — must exist BEFORE any test file imports app modules:
// backend/routes.js throws at import time if JWT_SECRET is missing.
process.env.NODE_ENV ||= 'test';
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

let replset;

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
});
