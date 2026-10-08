// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// Unit tests: the half-authenticated state between password and OTP.
//
// The property under test is narrow and load-bearing: a challenge token must
// never function as a session token. If it does, the login handler is handing
// working credentials to anyone holding only the password — the exact attack
// 2FA exists to stop, made worse by looking enforced. Everything else here is
// secondary to that.
import { describe, it, expect } from 'vitest';

// Must be set BEFORE the dynamic imports below: paseto.util.js fail-fasts at
// module load if no signing seed is present.
process.env.JWT_SECRET ||= 'test-only-paseto-seed';

const {
  issueChallenge, verifyChallenge, isChallengeToken, challengeSubject, CHALLENGE_PURPOSE,
} = await import('../../domains/identity/twoFactorChallenge.js');
const { signToken, verifyJwt } = await import('../../domains/identity/jwt.util.js');

const USER_ID = '6a6994668cfe3d7f5d3046b9';
const CID = 'c0123456789abcdef0123456789abcdef';
const issue = (over = {}) => issueChallenge({ userId: USER_ID, door: 'PLAYER', challengeId: CID, ttlSeconds: 300, ...over });

describe('2FA challenge token', () => {
  it('round-trips the account, door and challenge it was issued for', () => {
    const c = verifyChallenge(issue({ door: 'STAFF', loginType: 'admin' }), 'STAFF');
    expect(c).toEqual({ userId: USER_ID, challengeId: CID, door: 'STAFF', loginType: 'admin' });
  });

  it('may name no account yet (an unbound Login with Telegram)', () => {
    expect(verifyChallenge(issue({ userId: null }), 'PLAYER')).toMatchObject({ userId: null, challengeId: CID });
    expect(challengeSubject(issue({ userId: null }))).toEqual({ id: `c:${CID}`, door: 'PLAYER' });
  });

  it('carries NO privilege claims', () => {
    // Defence in depth: if a challenge ever reaches a session path that fails
    // to check `purpose`, it must degrade to an unprivileged principal rather
    // than an admin one. A missed check should cost authorisation, not grant it.
    const claims = verifyJwt(issue({ door: 'STAFF', loginType: 'admin' }));
    for (const k of ['userId', 'role', 'isAdmin', 'isSubAdmin', 'merchantId', 'isMerchant', 'permissions', 'amr']) {
      expect(claims[k]).toBeUndefined();
    }
  });

  it('is identifiable as a challenge, and a real session token is not', () => {
    expect(isChallengeToken(verifyJwt(issue()))).toBe(true);
    const session = signToken({ userId: USER_ID, role: 'admin', isAdmin: true });
    expect(isChallengeToken(verifyJwt(session))).toBe(false);
    expect(isChallengeToken(null)).toBe(false);
    expect(isChallengeToken({})).toBe(false);
  });

  it('cannot be redeemed at another door', () => {
    const merchant = issue({ door: 'MERCHANT' });
    expect(verifyChallenge(merchant, 'PLAYER')).toBeNull();
    expect(verifyChallenge(merchant, 'STAFF')).toBeNull();
    expect(verifyChallenge(merchant, 'MERCHANT')).not.toBeNull();
  });

  it('refuses a session token presented as a challenge', () => {
    const session = signToken({ userId: USER_ID, role: 'user' });
    expect(verifyChallenge(session, 'PLAYER')).toBeNull();
  });

  it('refuses forged, malformed, and empty tokens', () => {
    for (const t of ['not-a-token', '', null, undefined]) expect(verifyChallenge(t, 'PLAYER')).toBeNull();
    const good = issue();
    expect(verifyChallenge(good.slice(0, -4) + 'AAAA', 'PLAYER')).toBeNull();
  });

  it('refuses an expired challenge, and one with no challenge id', () => {
    const expired = signToken({ sub: USER_ID, purpose: CHALLENGE_PURPOSE, door: 'PLAYER', cid: CID }, { expiresIn: '-1s' });
    expect(verifyChallenge(expired, 'PLAYER')).toBeNull();
    const noCid = signToken({ sub: USER_ID, purpose: CHALLENGE_PURPOSE, door: 'PLAYER' }, { expiresIn: '60s' });
    expect(verifyChallenge(noCid, 'PLAYER')).toBeNull();
  });

  it('rejects an unknown door or a missing challenge id at issue time', () => {
    expect(() => issue({ door: 'admin-panel' })).toThrow(/unknown door/);
    expect(() => issue({ challengeId: '' })).toThrow(/challenge id is required/);
  });
});
