// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
// Unit tests for panel logic that is plain TypeScript — no DOM, no React.
// The origin-failover module is the first: it decides which host the app talks
// to when one stops answering, which is exactly the kind of thing that must be
// proven rather than eyeballed.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
