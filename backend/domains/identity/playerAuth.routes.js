// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * playerAuth.routes.js — the player's FORM signup and FORM login.
 *
 * ── What changed, and why (owner decision, 2026-09-23) ─────────────────────
 * Signing up used to happen inside a Telegram bot: /start, type your Aadhaar to
 * the bot, share your contact, join the channel, and the bot DMs a one-time
 * link that is traded for a session. Signing in was a six-digit code the same
 * bot sent. Every one of those steps depended on a THIRD PARTY that suspends
 * gambling bots, rate-limits at roughly thirty messages a second per bot, and
 * cannot message anybody who has not opened a chat with it first.
 *
 * So the account is now created by a FORM this platform owns, and Telegram
 * keeps only the job it is actually good at: proving that a phone number
 * belongs to the person holding it, and carrying the official channel.
 *
 *   FORM (here)              →  the account exists, with a password
 *   TELEGRAM (the gate)      →  contact share proves the number, channel join
 *                               is the membership requirement
 *
 * The order matters and is the whole design: the account exists BEFORE Telegram
 * is involved, so the contact share is matched against a row that is already
 * there (`linkTelegramToAccount`) rather than creating one. A contact that
 * matches nothing is somebody who has not filled the form yet, which is a
 * sentence the bot can say.
 *
 * ── What a signup does NOT get ─────────────────────────────────────────────
 * A joining number, and therefore no referral payout for whoever invited them.
 * That is deliberate and unchanged: the number orders the referral payout queue
 * and is claimed when the Telegram step COMPLETES (`completeOnboarding`). An
 * account that filled a form and never verified must not consume a position
 * ahead of people who did, and must not pay anybody ₹25 for it — otherwise the
 * referral programme is a form that can be submitted in a loop.
 *
 * ── Rate limiting is on the MOUNT, not here ────────────────────────────────
 * server.js puts `loginPaceLimiter`, `authLimiter`, the subnet limiter and
 * `requireCaptcha` in front of both routes, in that order and for the reason
 * stated there: a paced request never reaches the credential check, so it is
 * not a failed attempt and must not consume the failure budget behind it.
 */
import express from 'express';
import { db } from '#db';
import { issueSession, loginHandler, loginTwoFactorHandler, LOGIN_DOOR } from '../../routes.js';
import { hashPassword } from './password.util.js';
import { assertPlayerPassword } from './passwordPolicy.js';
import { generateReferralCode } from '../referral/referral.service.js';
import {
  normalisePhone, isValidMobile, normaliseReferralCode,
} from './signupFields.js';
import { respondError } from '../../shared/httpError.js';
import { assignSigninBot } from './signupVerification.service.js';
import { verificationEndpoint } from './verificationEndpoint.js';
import { redeemResetLink } from './passwordReset.service.js';
import { authenticatePlayer } from './auth.middleware.js';
import { authLimiter, loginPaceLimiter, twoFactorLimiter, signupLimiter } from '../../middleware/security.js';
import { requireCaptcha } from '../../middleware/captcha.js';
import { createSubnetLimiter, globalSurgeBreaker } from '../../middleware/ipDefense.js';

const router = express.Router();

/**
 * A refusal the CALLER caused, carrying its own wording to the caller.
 *
 * `status` on the error is what `respondError` routes on — without it a
 * perfectly good sentence naming the field that is wrong goes to `serverError`,
 * which logs in full and answers with nothing by design, and the player is told
 * the platform broke (§21).
 */
function refuse(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

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
 * token `requireCaptcha` reads. No Aadhaar: KYC was removed 2026-10-02 (owner),
 * and the Telegram contact share is what proves the mobile is theirs.
 */
router.post('/register', ...signupChain('player-register'), async (req, res) => {
  try {
    const { mobile, password, confirmPassword, referralCode } = req.body || {};

    // ── Every refusal NAMES THE FIELD (§25, §32 S14) ───────────────────────
    // A signup form that answers "invalid details" to six different mistakes
    // sends the player back to guess which box is wrong, and the commonest
    // wrong box — the mobile, where they typed +91 as well — looks identical to
    // a correct one.
    if (!isValidMobile(mobile)) {
      throw refuse(
        'Enter your 10-digit mobile number — the one on your Telegram account — without +91.', 400,
      );
    }
    if (String(password ?? '') !== String(confirmPassword ?? '')) {
      throw refuse('The two passwords do not match.', 400);
    }

    const number = normalisePhone(mobile);

    // Throws a 400 naming what is wrong with it. The mobile is passed as
    // context because it is printed on the form directly above this box, so
    // "my own number" is the first thing somebody reaches for.
    assertPlayerPassword(password, { mobile: number }, 'player');

    // ── A courtesy check, not the guarantee ────────────────────────────────
    // The UNIQUE index on `(mobile, account_type)` is what actually prevents a
    // second account; two signups arriving together both pass a read. This
    // exists to produce the RIGHT SENTENCE, and `createAccountFromSignup`
    // returns the same reason when the race is lost.
    if (await db.users.getUserByMobile(number, 'PLAYER')) {
      throw refuse('An account already exists for that mobile number. Log in instead.', 409);
    }

    // ── The referrer is resolved BEFORE the account is written ─────────────
    // A code that matches nobody is reported rather than dropped. The path this
    // replaces normalised the code, looked it up at contact-share time and
    // silently wrote null when it missed: the signup succeeded, the referrer
    // never earned, and nobody could tell afterwards whether the code had been
    // wrong or the payout had failed.
    const code = normaliseReferralCode(referralCode);
    let referrer = null;
    if (code) {
      referrer = await db.users.getUserByReferralCode(code);
      if (!referrer) {
        throw refuse(`No one on Betting Bazaar has the invite code ${code}.`, 400);
      }
    }
    // A non-empty box that normalises to nothing is a typo, not an absence.
    if (!code && String(referralCode ?? '').trim()) {
      throw refuse('That invite code is not a valid code. Leave it blank if you have none.', 400);
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
      // The race the courtesy checks above cannot close. Same sentences, so a
      // player who lost it is told the same thing as one who was simply second.
      const said = {
        mobile_taken: 'An account already exists for that mobile number. Log in instead.',
        duplicate: 'An account already exists for those details.',
      }[created.reason] || 'An account already exists for those details.';
      throw refuse(said, 409);
    }

    // ── Assigned a bot, then signed in ─────────────────────────────────────
    // Signed in deliberately: the very next thing they see is the Telegram gate,
    // and the gate has to know WHO is standing at it to tell them which bot to
    // open and whether their contact has been shared. Sending them back to a
    // login form to find that out is a step that exists only to be completed.
    //
    // The bot assignment is best-effort: an operator who has registered no
    // sign-in bot yet has an account that is created and cannot yet be verified,
    // which the gate REPORTS ("verification is not available right now") rather
    // than blaming on the player.
    await assignSigninBot(created.userId, 'PLAYER').catch((e) => {
      console.error('[signup] could not assign a sign-in bot:', e.message);
    });

    const user = await db.users.getUser(created.userId);
    return issueSession(user, res);
  } catch (err) {
    return respondError(res, err, 'auth/register',
      { message: 'Could not create your account. Please try again.' });
  }
});

/**
 * The player login door.
 *
 * Both legs are `routes.js`'s handlers, mounted here with a DOOR rather than
 * copied — §5's rule, applied to the one function where a copy would be most
 * expensive: a second implementation of "check the password, then decide about
 * the second factor" is where one of the two quietly stops challenging.
 */
router.post('/login', ...credentialChain('player-login'),
  (req, res, next) => { req.loginDoor = LOGIN_DOOR.PLAYER; next(); }, loginHandler);
// The OTP tier, not the password tier: six digits is a 10^6 space and warrants
// its own tighter budget. No captcha — the challenge was already solved on the
// first leg, and Turnstile tokens are single-use, so asking again would refuse
// every second factor on the platform.
router.post('/login/2fa', loginPaceLimiter, twoFactorLimiter,
  (req, res, next) => { req.loginDoor = LOGIN_DOOR.PLAYER; next(); }, loginTwoFactorHandler);

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

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/v1/auth/verification — what the gate shows
// ═══════════════════════════════════════════════════════════════════════════
/**
 * The ONE answer to "may this player use the app yet, and if not, what next?"
 *
 * ── Why it replaced GET /api/telegram/membership ───────────────────────────
 * That endpoint answered half the question — the channel half — and the panel
 * would have had to ask a second one about the contact share and then decide
 * between them. Two sources, one decision, is §5: the two would have disagreed
 * the first time somebody's contact was stood down while their channel status
 * was still `member`, and the screen would have shown "all set" over a gate
 * that was refusing every action.
 *
 * ── The live check is asked for, not assumed ───────────────────────────────
 * The default read is CACHE ONLY. Joining a channel emits a `chat_member`
 * update that writes the cache within about a second, for free — so a poll
 * costs nothing. `?verify=1` is what the "I have joined" button sends, once,
 * and it is floored per user because a button is a button and people press it.
 *
 * That floor matters more than it looks: replacing the channel makes every
 * cached membership stale in one instant, so the prompt appears for every
 * logged-in player at once. Without the floor, a flip would aim the entire
 * active user base at the Bot API in the same few seconds.
 */
/**
 * ONE implementation, three mounts — see `verificationEndpoint`. The player
 * mount is here; the merchant and staff mounts are on their own routers, and
 * they answer the same shape because they ARE the same function.
 */
router.get('/verification', authenticatePlayer, verificationEndpoint((req) => req.user));

// `POST /api/v1/auth/kyc/resubmit` was removed 2026-10-02 with KYC.

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/v1/auth/password/reset — redeem a link the bot sent
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Unauthenticated by necessity: the whole point is that they cannot sign in.
 *
 * The TOKEN is the credential, so this carries the credential chain — the
 * pace, the failure budget, the subnet limiter and the captcha. A 256-bit
 * single-use token is not brute-forceable, and that is not the reason for the
 * limiters: they are what stops this endpoint being used to grind the password
 * POLICY, and what bounds the damage if a token ever leaks into a place that
 * can be scraped.
 *
 * It does NOT sign them in. It answers "done, now log in" and the panel sends
 * them to the login form — see passwordReset.service.js for why that is the
 * point rather than an omission.
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
    // The other two carry the service's own wording, because "too short" and
    // "they do not match" are the only refusals a person can act on.
    throw refuse(result.message
      || 'This reset link is no longer valid. Share your contact with the bot again for a new one.',
      400);
  } catch (err) {
    return respondError(res, err, 'auth/password-reset',
      { message: 'Could not change your password. Please try again.' });
  }
});

export default router;
