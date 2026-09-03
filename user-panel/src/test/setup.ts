// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
// Matchers (toBeInTheDocument, toBeDisabled, …) and a clean DOM per test.
//
// The cleanup matters more than it looks: a modal left mounted by one test is
// still in the document for the next, so a query that should find nothing finds
// the previous test's node and the assertion passes for the wrong reason.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
