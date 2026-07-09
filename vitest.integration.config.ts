// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Integration tests: boot an in-memory MongoDB (mongodb-memory-server) and
// exercise real money flows end to end. Run with `npm run test:integration`.
//
// REQUIRES network access to fastdl.mongodb.org (or MONGOMS_SYSTEM_BINARY
// pointing at a local mongod). This is available in GitHub Actions CI and on
// a normal dev machine, but NOT in the restricted build sandbox — so these
// are the tests CI runs on every push, and the CI run IS the proof.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['backend/tests/integration/**/*.test.js'],
    setupFiles: ['./backend/tests/setup.js'],
    testTimeout: 30000,
    hookTimeout: 120000, // first run downloads the mongod binary
    fileParallelism: false, // shared DB — run integration files serially
  },
});
