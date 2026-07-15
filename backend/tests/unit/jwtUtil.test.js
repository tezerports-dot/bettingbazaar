// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the AQ-2 JWT authority: HS256 pinning (algorithm-confusion
// rejection), iss/aud stamping, and non-production legacy-token compatibility.
import { describe, it, expect, beforeAll } from 'vitest';
import jwt from 'jsonwebtoken';

// jwt.util reads JWT_SECRET at import — set before importing.
process.env.JWT_SECRET ||= 'test-only-jwt-secret';

let signToken, verifyJwt, tryVerifyJwt, JWT_ISSUER, JWT_AUDIENCE;
beforeAll(async () => {
  const m = await import('../../domains/identity/jwt.util.js');
  ({ signToken, verifyJwt, tryVerifyJwt, JWT_ISSUER, JWT_AUDIENCE } = m);
});

describe('signToken', () => {
  it('stamps issuer + audience and HS256', () => {
    const token = signToken({ userId: 'u1' });
    const decoded = jwt.decode(token, { complete: true });
    expect(decoded.header.alg).toBe('HS256');
    expect(decoded.payload.iss).toBe(JWT_ISSUER);
    expect(decoded.payload.aud).toBe(JWT_AUDIENCE);
    expect(decoded.payload.userId).toBe('u1');
    expect(decoded.payload.exp).toBeGreaterThan(0);
  });

  it('round-trips through verifyJwt', () => {
    const token = signToken({ userId: 'u2', roles: ['user'] });
    const out = verifyJwt(token);
    expect(out.userId).toBe('u2');
    expect(out.roles).toEqual(['user']);
  });

  it('honors an explicit expiresIn override', () => {
    const token = signToken({ userId: 'u3' }, { expiresIn: '1s' });
    const { iat, exp } = jwt.decode(token);
    expect(exp - iat).toBe(1);
  });
});

describe('verifyJwt — algorithm confusion defense', () => {
  it('rejects a token signed with alg:none', () => {
    // Forge an unsigned token claiming alg:none (classic bypass attempt).
    const forged = jwt.sign({ userId: 'attacker' }, '', { algorithm: 'none' });
    expect(() => verifyJwt(forged)).toThrow();
  });

  it('rejects a token whose signature does not match the secret', () => {
    const bad = jwt.sign({ userId: 'x' }, 'a-different-secret', { algorithm: 'HS256' });
    expect(() => verifyJwt(bad)).toThrow();
  });

  it('rejects an expired token with TokenExpiredError', () => {
    const token = signToken({ userId: 'u4' }, { expiresIn: -10 }); // already expired
    let err;
    try { verifyJwt(token); } catch (e) { err = e; }
    expect(err?.name).toBe('TokenExpiredError');
  });
});

describe('legacy-token compatibility outside production', () => {
  it('accepts a legacy token that has NO iss/aud when NODE_ENV is not production', () => {
    const legacy = jwt.sign({ userId: 'legacy', role: 'user' }, process.env.JWT_SECRET);
    const out = verifyJwt(legacy);
    expect(out.userId).toBe('legacy');
  });
});

describe('tryVerifyJwt', () => {
  it('returns the payload on success and null on failure', () => {
    const token = signToken({ userId: 'u5' });
    expect(tryVerifyJwt(token).userId).toBe('u5');
    expect(tryVerifyJwt('not-a-token')).toBeNull();
  });
});
