// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * A per-user limiter counts against the user.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `twoFactorLimiter`, `ipBetLimiter` and `withdrawalLimiter` were all keyed on
 * `req.user?.id`. `authenticate` sets `req.user` to what the users repository
 * returns, and that object has `userId` — it has never had `id`. So the
 * expression was always `undefined` and all three silently fell through to
 * their fallback, the client IP, while `ipBetLimiter`'s own comment said "Track
 * per user, not per IP (users may share IPs)" directly above the line.
 *
 * Nothing failed. A rate limiter that keys on the wrong field still limits
 * something, still returns 429s, and still looks alive in every test that only
 * checks a 429 eventually appears.
 *
 * The two failures are opposite and both real:
 *
 *   Per IP, this platform's players — Indian mobile carriers behind CGNAT,
 *   thousands of subscribers per address — share one bucket. One heavy user
 *   throttles strangers.
 *
 *   Per IP is not a limit for anyone willing to change IP. A mobile reconnect
 *   is a new address, so a 5-per-hour withdrawal cap and a 5-failures-per-15-
 *   minutes 2FA cap could both be reset at will. Neither 2FA login route
 *   carries a mobile in its body — both take `{ challengeToken, code }` — so
 *   the 2FA fallback went straight to the IP, and an attacker who already had
 *   the password could brute-force a six-digit code by cycling addresses.
 */
import { describe, it, expect } from 'vitest';
import { actorKey, actorAccount } from '../../middleware/security.js';

const req = (over = {}) => ({ ip: '203.0.113.7', body: {}, ...over });

describe('actorKey — who a limiter counts against', () => {
  it('uses the signed-in user, not the IP', () => {
    // `userId`, not `id`. This is the whole bug, as one assertion.
    const key = actorKey(req({ user: { userId: 'u-42', username: 'ravi' } }));
    expect(key).toBe('u:u-42');
    expect(key).not.toContain('203.0.113.7');
  });

  it('gives two users on ONE address separate buckets', () => {
    // The CGNAT case: one heavy player must not throttle strangers.
    const a = actorKey(req({ user: { userId: 'u-1' } }));
    const b = actorKey(req({ user: { userId: 'u-2' } }));
    expect(a).not.toBe(b);
  });

  it('gives one user on TWO addresses the SAME bucket', () => {
    // The bypass: a mobile reconnect must not hand back a fresh withdrawal cap.
    const home = actorKey({ ip: '203.0.113.7', body: {}, user: { userId: 'u-1' } });
    const cell = actorKey({ ip: '198.51.100.9', body: {}, user: { userId: 'u-1' } });
    expect(home).toBe(cell);
  });

  it('uses the merchant on a merchant-authenticated request', () => {
    // `merchantAuth` sets `req.merchantId` and never sets `req.user`, so every
    // merchant 2FA route was keyed on the IP too.
    expect(actorKey(req({ merchantId: 'mrc-9' }))).toBe('m:mrc-9');
  });

  it('keys a pre-session 2FA attempt on the challenge, not the caller', () => {
    // One challenge token is one login attempt for one account, and it cannot
    // be re-minted without passing the password limiter again — so cycling IPs
    // buys an attacker nothing.
    const one = { ip: '203.0.113.7', body: { challengeToken: 'tok-abc', code: '000000' } };
    const other = { ip: '198.51.100.9', body: { challengeToken: 'tok-abc', code: '111111' } };
    expect(actorKey(one)).toBe(actorKey(other));
    expect(actorKey(one)).toMatch(/^c:[0-9a-f]{32}$/);
    // The token itself never becomes a Redis key name or a log line: it is a
    // bearer credential for the rest of its short life.
    expect(actorKey(one)).not.toContain('tok-abc');
  });

  it('separates two different challenges', () => {
    const a = actorKey({ ip: '203.0.113.7', body: { challengeToken: 'tok-a' } });
    const b = actorKey({ ip: '203.0.113.7', body: { challengeToken: 'tok-b' } });
    expect(a).not.toBe(b);
  });

  it('falls back to the mobile, then the IP, and only then', () => {
    expect(actorKey(req({ body: { mobile: '9000000001' } }))).toBe('p:9000000001');
    // Nothing identifies this caller at all — the IP is the last resort, not
    // the default.
    expect(actorKey(req())).toContain('203.0.113.7');
  });

  it('prefers the session over anything in the body', () => {
    // A body is attacker-controlled. A caller must not pick their own bucket by
    // sending someone else's mobile.
    const key = actorKey(req({
      user: { userId: 'u-42' },
      body: { mobile: '9999999999', challengeToken: 'tok-x' },
    }));
    expect(key).toBe('u:u-42');
  });
});

describe('actorAccount — what a security audit row names', () => {
  it('names the account, so a takeover query is a column read', () => {
    // The handler logs TWO_FACTOR_RATE_LIMIT_EXCEEDED with `account`, and its
    // comment promises "which accounts saw repeated 2FA failures" is a query
    // over a column. It read `req.user?.id`, so the column was null.
    expect(actorAccount(req({ user: { userId: 'u-42' } }))).toBe('u-42');
    expect(actorAccount(req({ merchantId: 'mrc-9' }))).toBe('mrc-9');
    expect(actorAccount(req({ body: { mobile: '9000000001' } }))).toBe('9000000001');
  });

  it('is null rather than a guess when nobody is identified', () => {
    expect(actorAccount(req())).toBeNull();
    // Not the challenge token: it is a credential, and an audit row is read by
    // people.
    expect(actorAccount(req({ body: { challengeToken: 'tok-abc' } }))).toBeNull();
  });
});
