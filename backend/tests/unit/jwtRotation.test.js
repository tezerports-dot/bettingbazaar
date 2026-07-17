// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// PASETO replacement smoke test for the historical jwt.util compatibility API.
import { describe, it, expect } from 'vitest';

process.env.JWT_SECRET ||= 'rotation-current-key';
const { signToken, verifyJwt, PASETO_PUBLIC_KEY } = await import('../../domains/identity/jwt.util.js');

describe('PASETO token authority compatibility', () => {
  it('signs and verifies with Ed25519-backed PASETO', () => {
    const token = signToken({ userId: 'current' });
    expect(token.startsWith('v2.public.')).toBe(true);
    expect(PASETO_PUBLIC_KEY).toBeTruthy();
    expect(verifyJwt(token).userId).toBe('current');
  });

  it('rejects a token signed outside the configured authority', () => {
    const alien = `${signToken({ userId: 'attacker' }).slice(0, -4)}abcd`;
    expect(() => verifyJwt(alien)).toThrow();
  });
});
