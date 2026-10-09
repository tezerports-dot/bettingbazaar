// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// PgBouncer compatibility tier: the app's database behaviour THROUGH a
// transaction-pooling PgBouncer (deploy/vps/pgbouncer/pgbouncer.ini).
// Needs PGBOUNCER_URL (app database via the pooler), PGBOUNCER_ADMIN_URL (its
// `pgbouncer` console) and DIRECT_DATABASE_URL (PostgreSQL itself). It FAILS
// without them rather than skipping: a pooling check that did not run is not
// a pass. `npm run test:pgbouncer`; CI job `pgbouncer`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { BB_RATE_LIMIT_RELAX: '1' },
    globals: true,
    environment: 'node',
    include: ['backend/tests/pgbouncer/**/*.test.js'],
    testTimeout: 60000,
    fileParallelism: false,
  },
});
