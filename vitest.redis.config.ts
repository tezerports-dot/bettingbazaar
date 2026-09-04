// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Redis tests: the horizontal-scale properties that only a real Redis can
// prove — rate-limit counters shared across instances, and SSE fan-out
// crossing from one instance to another.
//
// These need NO database. They were previously carried by the integration
// tier, which booted an in-memory document store in its setup file and so
// could not run without it; the properties under test never had anything to
// do with that store. Splitting them out keeps the coverage and drops the
// dependency.
//
// Each suite skips itself (not fails) when REDIS_URL is unset.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['backend/tests/redis/**/*.test.js'],
    testTimeout: 30000,
    fileParallelism: false, // shared Redis
  },
});
