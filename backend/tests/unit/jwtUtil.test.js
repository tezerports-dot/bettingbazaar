// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the token authority: JWT compatibility names now issue and
// verify PASETO v2.public tokens with Ed25519 signatures and no alg header.
import { describe, it, expect, beforeAll } from 'vitest';

process.env.JWT_SECRET ||= 'test-only-paseto-seed';

let signToken, verifyJwt, tryVerifyJwt, decodeTokenClaims, JWT_ISSUER, JWT_AUDIENCE;
beforeAll(async () => {
  const m = await import('../../domains/identity/jwt.util.js');
  ({ signToken, verifyJwt, tryVerifyJwt, decodeTokenClaims, JWT_ISSUER, JWT_AUDIENCE } = m);
});

describe('signToken', () => {
  it('issues PASETO and stamps issuer + audience', () => {
    const token = signToken({ userId: 'u1' });
    expect(token.startsWith('v2.public.')).toBe(true);
    const decoded = decodeTokenClaims(token);
    expect(decoded.iss).toBe(JWT_ISSUER);
    expect(decoded.aud).toBe(JWT_AUDIENCE);
    expect(decoded.userId).toBe('u1');
    expect(Date.parse(decoded.exp)).toBeGreaterThan(Date.now());
  });

  it('round-trips through verifyJwt compatibility export', () => {
    const token = signToken({ userId: 'u2', roles: ['user'] });
    const out = verifyJwt(token);
    expect(out.userId).toBe('u2');
    expect(out.roles).toEqual(['user']);
  });

  it('honors an explicit expiresIn override', () => {
    const token = signToken({ userId: 'u3' }, { expiresIn: '1s' });
    const { iat, exp } = decodeTokenClaims(token);
    expect(Date.parse(exp) - Date.parse(iat)).toBe(1000);
  });
});

describe('verifyJwt — algorithm confusion defense', () => {
  it('rejects JWT alg:none because only PASETO format is accepted', () => {
    const forged = 'eyJhbGciOiJub25lIn0.eyJ1c2VySWQiOiJhdHRhY2tlciJ9.';
    expect(() => verifyJwt(forged)).toThrow();
  });

  it('rejects tampered PASETO payloads', () => {
    const good = signToken({ userId: 'x' });
    const bad = `${good.slice(0, -2)}aa`;
    expect(() => verifyJwt(bad)).toThrow();
  });

  it('rejects an expired token with TokenExpiredError', () => {
    const token = signToken({ userId: 'u4' }, { expiresIn: -10 });
    let err;
    try { verifyJwt(token); } catch (e) { err = e; }
    expect(err?.name).toBe('TokenExpiredError');
  });
});

describe('tryVerifyJwt', () => {
  it('returns the payload on success and null on failure', () => {
    const token = signToken({ userId: 'u5' });
    expect(tryVerifyJwt(token).userId).toBe('u5');
    expect(tryVerifyJwt('not-a-token')).toBeNull();
  });
});
