// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/identity/loginDoors.js — each sign-in leg, with its door's limits.
 *
 * Each leg (routes.js) is one handler, whichever door mounts it; what differs
 * per door is which legs it has (`DOOR_LEGS`), the failure budget, the subnet
 * tier, and the captcha (the player door only: staff have their authenticator
 * app, merchants their Telegram approval). Each mount spreads
 * `doorRoute(door, leg)` onto its own router:
 *
 *   player    /api/v1/auth/login…         playerAuth.routes.js
 *   staff     /api/admin/login…           server.js
 *   merchant  /api/merchant/auth/login…   merchant.routes.js
 *
 * ── Why the chain is per LEG and never on a prefix (§32 S28) ───────────────
 *   login                  pace → failure budget → subnet (→ captcha). A
 *                          password is checked here and nowhere else.
 *   login/2fa,             poll limiter → second-factor failure budget. A
 *   login/telegram/complete  browser waiting on Telegram asks every 2–3 s, so
 *                          the credential pace (one per 10 s) would refuse the
 *                          wait itself, and a captcha (single-use tokens) would
 *                          refuse every poll after the first.
 *   login/telegram         per-address limiter: it opens a challenge before
 *                          anybody has proved anything.
 *   login/totp,            the second-factor failure budget, keyed on the
 *   login/totp/activate    ACCOUNT through the challenge token (`actorKey`),
 *                          never the address: a code is six digits.
 *   login/totp/setup       poll limiter → second-factor budget: it answers a
 *                          QR, and is asked once per enrolment.
 *
 * ── Staff have no Telegram leg (owner, 2026-10-13) ─────────────────────────
 * `doorRoute('STAFF', 'telegram')` throws at boot: a staff account signs in
 * with its password and an authenticator code, and nothing else.
 *
 * The merchant door used to be limited by a mount on `/api/merchant/auth/login`
 * — a prefix, so its captcha also sat on `/login/2fa` and refused every second
 * factor once Turnstile was switched on.
 */
import {
  loginPaceLimiter, authLimiter, adminAuthLimiter, merchantAuthLimiter,
  twoFactorLimiter, challengePollLimiter, telegramLoginLimiter,
} from '../../middleware/security.js';
import { requireCaptcha } from '../../middleware/captcha.js';
import { createSubnetLimiter, globalSurgeBreaker } from '../../middleware/ipDefense.js';
import {
  LOGIN_DOOR, loginHandler, loginTwoFactorHandler,
  telegramLoginHandler, telegramLoginCompleteHandler,
  totpLoginHandler, totpSetupHandler, totpActivateHandler,
} from '../../routes.js';

/** What each door's password leg carries before the handler. */
const CREDENTIAL_CHAIN = {
  PLAYER: () => [
    loginPaceLimiter, authLimiter,
    createSubnetLimiter('auth'), globalSurgeBreaker('auth'),
    requireCaptcha('player-login'),
  ],
  STAFF: () => [
    // No captcha for staff or merchants (owner, 2026-10-08): "they will only
    // need 2FA". Every staff sign-in waits for an authenticator code and every
    // merchant sign-in for its Telegram approval, which a script holding a
    // guessed password cannot give.
    loginPaceLimiter, adminAuthLimiter, createSubnetLimiter('adminAuth'),
    // The admin panel's role selector defaults to a full admin, as it always
    // has: a sub-admin's panel sends its own.
    (req, _res, next) => { req.body = { ...req.body, loginType: req.body?.loginType || 'admin' }; next(); },
  ],
  MERCHANT: () => [
    loginPaceLimiter, merchantAuthLimiter, createSubnetLimiter('merchantAuth'),
  ],
};

const LEGS = {
  login: (door) => [...CREDENTIAL_CHAIN[door](), loginHandler],
  twoFactor: () => [challengePollLimiter, twoFactorLimiter, loginTwoFactorHandler],
  telegram: () => [telegramLoginLimiter, telegramLoginHandler],
  telegramComplete: () => [challengePollLimiter, twoFactorLimiter, telegramLoginCompleteHandler],
  totp: () => [twoFactorLimiter, totpLoginHandler],
  totpSetup: () => [challengePollLimiter, twoFactorLimiter, totpSetupHandler],
  totpActivate: () => [twoFactorLimiter, totpActivateHandler],
};

/** Which legs each door has. Anything else is a boot-time error. */
const DOOR_LEGS = Object.freeze({
  PLAYER: Object.freeze(['login', 'twoFactor', 'telegram', 'telegramComplete']),
  MERCHANT: Object.freeze(['login', 'twoFactor', 'telegram', 'telegramComplete']),
  STAFF: Object.freeze(['login', 'totp', 'totpSetup', 'totpActivate']),
});

/**
 * The middleware for one leg at one door, ending in its handler.
 *
 * @param {'PLAYER'|'STAFF'|'MERCHANT'} door
 * @param {'login'|'twoFactor'|'telegram'|'telegramComplete'|'totp'|'totpSetup'|'totpActivate'} leg
 */
export function doorRoute(door, leg) {
  if (!LOGIN_DOOR[door]) throw new Error(`doorRoute: unknown door ${door}`);
  if (!LEGS[leg]) throw new Error(`doorRoute: unknown leg ${leg}`);
  if (!DOOR_LEGS[door].includes(leg)) throw new Error(`doorRoute: the ${door} door has no ${leg} leg`);
  const setDoor = (req, _res, next) => { req.loginDoor = LOGIN_DOOR[door]; next(); };
  const chain = LEGS[leg](door);
  // The door is set before the handler and after the limiters: a limiter never
  // reads it, and the handler never runs without it.
  return [...chain.slice(0, -1), setDoor, chain[chain.length - 1]];
}
