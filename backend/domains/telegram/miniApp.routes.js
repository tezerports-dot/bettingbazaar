// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/telegram/miniApp.routes.js — what the Telegram Mini App asks.
 *
 * The Mini App is a page of the player panel that Telegram opens inside its own
 * app, for players and merchants (Step 3, owner 2026-10-07; a STAFF account has
 * no Telegram since 2026-10-13, `TELEGRAM_AUDIENCES`). It has no
 * session. Its credential is `initData`, the string Telegram signs with the one
 * bot's token, verified on every request (miniAppAuth.js) and claimed once by
 * whichever request ACTS on it (repositories/telegram.js). The contact the
 * person shares arrives the same way, signed, and its phone is Telegram's own.
 *
 *   GET  /api/telegram/mini-app?panel=     is there a bot; the reset link
 *   POST /api/telegram/mini-app/context    what was this opened for (reads only)
 *   POST /api/telegram/mini-app/approve    answer a challenge (Verify / Deny)
 *   POST /api/telegram/mini-app/continue   Verify, opened from the bot itself
 *   POST /api/telegram/mini-app/signup     a player signs up inside Telegram
 *   POST /api/telegram/mini-app/password-reset  forgot password, by contact,
 *                                          set right there for every panel
 *
 * What the page was opened FOR is the `start_param` Telegram signed into
 * `initData` (telegramClient.miniAppLink): a challenge id (`c…`), a reset for a
 * panel (`reset-PLAYER|MERCHANT`), or a referral (`ref-<CODE>`). The page
 * cannot alter it; the server reads it only from the verified string.
 *
 * Replaces the webhooks (`telegram.routes.js`): no update from Telegram is ever
 * received now, so there is no webhook path, secret or bot conversation.
 */
import express from 'express';
import { db } from '#db';
import { miniAppBot, miniAppLink } from './telegramClient.js';
import { verifyInitData, verifyContact } from './miniAppAuth.js';
import { miniAppRefusal } from './miniAppRefusals.js';
import {
  CHALLENGE_PARAM, telegramUnavailable, REDEEM_WINDOW_SECONDS, CHALLENGE_TTL_SECONDS,
  TICKET_TTL_SECONDS, destinationFor, newTicket, newChallengeId,
} from '../identity/telegramChallenge.service.js';
import { resetFromMiniApp } from '../identity/passwordReset.service.js';
import { hashPassword } from '../identity/password.util.js';
import { assertPlayerPassword } from '../identity/passwordPolicy.js';
import { isValidMobile, normaliseReferralCode } from '../identity/signupFields.js';
import { generateReferralCode } from '../referral/referral.service.js';
import { issueSession } from '../../routes.js';
import { respondError, refusal } from '../../shared/httpError.js';
import { TELEGRAM_AUDIENCES } from '#db/repositories/telegram.js';
import { miniAppLimiter, signupLimiter } from '../../middleware/security.js';
import { createSubnetLimiter } from '../../middleware/ipDefense.js';

const router = express.Router();

/** A refusal from the table in miniAppRefusals.js, thrown. */
function refuseWith(reasonOrCode, opts) {
  const r = miniAppRefusal(reasonOrCode, opts);
  return refusal(r.status, r.code, r.message);
}

/** The bot and the proved `initData`, or a refusal. */
async function proveInitData(req) {
  const bot = await miniAppBot();
  if (!bot) throw telegramUnavailable();
  const proof = verifyInitData(req.body?.initData, { botToken: bot.token });
  if (!proof.ok) throw refuseWith(proof.reason);
  return { bot, proof };
}

/** The shared contact, proved, or a refusal (null when none was sent and none is needed). */
function proveContact(bot, raw, { required }) {
  if (!raw) {
    if (required) throw refuseWith('CONTACT_REQUIRED');
    return null;
  }
  const c = verifyContact(raw, { botToken: bot.token });
  if (!c.ok) throw refuseWith(c.reason, { contact: true });
  return { userId: c.contact.userId, phone: c.contact.phone, hash: c.hash, expiresAt: c.expiresAt };
}

const initDataClaim = (proof) => ({ hash: proof.hash, expiresAt: proof.expiresAt });

/** "••••••3210": enough to recognise one's own number, never the number. */
const mobileHint = (mobile) => (mobile ? `••••••${String(mobile).slice(-4)}` : '');

// No STAFF: a Telegram password reset for a staff mobile would be a way into a
// staff account around its authenticator (owner, 2026-10-13).
const RESET_PARAM = /^reset-(PLAYER|MERCHANT)$/;
const REFERRAL_PARAM = /^ref-([A-Za-z0-9_-]{4,32})$/;

/** "bettingbazaar.com" or "bettingbazaar.com/merchant": the sentence above Verify. */
function destinationLabel(audience) {
  const url = new URL(destinationFor(audience));
  return `${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * The account Verify will enter, named so the person can see it is theirs
 * (login-CSRF: a sign-in somebody else started enters the account of the
 * Telegram that presses Verify, and this says which). `isNew` when this
 * Telegram account has none on that panel yet: Verify will ask for the
 * contact, and either find the account of that number or create one.
 */
async function accountFor(tgId, audience) {
  const link = await db.telegram.getLinkByTelegramId(tgId, audience);
  if (!link) return { panel: audience, isNew: true, mobileHint: '' };
  const user = await db.users.getUser(link.userId);
  return { panel: audience, isNew: false, mobileHint: mobileHint(user?.mobile) };
}

/** A referral code to the referrer it names; an unknown code is reported, never used. */
async function referrerFor(rawCode) {
  const code = normaliseReferralCode(rawCode);
  if (!code) return { code: null, referrer: null };
  const referrer = await db.users.getUserByReferralCode(code);
  return { code, referrer };
}

/** What a new player account would be, should this approval create one. */
async function signupFor(rawCode) {
  const { referrer } = await referrerFor(rawCode);
  return { userId: db.users.newUserId(), referralCode: generateReferralCode(), referredBy: referrer?.userId ?? null };
}

/**
 * GET /api/telegram/mini-app?panel=PLAYER|MERCHANT — public.
 *
 * Whether Telegram is available at all, the bot's @username, and the link that
 * opens "Forgot password" for that panel — what a sign-in screen needs to offer
 * the button. Cacheable for a minute: it changes only when an admin saves a bot.
 */
router.get('/mini-app', async (req, res) => {
  try {
    const panel = String(req.query.panel || 'PLAYER').toUpperCase();
    if (!TELEGRAM_AUDIENCES.includes(panel)) {
      throw refusal(400, 'PANEL_INVALID', `panel must be one of ${TELEGRAM_AUDIENCES.join(', ')}.`);
    }
    const bot = await miniAppBot();
    res.set('Cache-Control', 'public, max-age=60');
    return res.json({
      success: true,
      available: Boolean(bot),
      botUsername: bot?.botUsername || '',
      resetUrl: bot ? miniAppLink(bot, `reset-${panel}`) : null,
    });
  } catch (err) {
    return respondError(res, err, 'telegram/mini-app', { message: 'Could not read the Telegram setup.' });
  }
});

/**
 * POST /api/telegram/mini-app/context `{ initData }` — what the page shows.
 *
 * READS ONLY: the `initData` is not claimed here, so the page can ask this,
 * show the person what they are approving, and then act with the same string.
 */
router.post('/mini-app/context', miniAppLimiter, async (req, res) => {
  try {
    const { proof } = await proveInitData(req);
    const tg = proof.user;
    const param = proof.startParam;
    let start = { kind: 'NONE', panel: null, needsContact: false };

    if (CHALLENGE_PARAM.test(param)) {
      const ch = await db.telegram.getChallenge(param);
      if (!ch) {
        start = { kind: 'UNKNOWN', panel: null, needsContact: false, state: 'EXPIRED' };
      } else {
        // On the database clock: an unanswered or unredeemed challenge past its
        // window is EXPIRED whatever its row says.
        const state = ch.live || ch.status === 'DENIED' || ch.status === 'REDEEMED' ? ch.status : 'EXPIRED';
        let needsContact = ch.purpose === 'VERIFY' || ch.purpose === 'RELINK';
        let account = null;
        if (ch.userId) {
          account = await db.users.getUser(ch.userId);
          if (!needsContact) {
            const link = await db.telegram.getLinkByUserId(ch.userId);
            needsContact = !link || String(link.telegramUserId) !== String(tg.id);
          }
        } else {
          needsContact = !(await db.telegram.getLinkByTelegramId(tg.id, ch.audience));
        }
        start = {
          kind: ch.purpose,
          panel: ch.audience,
          state,
          needsContact,
          expiresAt: ch.expiresAt,
          mobileHint: mobileHint(account?.mobile),
          request: { at: ch.createdAt, ip: ch.requestedIp, device: ch.requestedAgent },
        };
        if (ch.purpose === 'TELEGRAM_LOGIN') {
          // The Verify screen: where Verify sends them, whose account it
          // enters, and for a MATCH the three numbers, never which is right.
          const invite = ch.referralCode ? await referrerFor(ch.referralCode) : null;
          start = {
            ...start,
            delivery: ch.delivery,
            choices: ch.delivery === 'MATCH' ? ch.matchChoices : null,
            strikesLeft: ch.delivery === 'MATCH' ? Math.max(0, 3 - ch.matchStrikes) : null,
            destination: destinationLabel(ch.audience),
            account: await accountFor(tg.id, ch.audience),
            referral: invite ? { code: invite.referrer ? invite.code : null, invitedBy: invite.referrer?.username || '', unknown: !invite.referrer } : undefined,
          };
        }
      }
    } else if (RESET_PARAM.test(param)) {
      start = { kind: 'RESET', panel: param.match(RESET_PARAM)[1], needsContact: true };
    } else if (!param || REFERRAL_PARAM.test(param)) {
      // Opened from the bot itself, or by a referral link: no website asked,
      // so Verify creates the sign-in and sends the person to the site
      // (`/mini-app/continue`). "Continue with Telegram" is one action: the
      // account is found, or made.
      const invite = param ? await referrerFor(param.match(REFERRAL_PARAM)[1]) : null;
      const account = await accountFor(tg.id, 'PLAYER');
      start = {
        kind: 'CONTINUE', panel: 'PLAYER', needsContact: account.isNew,
        destination: destinationLabel('PLAYER'), account,
        referral: invite ? { code: invite.referrer ? invite.code : null, invitedBy: invite.referrer?.username || '', unknown: !invite.referrer } : undefined,
      };
    } else {
      start = { kind: 'UNKNOWN', panel: null, needsContact: false };
    }

    const accounts = (await db.telegram.listLinksForTelegramUser(tg.id))
      .map((a) => ({ panel: a.audience, mobileHint: mobileHint(a.mobile) }));

    return res.json({
      success: true,
      telegramUser: { id: tg.id, username: tg.username, firstName: tg.firstName },
      start,
      accounts,
    });
  } catch (err) {
    return respondError(res, err, 'telegram/mini-app/context', { message: 'Could not read this request.' });
  }
});

/**
 * POST /api/telegram/mini-app/approve `{ initData, contact?, decision }`.
 *
 * Acts on the challenge the page was OPENED for (its signed `start_param`),
 * never on one named in the body. What each purpose needs is
 * `telegram.answerChallenge`'s; this route proves the strings and maps the
 * answer.
 */
router.post('/mini-app/approve', miniAppLimiter, async (req, res) => {
  try {
    const { bot, proof } = await proveInitData(req);
    if (!CHALLENGE_PARAM.test(proof.startParam)) throw refuseWith('START_PARAM_INVALID');
    const decision = req.body?.decision;
    if (decision !== 'approve' && decision !== 'deny') {
      throw refusal(400, 'DECISION_INVALID', 'Choose approve or deny.');
    }
    const contact = proveContact(bot, req.body?.contact, { required: false });
    const challenge = await db.telegram.getChallenge(proof.startParam);
    const signIn = challenge?.purpose === 'TELEGRAM_LOGIN';

    // ── The number match ─────────────────────────────────────────────────
    // A wrong pick is a strike, committed on its own before anything else is
    // asked (`strike`), and the approval is not attempted: the `initData` is
    // not spent, so the person can pick again, three times in all.
    const pick = Number.isInteger(req.body?.pick) ? req.body.pick : null;
    if (decision === 'approve' && signIn && challenge.delivery === 'MATCH') {
      const struck = await db.telegram.strike({ challengeId: challenge.challengeId, pick, telegramUserId: proof.user.id });
      if (struck.wrong) {
        throw struck.denied
          ? refusal(403, 'TOO_MANY_WRONG', 'That was the third wrong number, so this sign-in has been refused. Start again from the website or app.')
          : refusal(400, 'WRONG_NUMBER', `That is not the number on the screen you are signing in on. ${struck.strikesLeft} ${struck.strikesLeft === 1 ? 'try' : 'tries'} left.`);
      }
    }

    // A HANDOFF approval travels as a ticket, opened on the site by this page.
    const handoff = decision === 'approve' && signIn && challenge.delivery === 'HANDOFF';
    const ticket = handoff ? { ...newTicket(), ttlSeconds: TICKET_TTL_SECONDS } : null;
    const redirectUrl = handoff ? destinationFor(challenge.audience, ticket.ticket) : null;

    const answer = await db.telegram.answerChallenge({
      challengeId: proof.startParam, decision, telegramUser: proof.user,
      initData: initDataClaim(proof), contact, redeemWindowSeconds: REDEEM_WINDOW_SECONDS,
      pick, ticket,
      signup: signIn && challenge.audience === 'PLAYER' ? await signupFor(challenge.referralCode) : null,
    });
    if (!answer.ok) throw refuseWith(answer.code);
    return res.json({
      success: true,
      kind: answer.kind, panel: answer.panel,
      approved: answer.approved, relinked: answer.relinked, verified: answer.verified,
      created: Boolean(answer.created),
      redirectUrl: answer.approved ? redirectUrl : null,
      message: !answer.approved
        ? 'Refused. Nobody was signed in.'
        : redirectUrl
          ? `Opening ${destinationLabel(challenge.audience)}…`
          : 'Done. Go back to the website or app — it will continue on its own.',
    });
  } catch (err) {
    return respondError(res, err, 'telegram/mini-app/approve', { message: 'Could not record your answer. Please try again.' });
  }
});

/**
 * POST /api/telegram/mini-app/continue `{ initData, contact? }` — Verify, on a
 * Mini App opened from the bot itself or by a referral link (`ref-<CODE>`).
 *
 * No website asked, so nobody is polling: the sign-in is created HANDOFF and
 * approved in one transaction, and the answer is the site's address with a
 * one-time ticket in its fragment, which the page opens (`openLink`). The
 * session lands on this device. A Telegram account with no player account yet
 * shares its contact: the account of that number is linked, or one is made.
 */
router.post('/mini-app/continue', miniAppLimiter, signupLimiter,
  createSubnetLimiter('signup', { countOnly: 'successes' }), async (req, res) => {
  try {
    const { bot, proof } = await proveInitData(req);
    if (proof.startParam && !REFERRAL_PARAM.test(proof.startParam)) throw refuseWith('START_PARAM_INVALID');
    const contact = proveContact(bot, req.body?.contact, { required: false });
    const code = proof.startParam ? proof.startParam.match(REFERRAL_PARAM)[1] : null;
    const ticket = { ...newTicket(), ttlSeconds: TICKET_TTL_SECONDS };
    const redirectUrl = destinationFor('PLAYER', ticket.ticket);

    const answer = await db.telegram.answerChallenge({
      challengeId: newChallengeId(), decision: 'approve', telegramUser: proof.user,
      initData: initDataClaim(proof), contact, redeemWindowSeconds: REDEEM_WINDOW_SECONDS,
      ticket, signup: await signupFor(code),
      open: { audience: 'PLAYER', ttlSeconds: CHALLENGE_TTL_SECONDS.TELEGRAM_LOGIN, referralCode: normaliseReferralCode(code) },
    });
    if (!answer.ok) throw refuseWith(answer.code);
    return res.json({
      success: true, panel: 'PLAYER', created: Boolean(answer.created),
      redirectUrl, message: `Opening ${destinationLabel('PLAYER')}…`,
    });
  } catch (err) {
    return respondError(res, err, 'telegram/mini-app/continue', { message: 'Could not sign you in. Please try again.' });
  }
});

/**
 * POST /api/telegram/mini-app/signup `{ initData, contact, password,
 * confirmPassword, referralCode? }` — a player signs up inside Telegram.
 *
 * A referral link opens the Mini App with `ref-<CODE>` (routes/referralRedirect),
 * and that code is the one used: locked, as on the website form. The mobile is
 * Telegram's own, from the signed contact, so the account is created verified.
 * No captcha: the signed, single-use contact of a real Telegram account is a
 * stronger proof of a person than one (owner reading, 2026-10-07).
 */
router.post('/mini-app/signup', miniAppLimiter, signupLimiter,
  createSubnetLimiter('signup', { countOnly: 'successes' }), async (req, res) => {
  try {
    const { bot, proof } = await proveInitData(req);
    const contact = proveContact(bot, req.body?.contact, { required: true });
    if (String(contact.userId) !== String(proof.user.id)) throw refuseWith('CONTACT_NOT_OWN');
    if (!isValidMobile(contact.phone)) {
      throw refusal(400, 'MOBILE_INVALID',
        'Your Telegram account is not on an Indian mobile number, which this platform needs.');
    }
    const { password, confirmPassword } = req.body || {};
    if (String(password ?? '') !== String(confirmPassword ?? '')) {
      throw refusal(400, 'PASSWORDS_DIFFER', 'The two passwords do not match.');
    }
    assertPlayerPassword(password, { mobile: contact.phone }, 'player');

    // The link's code wins, and cannot be swapped by the page.
    const fromLink = REFERRAL_PARAM.test(proof.startParam) ? proof.startParam.match(REFERRAL_PARAM)[1] : null;
    const typed = fromLink ?? req.body?.referralCode;
    const code = normaliseReferralCode(typed);
    if (!code && String(typed ?? '').trim()) {
      throw refusal(400, 'INVITE_CODE_INVALID', 'That invite code is not a valid code. Leave it blank if you have none.');
    }
    const referrer = code ? await db.users.getUserByReferralCode(code) : null;
    if (code && !referrer) throw refusal(400, 'INVITE_CODE_UNKNOWN', `No one on Betting Bazaar has the invite code ${code}.`);

    const created = await db.telegram.signUpVerifiedPlayer({
      userId: db.users.newUserId(),
      username: `player${contact.phone.slice(-4)}`,
      passwordHash: await hashPassword(password),
      referralCode: generateReferralCode(),
      referredBy: referrer?.userId ?? null,
      telegramUser: proof.user, initData: initDataClaim(proof), contact,
    });
    if (!created.ok) throw refuseWith(created.code);

    const user = await db.users.getUser(created.userId);
    return issueSession(user, res, { amr: ['pwd', 'tg'] });
  } catch (err) {
    return respondError(res, err, 'telegram/mini-app/signup', { message: 'Could not create your account. Please try again.' });
  }
});

/**
 * POST /api/telegram/mini-app/password-reset
 * `{ initData, contact, panel?, password, confirmPassword }`.
 *
 * The panel is the one the page was opened for (`reset-<PANEL>`), or the body's
 * when the page was opened plainly. The new password is set right here, for
 * every panel (2026-10-08), in the transaction that spends the proof
 * (`passwordReset.service.js` says why there is no link any more). It is
 * checked against the account's floor BEFORE anything is spent: the `initData`
 * is single-use, and a refused password must not cost the person the page.
 */
router.post('/mini-app/password-reset', miniAppLimiter, async (req, res) => {
  try {
    const { bot, proof } = await proveInitData(req);
    const fromLink = RESET_PARAM.test(proof.startParam) ? proof.startParam.match(RESET_PARAM)[1] : null;
    const panel = fromLink ?? String(req.body?.panel || '').toUpperCase();
    if (!TELEGRAM_AUDIENCES.includes(panel)) {
      throw refusal(400, 'PANEL_INVALID', 'Choose which account to reset: player or merchant.');
    }
    if (!req.body?.password) throw refusal(400, 'PASSWORD_REQUIRED', 'Type the new password, twice.');
    const contact = proveContact(bot, req.body?.contact, { required: true });

    const result = await resetFromMiniApp({
      panel, telegramUser: proof.user, initData: initDataClaim(proof), contact,
      password: req.body.password, confirmPassword: req.body.confirmPassword,
    });
    if (!result.ok) throw refuseWith(result.code);
    return res.json({
      success: true, panel, changed: true,
      message: 'Your password has been changed, and every device that was signed in has been signed out. Sign in with the new password now.',
    });
  } catch (err) {
    return respondError(res, err, 'telegram/mini-app/password-reset', { message: 'Could not reset the password. Please try again.' });
  }
});

export default router;
