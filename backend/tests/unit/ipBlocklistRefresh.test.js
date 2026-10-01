// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The enforcer's two failure directions, without a database.
 *
 * A reload that FAILS must keep the list that last loaded: dropping to an empty
 * list on a database blip would unblock every blocked client at once. And the
 * boot load must THROW, so a server that cannot read the list does not start
 * serving as if nothing were blocked. The happy path — a blocked address
 * refused on a real route — is `backend/tests/routes/ipBlocklistRoutesPg`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { liveBlocks } = vi.hoisted(() => ({ liveBlocks: vi.fn() }));
vi.mock('#db', () => ({ db: { ipBlocks: { liveBlocks } } }));

beforeEach(() => { vi.resetModules(); liveBlocks.mockReset(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('ipBlocklist refresh', () => {
  it('keeps enforcing the last good list when a reload fails', async () => {
    const mw = await import('../../middleware/ipBlocklist.js');
    liveBlocks.mockResolvedValueOnce([{ network: '203.0.113.0/24' }]);
    await mw.startIpBlocklistRefresh(1000);
    expect(mw.isBlocked('203.0.113.9')).toBe(true);

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    liveBlocks.mockRejectedValueOnce(new Error('connection reset'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(liveBlocks).toHaveBeenCalledTimes(2);
    expect(mw.isBlocked('203.0.113.9')).toBe(true);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('picks up a lifted block on the next reload', async () => {
    const mw = await import('../../middleware/ipBlocklist.js');
    liveBlocks.mockResolvedValueOnce([{ network: '203.0.113.0/24' }]);
    await mw.startIpBlocklistRefresh(1000);
    liveBlocks.mockResolvedValueOnce([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mw.isBlocked('203.0.113.9')).toBe(false);
  });

  it('fails the boot when the list cannot be read', async () => {
    const mw = await import('../../middleware/ipBlocklist.js');
    liveBlocks.mockRejectedValueOnce(new Error('database down'));
    await expect(mw.startIpBlocklistRefresh(1000)).rejects.toThrow('database down');
  });

  it('never throws on an address it cannot parse, and matches the IPv4-mapped form', async () => {
    const { buildBlockList, listCovers } = await import('../../middleware/ipBlocklist.js');
    const list = buildBlockList(['203.0.113.0/24', '2001:db8::/48']);
    expect(listCovers(list, undefined)).toBe(false);
    expect(listCovers(list, 'not-an-ip')).toBe(false);
    expect(listCovers(list, '::ffff:203.0.113.200')).toBe(true);
    expect(listCovers(list, '2001:db8::1')).toBe(true);
    expect(listCovers(list, '2001:db9::1')).toBe(false);
  });
});
