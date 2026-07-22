// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// The global /api/* rate-limit backstop must NOT throttle phantom (ghost) bet
// placement — phantom managers fire many equalizer bets in quick succession to
// keep the display pool balanced. The exemption is expressed as the
// isPhantomBetPlacement skip predicate; these tests pin its exact shape so a
// future edit can't silently widen it (DoS hole) or narrow it (throttled managers).
import { describe, it, expect } from 'vitest';
import { isPhantomBetPlacement, PHANTOM_BET_PATH } from '../../config/security.config.js';

const req = (over = {}) => ({ method: 'POST', originalUrl: PHANTOM_BET_PATH, ...over });

describe('isPhantomBetPlacement (global rate-limit exemption)', () => {
  it('exempts a POST to the phantom bet path', () => {
    expect(isPhantomBetPlacement(req())).toBe(true);
  });

  it('exempts even with a query string appended', () => {
    expect(isPhantomBetPlacement(req({ originalUrl: '/api/bet/phantom?x=1&y=2' }))).toBe(true);
  });

  it('exempts with a trailing slash (same route)', () => {
    expect(isPhantomBetPlacement(req({ originalUrl: '/api/bet/phantom/' }))).toBe(true);
  });

  it('does NOT exempt non-POST methods on the phantom path', () => {
    expect(isPhantomBetPlacement(req({ method: 'GET' }))).toBe(false);
    expect(isPhantomBetPlacement(req({ method: 'DELETE' }))).toBe(false);
  });

  it('does NOT exempt the real-money bet placement path', () => {
    expect(isPhantomBetPlacement(req({ originalUrl: '/api/bet/place' }))).toBe(false);
  });

  it('does NOT exempt look-alike or nested paths', () => {
    expect(isPhantomBetPlacement(req({ originalUrl: '/api/bet/phantomx' }))).toBe(false);
    expect(isPhantomBetPlacement(req({ originalUrl: '/api/bet/phantom/extra' }))).toBe(false);
    expect(isPhantomBetPlacement(req({ originalUrl: '/api/admin/bet/phantom' }))).toBe(false);
  });

  it('does NOT throw on a missing originalUrl (fails closed to not-exempt)', () => {
    expect(isPhantomBetPlacement({ method: 'POST' })).toBe(false);
  });
});
