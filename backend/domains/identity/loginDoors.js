// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/identity/loginDoors.js — each sign-in leg, with its door's limits.
 *
 * The four legs (routes.js) are the same handlers at all three doors; what
 * differs per door is the failure budget, the captcha action and the subnet
 * tier. Each mount spreads `doorRoute(door, leg)` onto its own router:
 *
 *   player    /api/v1/auth/login…         playerAuth.routes.js
 *   staff     /api/admin/login…           server.js
 *   merchant  /api/merchant/auth/login…   merchant.routes.js
 *
 * ── Why the chain is per LEG and never on a prefix (§32 S28) ───────────────
 *   login                  pace → failure budget → subnet → captcha. A
 *                          password is checked here and nowhere else.
 *   login/2fa,             poll limiter → second-factor failure budget. A
 *   login/telegram/complete  browser waiting on Telegram asks every 2–3 s, so
 *                          the credential pace (one per 10 s) would refuse the
 *                          wait itself, and a captcha (single-use tokens) would
 *                          refuse every poll after the first.
 *   login/telegram         per-address limiter: it opens a challenge before
 *                          anybody has proved anything.
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
} from '../../routes.js';

/** What each door's password leg carries before the handler. */
const CREDENTIAL_CHAIN = {
  PLAYER: () => [
    loginPaceLimiter, authLimiter,
    createSubnetLimiter('auth'), globalSurgeBreaker('auth'),
    requireCaptcha('player-login'),
  ],
  STAFF: () => [
    loginPaceLimiter, adminAuthLimiter, createSubnetLimiter('adminAuth'),
    requireCaptcha('admin-login'),
    // The admin panel's role selector defaults to a full admin, as it always
    // has: a sub-admin's panel sends its own.
    (req, _res, next) => { req.body = { ...req.body, loginType: req.body?.loginType || 'admin' }; next(); },
  ],
  MERCHANT: () => [
    loginPaceLimiter, merchantAuthLimiter, createSubnetLimiter('merchantAuth'),
    requireCaptcha('merchant-login'),
  ],
};

const LEGS = {
  login: (door) => [...CREDENTIAL_CHAIN[door](), loginHandler],
  twoFactor: () => [challengePollLimiter, twoFactorLimiter, loginTwoFactorHandler],
  telegram: () => [telegramLoginLimiter, telegramLoginHandler],
  telegramComplete: () => [challengePollLimiter, twoFactorLimiter, telegramLoginCompleteHandler],
};

/**
 * The middleware for one leg at one door, ending in its handler.
 *
 * @param {'PLAYER'|'STAFF'|'MERCHANT'} door
 * @param {'login'|'twoFactor'|'telegram'|'telegramComplete'} leg
 */
export function doorRoute(door, leg) {
  if (!LOGIN_DOOR[door]) throw new Error(`doorRoute: unknown door ${door}`);
  if (!LEGS[leg]) throw new Error(`doorRoute: unknown leg ${leg}`);
  const setDoor = (req, _res, next) => { req.loginDoor = LOGIN_DOOR[door]; next(); };
  const chain = LEGS[leg](door);
  // The door is set before the handler and after the limiters: a limiter never
  // reads it, and the handler never runs without it.
  return [...chain.slice(0, -1), setDoor, chain[chain.length - 1]];
}
