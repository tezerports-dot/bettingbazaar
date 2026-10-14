// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/identity/twoFactorChallenge.js — the token a browser holds while
 * Telegram is asked.
 *
 * Step 3 (owner, 2026-10-07): an account's first sign-in waits for its Telegram
 * verification, a staff or merchant sign-in waits for its Telegram approval,
 * and "Login with Telegram" waits for the Mini App. Each is a row in
 * `telegram_challenges`; this token is how the browser that ASKED proves, when
 * it polls, that the answer is its own. The challenge id travels to Telegram in
 * the deep link; this token, signed by the session authority, never leaves the
 * browser.
 *
 * ── Why a signed token and not the id alone ───────────────────────────────
 * The id is also in the Mini App link, which the person opens on a phone, may
 * forward, and which Telegram itself sees. Redeeming needs the token, which
 * names the door it was issued at and the account it is for, so a link that
 * leaked cannot be turned into a session at another door or for another
 * account.
 *
 * ── The property everything depends on ───────────────────────────────────
 * ── The step: which leg may redeem it ─────────────────────────────────────
 * A STAFF sign-in (owner, 2026-10-13) is the password and then a code from an
 * authenticator app, with no Telegram and no challenge row: the token alone
 * carries the account from one leg to the next, and says which leg (`step`:
 * `totp` for an enrolled account, `totp_setup` for one enrolling). A token
 * with a step is refused by every Telegram leg, and a Telegram token (no step)
 * by every authenticator leg (`verifyChallenge`'s third argument), so neither
 * kind can be fed to the other's door.
 *
 * A challenge token MUST NOT be usable as a session token. It carries
 * `purpose: '2fa_challenge'`, which every session-consuming path refuses
 * (`authenticate`, `merchantAuth`, `/me`, SSE, sockets), and none of the claims
 * those paths read — no `userId`, no `role`, no `merchantId` — so even a missed
 * check is an unprivileged nobody rather than an admin.
 */
import { signToken, verifyJwt } from './jwt.util.js';
import { ACCOUNT_TYPES } from './audiences.js';

export const CHALLENGE_PURPOSE = '2fa_challenge';

/** The authenticator legs a staff challenge token can be minted for. */
const TOTP_STEPS = Object.freeze(['totp', 'totp_setup']);

/**
 * Mint the token for one challenge.
 *
 * @param {object} c
 * @param {string|null} c.userId  null only for a Telegram login that does not
 *                                yet know whose Telegram it is
 * @param {'PLAYER'|'STAFF'|'MERCHANT'} c.door  the door it may be redeemed at
 * @param {string} c.challengeId
 * @param {number} c.ttlSeconds   at least the challenge's own window plus the
 *                                redeem window; the database row decides
 * @param {string|null} [c.loginType]  the staff door's role selector, re-applied
 * @param {'totp'|'totp_setup'|null} [c.step]  the authenticator leg this token
 *                                is for (STAFF door only); null for Telegram
 */
export function issueChallenge({ userId = null, door, challengeId, ttlSeconds, loginType = null, step = null }) {
  if (!ACCOUNT_TYPES.includes(door)) throw new Error(`issueChallenge: unknown door ${door}`);
  if (!challengeId) throw new Error('issueChallenge: a challenge id is required');
  if (step !== null && !TOTP_STEPS.includes(step)) throw new Error(`issueChallenge: unknown step ${step}`);
  if (step !== null && door !== 'STAFF') throw new Error('issueChallenge: an authenticator step is for the staff door only');
  return signToken(
    // NOTE the absence of userId/role/isAdmin/merchantId: see the header.
    {
      sub: userId ? String(userId) : '', purpose: CHALLENGE_PURPOSE, door, cid: String(challengeId), loginType,
      ...(step ? { step } : {}),
    },
    { expiresIn: `${Math.max(60, Math.ceil(Number(ttlSeconds) || 0))}s` },
  );
}


/**
 * Read a challenge token presented at `door`, for the leg `step`. Null for
 * anything that is not one, has expired, was minted at another door, or was
 * minted for another leg: a Telegram leg passes no step and refuses every
 * authenticator token; an authenticator leg names its step and refuses a
 * Telegram token and the other step's.
 *
 * @param {string} token
 * @param {'PLAYER'|'STAFF'|'MERCHANT'} door
 * @param {'totp'|'totp_setup'|null} [step]
 * @returns {null | {userId: string|null, challengeId: string, door: string, loginType: string|null, step: string|null}}
 */
export function verifyChallenge(token, door, step = null) {
  if (!token || typeof token !== 'string') return null;
  let claims;
  try {
    claims = verifyJwt(token);           // signature, iss/aud, expiry
  } catch {
    return null;                          // expired or forged
  }
  if (claims.purpose !== CHALLENGE_PURPOSE) return null;  // a session token
  if (claims.door !== door || !claims.cid) return null;    // another door
  if ((claims.step || null) !== step) return null;          // another leg
  return {
    userId: claims.sub ? String(claims.sub) : null,
    challengeId: String(claims.cid),
    door: claims.door,
    loginType: claims.loginType || null,
    step: claims.step || null,
  };
}

/**
 * Who a challenge token is about, for the rate limiter's key only — never an
 * authorisation decision. The account when the token names one, else the
 * challenge.
 */
export function challengeSubject(token) {
  if (!token || typeof token !== 'string') return null;
  let claims;
  try {
    claims = verifyJwt(token);
  } catch {
    return null;
  }
  if (claims.purpose !== CHALLENGE_PURPOSE || !claims.cid) return null;
  return { id: claims.sub ? String(claims.sub) : `c:${claims.cid}`, door: claims.door };
}

/** True when the claims are a challenge, never a session. */
export function isChallengeToken(claims) {
  return !!claims && claims.purpose === CHALLENGE_PURPOSE;
}
