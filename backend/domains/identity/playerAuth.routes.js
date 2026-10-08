// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * playerAuth.routes.js — the player's FORM signup, the player sign-in door, the
 * player's own Telegram link, and the password reset.
 *
 * ── Step 3 (owner, 2026-10-07) ─────────────────────────────────────────────
 * "they must verify and share contact on signup ... now they can do login
 * without telegram mini app but add also login with telegram button too."
 *
 *   FORM (here)        → the account exists, with a password, and NO session
 *   MINI APP (Telegram) → the contact share proves the mobile and links the
 *                         account; for a player it is also the moment the
 *                         joining number and the referrer's ₹25 are booked
 *   then               → sign in with the mobile and password, or with Telegram
 *
 * The signup answers with the Telegram step (`challengeToken`, `telegram`), and
 * the panel polls `/login/2fa` with the token: the approval signs them in,
 * because they have just proved the password and the phone. An account that
 * never finishes is met by the same step at every sign-in
 * (TELEGRAM_VERIFICATION_REQUIRED), so nothing is lost by closing the tab.
 *
 * ── Rate limiting is per ROUTE, never on the router ────────────────────────
 * The sign-in legs carry their door's chain (`loginDoors.js`); signup carries
 * its own (`signupChain`); the reset carries the credential chain. The router
 * also serves `/invite/:code` and the session routes' neighbours, which check
 * no credential (§32 S27, S28).
 */
import express from 'express';
import { db } from '#db';
import { hashPassword } from './password.util.js';
import { assertPlayerPassword } from './passwordPolicy.js';
import { generateReferralCode } from '../referral/referral.service.js';
import {
  normalisePhone, isValidMobile, normaliseReferralCode,
} from './signupFields.js';
import { respondError, refusal } from '../../shared/httpError.js';
import { redeemResetLink } from './passwordReset.service.js';
import { authenticatePlayer } from './auth.middleware.js';
import { authLimiter, loginPaceLimiter, signupLimiter } from '../../middleware/security.js';
import { requireCaptcha } from '../../middleware/captcha.js';
import { createSubnetLimiter, globalSurgeBreaker } from '../../middleware/ipDefense.js';
import { doorRoute } from './loginDoors.js';
import { openChallenge } from './telegramChallenge.service.js';
import { miniAppBot } from '../telegram/telegramClient.js';
import { telegramStatus, telegramRelink, telegramTwoFactor } from './accountTelegram.js';

const router = express.Router();

/**
 * The chain a route that checks a PASSWORD carries, in this order.
 *
 * `loginPaceLimiter` FIRST, deliberately and for the reason the admin door
 * states: a paced request never reaches the credential check, so it is not a
 * failed attempt and must not consume the failure budget behind it — otherwise
 * a burst of throttled retries locks out the account it was protecting.
 *
 * `authLimiter` is the failure budget (four failures per thirty minutes, per
 * IP). It belongs HERE and not on the session router, which is where it used
 * to be: that router checks no credential, so every expired-token `GET /me`
 * was counted as a failed login attempt and four page loads locked a player out
 * of logging OUT (§32 S27). Now it guards a path that genuinely verifies a
 * password, which is the only kind of path it can do anything for.
 *
 * `requireCaptcha` is a pass-through until TURNSTILE_SECRET_KEY is set. Rate
 * limits count FAILURES per IP, so credential stuffing spread thin across
 * thousands of residential addresses never reaches any counter — three tries
 * per address and move on. A challenge prices the ATTEMPT instead.
 */
const credentialChain = (action) => [
  loginPaceLimiter, authLimiter,
  // Per-IP catches the single abuser fastest; the subnet limiter catches an
  // attacker rotating addresses within one block; the surge breaker (off until
  // an admin sets a ceiling) catches rotation across subnets. Chained HERE, on
  // the route that submits a password — never on the router prefix, which also
  // carries the gate's poll. See createSubnetLimiter for what that cost.
  createSubnetLimiter('auth'), globalSurgeBreaker('auth'),
  requireCaptcha(action),
];

/**
 * And the chain SIGNUP carries, which is deliberately not that one.
 *
 * A registration submits no secret, so neither the pace nor the failure budget
 * has anything to bound — and both actively harm the person filling in the
 * form. Measured before this was split: with the credential chain on
 * `/register`, mistyping the confirm-password was answered "try again in 10
 * seconds", and because `loginPaceLimiter` shares one bucket across every
 * credential door on the platform, that typo also paced the LOGIN of everybody
 * on the same address.
 *
 * What is left is the control that actually fits: the captcha prices each
 * attempt, and `signupLimiter` caps how many accounts one address can END UP
 * WITH. Effects, not attempts (§32 S13).
 */
const signupChain = (action) => [
  signupLimiter,
  // `countOnly: 'successes'` for the same reason `signupLimiter` skips failures:
  // measured, three mistyped Aadhaar numbers from one address trips the default
  // and answers "too many attempts from your network" to somebody who has not
  // yet managed to submit one valid form.
  createSubnetLimiter('signup', { countOnly: 'successes' }),
  requireCaptcha(action),
];

/**
 * POST /api/v1/auth/register — the signup form.
 *
 * Body: mobile, password, confirmPassword, referralCode?, and the captcha
 * token `requireCaptcha` reads. Answers with the Telegram step, never a
 * session: the account cannot be used until its mobile is verified (Step 3).
 */
router.post('/register', ...signupChain('player-register'), async (req, res) => {
  try {
    const { mobile, password, confirmPassword, referralCode } = req.body || {};

    // ── Every refusal NAMES THE FIELD (§25, §32 S14) ───────────────────────
    // The commonest wrong box — the mobile, where they typed +91 as well —
    // looks identical to a correct one, so each mistake says which box.
    if (!isValidMobile(mobile)) {
      throw refusal(400, 'MOBILE_INVALID',
        'Enter your 10-digit mobile number — the one on your Telegram account — without +91.');
    }
    if (String(password ?? '') !== String(confirmPassword ?? '')) {
      throw refusal(400, 'PASSWORDS_DIFFER', 'The two passwords do not match.');
    }

    const number = normalisePhone(mobile);

    // Throws 400 WEAK_PASSWORD naming what is wrong. The mobile is context
    // because "my own number" is the first thing somebody reaches for.
    assertPlayerPassword(password, { mobile: number }, 'player');

    // ── A courtesy check, not the guarantee ────────────────────────────────
    // The UNIQUE index on `(mobile, account_type)` prevents a second account;
    // this produces the right sentence, and the writer returns the same reason
    // when the race is lost.
    if (await db.users.getUserByMobile(number, 'PLAYER')) {
      throw refusal(409, 'MOBILE_TAKEN', 'An account already exists for that mobile number. Log in instead.');
    }

    // ── The referrer is resolved BEFORE the account is written ─────────────
    // A code that matches nobody is reported rather than dropped: a silently
    // dropped code is a referrer who never earns and nobody can say why.
    const code = normaliseReferralCode(referralCode);
    let referrer = null;
    if (code) {
      referrer = await db.users.getUserByReferralCode(code);
      if (!referrer) throw refusal(400, 'INVITE_CODE_UNKNOWN', `No one on Betting Bazaar has the invite code ${code}.`);
    }
    // A non-empty box that normalises to nothing is a typo, not an absence.
    if (!code && String(referralCode ?? '').trim()) {
      throw refusal(400, 'INVITE_CODE_INVALID', 'That invite code is not a valid code. Leave it blank if you have none.');
    }

    const created = await db.identity.createAccountFromSignup({
      userId: db.users.newUserId(),
      username: `player${number.slice(-4)}`,
      mobile: number,
      passwordHash: await hashPassword(password),
      referralCode: generateReferralCode(),
      referredBy: referrer?.userId ?? null,
    });

    if (!created.ok) {
      // The race the courtesy check cannot close; the same sentence.
      throw refusal(409, 'MOBILE_TAKEN', created.reason === 'mobile_taken'
        ? 'An account already exists for that mobile number. Log in instead.'
        : 'An account already exists for those details.');
    }

    // ── The Telegram step, not a session ───────────────────────────────────
    // The account exists and is not usable until the Mini App's contact share
    // matches this mobile. No bot configured is the PLATFORM's state, not the
    // player's: the account is kept, and the same step is offered at their
    // next sign-in once a bot exists (§32 S14).
    if (!(await miniAppBot())) {
      return res.json({
        success: true, verificationRequired: true, verificationAvailable: false,
        challengeToken: null, telegram: null,
        message: 'Your account is created. Telegram verification is not available right now — sign in later to finish.',
      });
    }
    const opened = await openChallenge({ purpose: 'VERIFY', door: 'PLAYER', userId: created.userId, req });
    return res.json({
      success: true, verificationRequired: true, verificationAvailable: true,
      challengeToken: opened.challengeToken,
      telegram: opened.telegram,
      message: 'Account created. Verify your mobile number in Telegram to start playing.',
    });
  } catch (err) {
    return respondError(res, err, 'auth/register',
      { message: 'Could not create your account. Please try again.' });
  }
});

// ── The player sign-in door: routes.js's handlers, with this door's limits ──
router.post('/login', ...doorRoute('PLAYER', 'login'));
router.post('/login/2fa', ...doorRoute('PLAYER', 'twoFactor'));
router.post('/login/telegram', ...doorRoute('PLAYER', 'telegram'));
router.post('/login/telegram/complete', ...doorRoute('PLAYER', 'telegramComplete'));

// ── The player's own Telegram link (accountTelegram.js) ─────────────────────
router.get('/telegram', authenticatePlayer, telegramStatus);
router.post('/telegram/relink', authenticatePlayer, telegramRelink);
router.put('/telegram/two-factor', authenticatePlayer, telegramTwoFactor);

/**
 * GET /api/v1/auth/invite/:code — is this invite code real, and whose?
 *
 * The signup form pre-fills the code from the referral link and makes it
 * NON-EDITABLE when it arrived that way (owner decision). A field somebody
 * cannot change had better be right, so the form checks it and says whose it is
 * — "Invited by Rahul" is the confirmation that a link worked.
 *
 * It answers about a CODE, never about a person: the code is already public (it
 * is in the link that was shared), and the name is the referrer's `username`,
 * which is `player<last four digits>` — not their number, not their mobile.
 * There is no lookup in the other direction.
 */
router.get('/invite/:code', async (req, res) => {
  try {
    const code = normaliseReferralCode(req.params.code);
    if (!code) return res.json({ success: true, valid: false });
    const referrer = await db.users.getUserByReferralCode(code);
    return res.json({
      success: true,
      valid: Boolean(referrer),
      code,
      invitedBy: referrer?.username || '',
    });
  } catch (err) {
    return respondError(res, err, 'auth/invite',
      { message: 'Could not check that invite code.' });
  }
});

// `GET /api/v1/auth/verification` (the Telegram gate's poll) was removed with
// the gate in Step 3: an unverified account is never signed in, so there is no
// signed-in session for a gate to stand in front of.

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/v1/auth/password/reset — set a password with a reset token
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Unauthenticated by necessity: the whole point is that they cannot sign in.
 * The token comes from the Mini App (`POST /api/telegram/mini-app/password-reset`)
 * for an account of ANY panel; the account's own floor applies.
 *
 * The TOKEN is the credential, so this carries the credential chain — the
 * pace, the failure budget, the subnet limiter and the captcha. They stop this
 * endpoint being used to grind the password POLICY, and bound the damage if a
 * token ever leaks.
 *
 * It does NOT sign them in, and it evicts every session (passwordReset.service.js).
 */
router.post('/password/reset', ...credentialChain('password-reset'), async (req, res) => {
  try {
    const result = await redeemResetLink({
      token: req.body?.token,
      password: req.body?.password,
      confirmPassword: req.body?.confirmPassword,
    });
    if (result.ok) {
      return res.json({
        success: true,
        message: 'Your password has been changed. Sign in with it now.',
      });
    }
    // `invalid` covers unknown, already used and expired, with one sentence —
    // a caller that can tell them apart can map which tokens were ever live.
    const codes = { mismatch: 'PASSWORDS_DIFFER', weak: 'WEAK_PASSWORD' };
    throw refusal(400, codes[result.reason] || 'RESET_TOKEN_INVALID', result.message
      || 'This reset link is no longer valid. Open "Forgot password" in Telegram again for a new one.');
  } catch (err) {
    return respondError(res, err, 'auth/password-reset',
      { message: 'Could not change your password. Please try again.' });
  }
});

export default router;
