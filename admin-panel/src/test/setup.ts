// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
// jest-dom matchers, and a clean DOM per test so a component left mounted by
// one test is not still in the document for the next.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
