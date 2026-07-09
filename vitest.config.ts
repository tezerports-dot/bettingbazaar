// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests: pure logic, NO database. Run everywhere (CI, laptop, sandbox)
// with `npm test`. These are the money-math correctness tests (ledger
// postings, risk validators, bonus calculator, CSV) — no mongod required.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['backend/tests/unit/**/*.test.js'],
  },
});
