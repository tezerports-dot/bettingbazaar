// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit test for the JWT secret-rotation keyring (Bucket B — activation-ready).
// Env is set BEFORE importing jwt.util so the keyring is configured at module load.
import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'rotation-current-key';
process.env.JWT_PREVIOUS_SECRETS = 'rotation-old-key-1, rotation-old-key-2';
const { signToken, verifyJwt } = await import('../../domains/identity/jwt.util.js');

const stamp = { algorithm: 'HS256', issuer: 'bettingbazaar', audience: 'bettingbazaar', expiresIn: '1h' };

describe('JWT secret rotation keyring', () => {
  it('signs with the CURRENT key and verifies it', () => {
    expect(verifyJwt(signToken({ userId: 'current' })).userId).toBe('current');
  });

  it('still verifies a token minted with a PREVIOUS key (zero-downtime rotation)', () => {
    const old1 = jwt.sign({ userId: 'old1' }, 'rotation-old-key-1', stamp);
    const old2 = jwt.sign({ userId: 'old2' }, 'rotation-old-key-2', stamp);
    expect(verifyJwt(old1).userId).toBe('old1');
    expect(verifyJwt(old2).userId).toBe('old2');
  });

  it('rejects a token signed with a key NOT in the ring', () => {
    const alien = jwt.sign({ userId: 'attacker' }, 'not-a-real-key', stamp);
    expect(() => verifyJwt(alien)).toThrow();
  });

  it('an expired token fails as expired, not as a key miss', () => {
    const expired = jwt.sign({ userId: 'x' }, 'rotation-old-key-1', { ...stamp, expiresIn: -5 });
    let err;
    try { verifyJwt(expired); } catch (e) { err = e; }
    expect(err?.name).toBe('TokenExpiredError');
  });
});
