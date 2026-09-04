// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
// Two tiers, in one config, because they differ only in whether they need a DOM.
//
//   *.test.ts   plain TypeScript panel logic — no DOM, no React. The
//               origin-failover module is the archetype: it decides which host
//               the app talks to when one stops answering, which is exactly the
//               kind of thing that must be proven rather than eyeballed.
//   *.test.tsx  components, rendered. A modal that moves money is a money path
//               with a mouse on it: what it shows, what it refuses to submit,
//               and what it does when the request fails.
//
// `environment: 'jsdom'` is set for BOTH rather than split per-file. jsdom costs
// milliseconds on a logic test and a split config is a second place to forget.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
