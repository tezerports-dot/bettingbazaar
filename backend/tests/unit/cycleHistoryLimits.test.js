// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The history feed's per-type ceilings.
 *
 * These are asserted because the failure they guard is silent. The client's
 * streak analytics are specified over a 1,440-result window
 * (`ANALYTICS_WINDOW` in `user-panel/src/constants.ts` — §4 mirror), and the
 * drawer requests exactly that. If the server's ceiling drops below it, the
 * request still succeeds, the charts still render, and they simply describe a
 * shorter history than the one they claim — nothing errors and no test would
 * otherwise notice.
 *
 * The multi-type ceiling is separate and much lower on purpose: three deep
 * windows in one socket message is ~864 KB against socket.io's 1 MB default
 * `maxHttpBufferSize`, so the request that asks for every type is the one that
 * must not ask deeply.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LIMIT, MAX_SINGLE_TYPE, MAX_ALL_TYPES, normaliseLimit,
} from '../../domains/markets/cycleHistory.service.js';

// Mirrors ANALYTICS_WINDOW in user-panel/src/constants.ts. The largest window
// any board asks for; the server must be able to serve it.
const DEEPEST_CLIENT_WINDOW = 1440;

describe('cycle history limits', () => {
  it('can serve the deepest window the client asks for', () => {
    expect(MAX_SINGLE_TYPE).toBeGreaterThanOrEqual(DEEPEST_CLIENT_WINDOW);
  });

  it('serves a single type deeply and every type shallowly', () => {
    expect(normaliseLimit(DEEPEST_CLIENT_WINDOW, 1)).toBe(DEEPEST_CLIENT_WINDOW);
    // Same request across three types is clamped, not honoured.
    expect(normaliseLimit(DEEPEST_CLIENT_WINDOW, 3)).toBe(MAX_ALL_TYPES);
    expect(MAX_ALL_TYPES).toBeLessThan(MAX_SINGLE_TYPE);
  });

  it('keeps the connect payload small when no limit is given', () => {
    // Paid by every visitor, including anonymous ones who never open the
    // analytics drawer — so the default is not the maximum.
    expect(normaliseLimit(undefined, 3)).toBe(DEFAULT_LIMIT);
    expect(normaliseLimit(undefined, 1)).toBe(DEFAULT_LIMIT);
    expect(DEFAULT_LIMIT).toBeLessThan(MAX_ALL_TYPES);
  });

  it('rejects nonsense rather than passing it to the query', () => {
    expect(normaliseLimit('abc', 1)).toBe(DEFAULT_LIMIT);
    expect(normaliseLimit(0, 1)).toBe(1);
    expect(normaliseLimit(-5, 1)).toBe(1);
    expect(normaliseLimit(999999, 1)).toBe(MAX_SINGLE_TYPE);
  });
});
