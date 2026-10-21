// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A lazy page whose chunk a deploy replaced reloads for the new build once;
 * a second miss soon after is a real failure and reaches the error screen;
 * any other error is never swallowed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isStaleChunkError, recoveringLoader, RELOAD_GUARD_MS } from './chunkRecovery';

const realLocation = window.location;
let reloads = 0;

beforeEach(() => {
  reloads = 0;
  sessionStorage.clear();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, reload: () => { reloads += 1; } } });
});
afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  vi.useRealTimers();
});

const stale = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: https://x/assets/ReferralPage-CRe7z2pa.js'));

describe('a chunk gone after a deploy', () => {
  it('recognises each browser\'s wording, and nothing else', () => {
    expect(isStaleChunkError(new TypeError('Failed to fetch dynamically imported module: x'))).toBe(true);
    expect(isStaleChunkError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isStaleChunkError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isStaleChunkError(new Error('Cannot read properties of undefined'))).toBe(false);
  });

  it('reloads once and does not settle, so no error screen flashes', async () => {
    const load = recoveringLoader(stale);
    let settled = false;
    void load().then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(reloads).toBe(1);
    expect(settled).toBe(false);
  });

  it('a second miss within the guard is thrown to the error boundary, not reloaded again', async () => {
    void recoveringLoader(stale)();
    await new Promise((r) => setTimeout(r, 10));
    await expect(recoveringLoader(stale)()).rejects.toThrow(/dynamically imported/);
    expect(reloads).toBe(1);
  });

  it('reloads again once the guard has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    void recoveringLoader(stale)();
    await Promise.resolve(); await Promise.resolve();
    vi.setSystemTime(Date.now() + RELOAD_GUARD_MS + 1);
    void recoveringLoader(stale)();
    await Promise.resolve(); await Promise.resolve();
    expect(reloads).toBe(2);
  });

  it('any other failure is thrown as it is', async () => {
    await expect(recoveringLoader(() => Promise.reject(new Error('boom')))()).rejects.toThrow('boom');
    expect(reloads).toBe(0);
  });
});
