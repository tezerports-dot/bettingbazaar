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
    // The same fixed, fake secrets the pg tier uses — one list, not two. The
    // signing module refuses to LOAD without a key (by design), and anything
    // importing the rate limiters now loads it: the 2FA limiter keys on the
    // VERIFIED account a challenge is for (F-036). CI's unit step sets no key,
    // so without this three suites failed there while passing on any machine
    // that happened to have one in its shell.
    setupFiles: ['backend/tests/routes/setup.js', 'backend/tests/assertionGuards.setup.js'],
  },
});
