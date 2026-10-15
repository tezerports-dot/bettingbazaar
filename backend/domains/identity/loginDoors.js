// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/identity/loginDoors.js — each sign-in leg, with its door's limits.
 *
 * Each leg (routes.js) is one handler, whichever door mounts it; what differs
 * per door is which legs it has (`DOOR_LEGS`). Each mount spreads
 * `doorRoute(door, leg)` onto its own router:
 *
 *   player    /api/v1/auth/login/telegram…         playerAuth.routes.js
 *   staff     /api/admin/login…                    server.js
 *   merchant  /api/merchant/auth/login/telegram…   merchant.routes.js
 *
 * ── Two kinds of door (owner, 2026-10-13/14) ───────────────────────────────
 * STAFF: a password and an authenticator code, and nothing else — no Telegram
 * leg. PLAYER and MERCHANT: "Continue with Telegram", and nothing else — no
 * password leg, no form. `doorRoute` throws at boot for any other leg. The
 * captcha stays where the owner put it, at the player's door only (2026-10-08):
 * on the player's Continue with Telegram, which opens a sign-in (and can make
 * an account) before anybody has proved anything. Turnstile is invisible
 * unless Cloudflare wants a tap.
 *
 * ── Why the chain is per LEG and never on a prefix (§32 S28) ───────────────
 *   login                  pace → failure budget → subnet. A password is
 *                          checked here and nowhere else.
 *   login/totp,            the second-factor failure budget, keyed on the
 *   login/totp/activate    ACCOUNT through the challenge token (`actorKey`),
 *                          never the address: a code is six digits.
 *   login/totp/setup       poll limiter → second-factor budget: it answers a
 *                          QR, and is asked once per enrolment.
 *   login/telegram         per-address limiter (and, at the player's door,
 *                          the captcha): it opens a sign-in before anybody
 *                          has proved anything.
 *   login/telegram/complete  poll limiter → second-factor budget. A browser
 *                          waiting on Telegram asks every 2–3 s, so a
 *                          credential pace (one per 10 s) would refuse the wait.
 *   login/telegram/ticket  per-address limiter: it presents a 256-bit ticket,
 *                          which no budget makes guessable.
 */
import {
  loginPaceLimiter, adminAuthLimiter,
  twoFactorLimiter, challengePollLimiter, telegramLoginLimiter, telegramLoginNoCaptchaLimiter,
} from '../../middleware/security.js';
import { createSubnetLimiter } from '../../middleware/ipDefense.js';
import { requireCaptcha } from '../../middleware/captcha.js';
import {
  LOGIN_DOOR, loginHandler,
  telegramLoginHandler, telegramLoginCompleteHandler, telegramTicketHandler,
  totpLoginHandler, totpSetupHandler, totpActivateHandler,
} from '../../routes.js';

/** What the staff password leg carries before the handler. */
const staffCredentialChain = () => [
  // No captcha for staff (owner, 2026-10-08): "they will only need 2FA". Every
  // staff sign-in waits for an authenticator code, which a script holding a
  // guessed password cannot give.
  loginPaceLimiter, adminAuthLimiter, createSubnetLimiter('adminAuth'),
  // The admin panel's role selector defaults to a full admin, as it always
  // has: a sub-admin's panel sends its own.
  (req, _res, next) => { req.body = { ...req.body, loginType: req.body?.loginType || 'admin' }; next(); },
];

const LEGS = {
  login: () => [...staffCredentialChain(), loginHandler],
  telegram: (door) => [
    telegramLoginLimiter,
    ...(door === 'PLAYER' ? [requireCaptcha('telegram-login', { outageLimiter: telegramLoginNoCaptchaLimiter })] : []),
    telegramLoginHandler,
  ],
  telegramComplete: () => [challengePollLimiter, twoFactorLimiter, telegramLoginCompleteHandler],
  telegramTicket: () => [telegramLoginLimiter, telegramTicketHandler],
  totp: () => [twoFactorLimiter, totpLoginHandler],
  totpSetup: () => [challengePollLimiter, twoFactorLimiter, totpSetupHandler],
  totpActivate: () => [twoFactorLimiter, totpActivateHandler],
};

/** Which legs each door has. Anything else is a boot-time error. */
const TELEGRAM_LEGS = Object.freeze(['telegram', 'telegramComplete', 'telegramTicket']);
const DOOR_LEGS = Object.freeze({
  PLAYER: TELEGRAM_LEGS,
  MERCHANT: TELEGRAM_LEGS,
  STAFF: Object.freeze(['login', 'totp', 'totpSetup', 'totpActivate']),
});

/**
 * The middleware for one leg at one door, ending in its handler.
 *
 * @param {'PLAYER'|'STAFF'|'MERCHANT'} door
 * @param {'login'|'telegram'|'telegramComplete'|'telegramTicket'|'totp'|'totpSetup'|'totpActivate'} leg
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
