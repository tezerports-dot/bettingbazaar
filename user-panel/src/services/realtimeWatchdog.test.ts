// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import { describe, it, expect } from 'vitest';
import { hasStaleRound, mayReopen, STALE_AFTER_END_MS, REOPEN_AT_MOST_EVERY_MS } from './realtimeWatchdog';

describe('the board stream watchdog', () => {
  const now = 1_800_000_000_000;

  it('calls a round stale once it ended the grace ago and is still shown', () => {
    expect(hasStaleRound({ a: { endTime: now - STALE_AFTER_END_MS } }, now)).toBe(true);
    expect(hasStaleRound({ a: { endTime: now - 7 * 60_000 } }, now)).toBe(true);
  });

  it('leaves a running round, one just ended (result due), and a board still loading alone', () => {
    expect(hasStaleRound({ a: { endTime: now + 60_000 } }, now)).toBe(false);
    expect(hasStaleRound({ a: { endTime: now - 12_000 } }, now)).toBe(false);
    expect(hasStaleRound({ a: { endTime: 0 }, b: undefined }, now)).toBe(false);
  });

  it('reopens at most once a minute', () => {
    expect(mayReopen(0, now)).toBe(true);
    expect(mayReopen(now - 10_000, now)).toBe(false);
    expect(mayReopen(now - REOPEN_AT_MOST_EVERY_MS, now)).toBe(true);
  });
});
