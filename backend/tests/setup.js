// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { vi } from 'vitest';

let replset;

// Mocking Redis globally for tests
vi.mock('../services/cache.service.js', () => ({
  initCache: vi.fn().mockResolvedValue(true),
  CacheService: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(true),
    del: vi.fn().mockResolvedValue(true),
    invalidatePattern: vi.fn().mockResolvedValue(true),
  }
}));

beforeAll(async () => {
  // Use MongoMemoryReplSet explicitly for better transaction support
  replset = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' }
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
