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
import { hashAadhaar, hashAadhaarCandidates } from './aadhaarHash.util.js';
import { encryptField } from './fieldCrypto.util.js';
import { generateReferralCode } from '../referral/referral.service.js';
import {
  normalisePhone, isValidMobile, isValidAadhaar, normaliseAadhaar, normaliseReferralCode,
} from './signupFields.js';
import { respondError } from '../../shared/httpError.js';
import { assignSigninBot, verificationStateFor } from './signupVerification.service.js';
import { resubmitAadhaar, MAX_KYC_SUBMISSIONS } from './aadhaarResubmission.service.js';
import { authenticate } from './auth.middleware.js';
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
 * Body: aadhaar, mobile, password, confirmPassword, referralCode?, and the
 * captcha token `requireCaptcha` reads.
 */
router.post('/register', ...signupChain('player-register'), async (req, res) => {
  try {
    const { aadhaar, mobile, password, confirmPassword, referralCode } = req.body || {};

    // ── Every refusal NAMES THE FIELD (§25, §32 S14) ───────────────────────
    // A signup form that answers "invalid details" to six different mistakes
    // sends the player back to guess which box is wrong, and the commonest
    // wrong box — the Aadhaar-linked mobile, where they typed +91 as well —
    // looks identical to a correct one.
    if (!isValidAadhaar(aadhaar)) {
      throw refuse('Enter your 12-digit Aadhaar number — digits only.', 400);
    }
    if (!isValidMobile(mobile)) {
      throw refuse(
        'Enter the 10-digit mobile number linked to that Aadhaar, without +91.', 400,
      );
    }
    if (String(password ?? '') !== String(confirmPassword ?? '')) {
      throw refuse('The two passwords do not match.', 400);
    }

    const number = normalisePhone(mobile);
    const digits = normaliseAadhaar(aadhaar);

    // Throws a 400 naming what is wrong with it. The mobile is passed as
    // context because it is printed on the form directly above this box, so
    // "my own number" is the first thing somebody reaches for.
    assertPlayerPassword(password, { mobile: number }, 'player');

    // ── Courtesy checks, not the guarantee ─────────────────────────────────
    // The UNIQUE indexes on `users.mobile` and `kyc_verifications.aadhaar_hash`
    // are what actually prevent a second account; two signups arriving together
    // both pass a read. These exist to produce the RIGHT SENTENCE, and
    // `createAccountFromSignup` reads the violated constraint by name and
    // returns the same two reasons when the race is lost.
    if (await db.users.getUserByMobile(number)) {
      throw refuse('An account already exists for that mobile number. Log in instead.', 409);
    }
    // Checked across every candidate hash: the HMAC secret is rotatable, so a
    // number registered under a retired secret must still read as taken.
    if (await db.identity.findRegisteredAadhaar(hashAadhaarCandidates(digits))) {
      throw refuse(
        'That Aadhaar is already registered. Each Aadhaar can hold one account.', 409,
      );
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
      aadhaarHash: hashAadhaar(digits),
      aadhaarEncrypted: encryptField(digits),
      aadhaarLast4: digits.slice(-4),
      referralCode: generateReferralCode(),
      referredBy: referrer?.userId ?? null,
    });

    if (!created.ok) {
      // The race the courtesy checks above cannot close. Same sentences, so a
      // player who lost it is told the same thing as one who was simply second.
      const said = {
        mobile_taken: 'An account already exists for that mobile number. Log in instead.',
        aadhaar_taken: 'That Aadhaar is already registered. Each Aadhaar can hold one account.',
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
    await assignSigninBot(created.userId).catch((e) => {
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
const lastLiveCheck = new Map();  // userId -> epoch ms
const LIVE_CHECK_FLOOR_MS = 20_000;

function mayCheckLive(userId) {
  const now = Date.now();
  // Bounded: a large logged-in population must not be able to grow this without
  // limit. Clearing is safe — the only cost is one extra live check each.
  if (lastLiveCheck.size > 50_000) lastLiveCheck.clear();
  const last = lastLiveCheck.get(String(userId)) || 0;
  if (now - last < LIVE_CHECK_FLOOR_MS) return false;
  lastLiveCheck.set(String(userId), now);
  return true;
}

router.get('/verification', authenticate, async (req, res) => {
  try {
    const wantsLive = req.query.verify === '1';
    const refresh = wantsLive && mayCheckLive(req.user.userId);
    const state = await verificationStateFor(req.user, { refresh });
    return res.json({
      success: true,
      ...state,
      // True when a live check was ASKED for and declined by the floor, so the
      // screen can say "checking again shortly" instead of "you have not
      // joined" — which is a different sentence and, for somebody who HAS just
      // joined, the wrong one.
      throttled: wantsLive && !refresh,
    });
  } catch (err) {
    return respondError(res, err, 'auth/verification',
      { message: 'Could not check your verification right now. Please try again shortly.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/v1/auth/kyc/resubmit — a REJECTED player corrects their Aadhaar
// ═══════════════════════════════════════════════════════════════════════════
/**
 * On the panel, not in a chat.
 *
 * This used to be a message to the bot, and it had to be: the account was born
 * in a conversation, so a correction arrived in one. Now the player is logged
 * in and the screen that told them they were rejected is the screen that takes
 * the new number — which is also the only place that can show them how many
 * attempts they have left.
 *
 * Every refusal is named. `already_registered` is deliberately specific and
 * deliberately BOUNDED by the attempt cap: it is an enumeration oracle if it
 * can be repeated freely, and vague if it cannot be repeated at all, and
 * somebody who genuinely mistyped needs to know the difference between "wrong
 * number" and "that one belongs to somebody else".
 */
router.post('/kyc/resubmit', authenticate, async (req, res) => {
  try {
    const result = await resubmitAadhaar({ userId: req.user.userId, aadhaar: req.body?.aadhaar });
    if (result.ok) {
      return res.json({
        success: true,
        last4: result.last4,
        message: `Received — Aadhaar ending ${result.last4}. It is queued for verification, `
          + 'which is done in batches, so it is not instant. There is nothing more for you to do.',
      });
    }
    const said = {
      not_rejected: 'Your Aadhaar is not awaiting a correction.',
      too_many_attempts: `You have used all ${MAX_KYC_SUBMISSIONS} attempts. Please contact support.`,
      invalid_format: 'That does not look like a 12-digit Aadhaar number. Send just the 12 digits.',
      already_registered: 'That Aadhaar is already registered to another account. '
        + 'Each Aadhaar can hold one account.',
      state_refused: 'We could not accept that right now. Please try again shortly.',
      no_user: 'Account not found.',
    }[result.reason] || 'We could not accept that Aadhaar number. Please check it and try again.';
    throw refuse(said, result.reason === 'too_many_attempts' ? 429 : 400);
  } catch (err) {
    return respondError(res, err, 'auth/kyc-resubmit',
      { message: 'Could not submit that Aadhaar number. Please try again.' });
  }
});

export default router;
