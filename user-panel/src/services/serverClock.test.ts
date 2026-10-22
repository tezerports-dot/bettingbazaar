// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The clock is module state: a fresh copy for every test.
let clock: typeof import('./serverClock');
const PHONE = 1_800_000_000_000;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(PHONE);
  clock = await import('./serverClock');
});
afterEach(() => { vi.useRealTimers(); });

describe('the server clock on the phone', () => {
  it('is the phone clock until the server has said its time', () => {
    expect(clock.serverNow()).toBe(PHONE);
  });

  it('follows the server when the phone clock is fast or slow', () => {
    clock.noteServerTime(PHONE - 20_000, PHONE);          // phone 20 s fast
    expect(clock.serverNow()).toBe(PHONE - 20_000);
  });

  it('follows a slow phone too', () => {
    clock.noteServerTime(PHONE + 90_000, PHONE);          // phone 90 s slow
    expect(clock.serverNow()).toBe(PHONE + 90_000);
  });

  it('takes the least-delayed sample: delivery only makes a sample late', () => {
    clock.noteServerTime(PHONE - 800, PHONE);             // arrived 800 ms after it was sent
    clock.noteServerTime(PHONE - 50, PHONE);              // arrived 50 ms after
    clock.noteServerTime(PHONE - 400, PHONE);
    expect(clock.serverNow()).toBe(PHONE - 50);
  });

  it('forgets old samples, so a clock changed mid-session is followed', () => {
    clock.noteServerTime(PHONE + 60_000, PHONE);          // phone was a minute slow
    for (let i = 0; i < 5; i++) clock.noteServerTime(PHONE, PHONE); // the player fixed it
    expect(clock.serverNow()).toBe(PHONE);
  });

  it('ignores anything that is not an epoch-ms time', () => {
    for (const v of [undefined, null, '1800000000000', NaN, Infinity, 42, new Date(PHONE - 5_000)]) {
      clock.noteServerTime(v, PHONE);
    }
    expect(clock.serverNow()).toBe(PHONE);
  });
});
