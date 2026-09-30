// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// Unit tests: pure logic, NO database. Run everywhere (CI, laptop, sandbox)
// with `npm test`. These are the money-math correctness tests (ledger
// postings, risk validators, bonus calculator, CSV) — no database required.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Suites here ASSERT the rate limits, so BB_RATE_LIMIT_RELAX is pinned to 1
    // (off) whatever the shell holds (CLAUDE.md §34).
    env: { BB_RATE_LIMIT_RELAX: '1' },
    globals: true,
    environment: 'node',
    include: ['backend/tests/unit/**/*.test.js'],
    // A comparison of NaN with NaN proves nothing — refused (§32 S40).
    setupFiles: ['backend/tests/assertionGuards.setup.js'],
  },
});
