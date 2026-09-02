// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Postgres-only tests: the money paths that Postgres itself is responsible for
// — row locking, the negative-balance guard, the unique-tx_id idempotency gate,
// the append-only and conserve-to-zero triggers.
//
// Deliberately separate from vitest.integration.config.ts, which boots an
// in-memory MongoDB. These tests need NO MongoDB, so splitting them means they
// run anywhere a Postgres is reachable — including the restricted build sandbox,
// where the mongod binary download is blocked. That matters: the authoritative
// wallet path is the code the cutover flips to, and "CI will check it" is a
// weaker guarantee than being able to run it while writing it.
//
// Skips itself (not fails) when DATABASE_URL is unset.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['database/tests/**/*.test.js'],
    testTimeout: 30000,
    fileParallelism: false, // shared database
  },
});
