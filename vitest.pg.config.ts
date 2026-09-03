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
    // Route tests live under backend/ but need a real PostgreSQL for the same
    // reason the repository tests do: they mount the real routers against the
    // real data layer, and a handler that would throw in production must throw
    // here. Splitting them into a third config would mean a third CI step and
    // a third place to forget.
    include: ['database/tests/**/*.test.js', 'backend/tests/routes/**/*.test.js'],
    // Route modules refuse to load without signing keys, so they are set
    // before any import runs. Repository tests do not need them and are
    // unaffected by their presence.
    setupFiles: ['backend/tests/routes/setup.js'],
    testTimeout: 30000,
    fileParallelism: false, // shared database
  },
});
