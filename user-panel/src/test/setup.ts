// GOVERNANCE: Read CLAUDE.md before editing this file.
// Matchers (toBeInTheDocument, toBeDisabled, …) and a clean DOM per test.
//
// The cleanup matters more than it looks: a modal left mounted by one test is
// still in the document for the next, so a query that should find nothing finds
// the previous test's node and the assertion passes for the wrong reason.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom does not implement scrollIntoView. Every real browser and the Capacitor
// WebView do, so this is a gap in the test environment rather than something a
// component should have to guard — a `?.` in production code to satisfy jsdom
// is test scaffolding smuggled into the app.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() { /* no layout in jsdom */ };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
