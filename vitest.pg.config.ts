// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Postgres-only tests: the money paths that Postgres itself is responsible for
// — row locking, the negative-balance guard, the unique-tx_id idempotency gate,
// the append-only and conserve-to-zero triggers.
//
// Separate from the unit config because these need a real PostgreSQL: the
// properties they assert — row locking, the conserve-to-zero trigger, a UNIQUE
// refusing a second row — belong to the database and cannot be demonstrated
// against a stub. They run anywhere a Postgres is reachable, which is what
// makes "run it while writing it" possible rather than "CI will check it".
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
