// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Signing out ends the session (review 2026-10-22).
 *
 * A token's `exp` is an ISO date string. The sign-out read it as Unix
 * seconds, so the revocation's time to live was NaN, the INSERT failed, and
 * the token stayed valid until it expired. This suite signs a real token,
 * revokes it the way `/logout` does, and asks the same question every
 * session check asks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { revokeToken } from '#db/repositories/identity.js';
import { signToken, decodeTokenClaims, secondsUntilExpiry } from '../../domains/identity/jwt.util.js';
import { isTokenRevoked } from '../../domains/identity/auth.middleware.js';

describe('secondsUntilExpiry', () => {
  it('reads the ISO exp a real token carries', () => {
    const now = Date.now();
    const ttl = secondsUntilExpiry({ exp: new Date(now + 3_600_000).toISOString() }, now);
    expect(ttl).toBe(3600);
  });

  it('still reads a numeric exp as Unix seconds, and never answers NaN', () => {
    const now = 1_700_000_000_000;
    expect(secondsUntilExpiry({ exp: 1_700_000_060 }, now)).toBe(60);
    expect(secondsUntilExpiry({ exp: 'not a date' }, now)).toBe(7 * 86_400);
    expect(secondsUntilExpiry(null, now)).toBe(7 * 86_400);
    expect(secondsUntilExpiry({ exp: new Date(now - 5_000).toISOString() }, now)).toBe(1);
  });
});

const describePg = pgConfigured() ? describe : describe.skip;

describePg('signing out', () => {
  beforeAll(async () => { await applySchema(); }, 60_000);
  afterAll(async () => { await closePg(); });

  it('revokes the token, so the next session check refuses it', async () => {
    const token = signToken({ userId: `logout-${Date.now()}`, accountType: 'PLAYER' });
    expect(await isTokenRevoked(token)).toBe(false);
    await revokeToken(token, { ttlSeconds: secondsUntilExpiry(decodeTokenClaims(token)) });
    expect(await isTokenRevoked(token)).toBe(true);
  });
});
