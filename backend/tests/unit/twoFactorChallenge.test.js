// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
  issueChallenge, verifyChallenge, isChallengeToken,
  CHALLENGE_AUDIENCE, CHALLENGE_PURPOSE,
} = await import('../../domains/identity/twoFactorChallenge.js');
const { signToken, verifyJwt } = await import('../../domains/identity/jwt.util.js');

const USER_ID = '6a6994668cfe3d7f5d3046b9';

describe('2FA challenge token', () => {
  it('round-trips the subject it was issued for', () => {
    const t = issueChallenge({ id: USER_ID, audience: CHALLENGE_AUDIENCE.USER, loginType: 'admin' });
    const c = verifyChallenge(t, CHALLENGE_AUDIENCE.USER);
    expect(c).toEqual({ id: USER_ID, audience: 'user', loginType: 'admin' });
  });

  it('carries NO privilege claims', () => {
    // Defence in depth: if a challenge ever reaches a session path that fails
    // to check `purpose`, it must degrade to an unprivileged principal rather
    // than an admin one. A missed check should cost authorisation, not grant it.
    const claims = verifyJwt(issueChallenge({ id: USER_ID, audience: CHALLENGE_AUDIENCE.USER, loginType: 'admin' }));
    expect(claims.userId).toBeUndefined();
    expect(claims.role).toBeUndefined();
    expect(claims.isAdmin).toBeUndefined();
    expect(claims.isSubAdmin).toBeUndefined();
    expect(claims.merchantId).toBeUndefined();
    expect(claims.isMerchant).toBeUndefined();
    expect(claims.permissions).toBeUndefined();
  });

  it('is identifiable as a challenge, and a real session token is not', () => {
    // This is the predicate authenticate() and merchantAuth() gate on.
    expect(isChallengeToken(verifyJwt(issueChallenge({ id: USER_ID, audience: CHALLENGE_AUDIENCE.USER })))).toBe(true);

    const session = signToken({ userId: USER_ID, role: 'admin', isAdmin: true });
    expect(isChallengeToken(verifyJwt(session))).toBe(false);
    expect(isChallengeToken(null)).toBe(false);
    expect(isChallengeToken({})).toBe(false);
  });

  it('cannot be redeemed on the wrong audience', () => {
    // A merchant challenge must not open a user session, and vice versa —
    // both are signed by the same key, so only the claim separates them.
    const merchant = issueChallenge({ id: USER_ID, audience: CHALLENGE_AUDIENCE.MERCHANT });
    expect(verifyChallenge(merchant, CHALLENGE_AUDIENCE.USER)).toBeNull();
    expect(verifyChallenge(merchant, CHALLENGE_AUDIENCE.MERCHANT)).not.toBeNull();

    const user = issueChallenge({ id: USER_ID, audience: CHALLENGE_AUDIENCE.USER });
    expect(verifyChallenge(user, CHALLENGE_AUDIENCE.MERCHANT)).toBeNull();
  });

  it('refuses a session token presented as a challenge', () => {
    // The mirror of the main property: /login/2fa must not accept an ordinary
    // session token as proof that a password was just checked.
    const session = signToken({ userId: USER_ID, role: 'user' });
    expect(verifyChallenge(session, CHALLENGE_AUDIENCE.USER)).toBeNull();
  });

  it('refuses forged, malformed, and empty tokens', () => {
    expect(verifyChallenge('not-a-token', CHALLENGE_AUDIENCE.USER)).toBeNull();
    expect(verifyChallenge('', CHALLENGE_AUDIENCE.USER)).toBeNull();
    expect(verifyChallenge(null, CHALLENGE_AUDIENCE.USER)).toBeNull();
    expect(verifyChallenge(undefined, CHALLENGE_AUDIENCE.USER)).toBeNull();
    // Right shape, wrong signature.
    const good = issueChallenge({ id: USER_ID, audience: CHALLENGE_AUDIENCE.USER });
    expect(verifyChallenge(good.slice(0, -4) + 'AAAA', CHALLENGE_AUDIENCE.USER)).toBeNull();
  });

  it('refuses an expired challenge', () => {
    const expired = signToken(
      { sub: USER_ID, purpose: CHALLENGE_PURPOSE, aud2fa: 'user', loginType: null },
      { expiresIn: '-1s' },
    );
    expect(verifyChallenge(expired, CHALLENGE_AUDIENCE.USER)).toBeNull();
  });

  it('rejects an unknown audience at issue time', () => {
    // Fail loudly at the call site rather than minting a token nothing can redeem.
    expect(() => issueChallenge({ id: USER_ID, audience: 'admin-panel' })).toThrow(/unknown audience/);
    expect(() => issueChallenge({ id: '', audience: CHALLENGE_AUDIENCE.USER })).toThrow(/id is required/);
  });
});
