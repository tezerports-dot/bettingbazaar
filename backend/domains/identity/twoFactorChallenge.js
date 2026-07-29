// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/identity/twoFactorChallenge.js — the half-authenticated state.
 *
 * A password-plus-OTP login cannot be one request: the server has to tell the
 * client "password accepted, now prove the second factor" and then trust, on
 * the follow-up request, that the password step really happened. That interim
 * proof is this module's challenge token.
 *
 * ── Why a signed token and not a server-side session ──────────────────────
 * The platform runs multiple instances behind a load balancer with no sticky
 * routing, so an in-memory pending-login map would only work when both
 * requests happened to land on the same box. A signed, short-lived token is
 * stateless and correct on every instance. It rides the same PASETO/Ed25519
 * authority as session tokens, so there is one signing key to protect and
 * rotate rather than two.
 *
 * ── The one property everything else depends on ───────────────────────────
 * A challenge token MUST NOT be usable as a session token. If it were, the
 * login handler would be handing out working credentials to anyone who knows
 * only the password — which is precisely the attack 2FA exists to stop, and
 * 2FA would be worse than useless because it would look enforced while being
 * bypassable. Two mechanisms enforce this, deliberately belt-and-braces:
 *
 *   1. The token carries `purpose: '2fa_challenge'`. `assertNotChallenge()` is
 *      called by every session-consuming middleware (authenticate,
 *      merchantAuth, /me) and rejects it.
 *   2. It deliberately omits the claims those middlewares need — no `role`,
 *      no `isAdmin`, no privilege at all — so even a missed check downgrades
 *      to an unprivileged principal rather than an admin one.
 *
 * `subjectKey` scopes the token to one identity AND one audience: a merchant
 * challenge cannot be redeemed on the user endpoint or vice versa, even
 * though both are signed by the same key.
 *
 * ── Lifetime ──────────────────────────────────────────────────────────────
 * Five minutes: comfortably longer than reading six digits off a handset,
 * far shorter than a session. An attacker who steals a challenge token still
 * needs the second factor, and only has five minutes to use it.
 */
import { signToken, verifyJwt } from './jwt.util.js';

export const CHALLENGE_PURPOSE = '2fa_challenge';
export const CHALLENGE_TTL = '5m';

/** Audiences a challenge can be scoped to. Redemption must match issuance. */
export const CHALLENGE_AUDIENCE = {
  USER: 'user',
  MERCHANT: 'merchant',
};

/**
 * Mint the interim proof that a password was accepted.
 *
 * @param {object}  subject
 * @param {string}  subject.id        User._id or Merchant._id
 * @param {string}  subject.audience  CHALLENGE_AUDIENCE value
 * @param {string} [subject.loginType] Echoed back so the second leg re-applies
 *                                     the same role gate the first leg did.
 */
export function issueChallenge({ id, audience, loginType = null }) {
  if (!id) throw new Error('issueChallenge: id is required');
  if (!Object.values(CHALLENGE_AUDIENCE).includes(audience)) {
    throw new Error(`issueChallenge: unknown audience ${audience}`);
  }
  return signToken(
    // NOTE the absence of userId/role/isAdmin. See the header: a challenge
    // that leaks into a session path must not carry privilege with it.
    { sub: String(id), purpose: CHALLENGE_PURPOSE, aud2fa: audience, loginType },
    { expiresIn: CHALLENGE_TTL },
  );
}

/**
 * Verify a challenge token and return its subject.
 * @returns {{ id: string, audience: string, loginType: string|null }|null}
 *          null for anything that is not a valid, unexpired challenge for
 *          this audience — callers must treat null as "restart the login".
 */
export function verifyChallenge(token, audience) {
  if (!token || typeof token !== 'string') return null;
  let claims;
  try {
    claims = verifyJwt(token);           // signature, iss/aud, expiry
  } catch {
    return null;                          // expired or forged
  }
  if (claims.purpose !== CHALLENGE_PURPOSE) return null;  // a session token
  if (claims.aud2fa !== audience) return null;            // wrong endpoint
  if (!claims.sub) return null;
  return { id: String(claims.sub), audience: claims.aud2fa, loginType: claims.loginType || null };
}

/**
 * True when these claims belong to a challenge token.
 * Session middlewares call this to slam the door — see header property (1).
 */
export function isChallengeToken(claims) {
  return !!claims && claims.purpose === CHALLENGE_PURPOSE;
}
