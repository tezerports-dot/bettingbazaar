// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/telegram/miniApp.routes.js — what the Telegram Mini App asks.
 *
 * The Mini App is a page of the player panel that Telegram opens inside its own
 * app, for players and merchants (a STAFF account has no Telegram since
 * 2026-10-13, `TELEGRAM_AUDIENCES`). It is where "Continue with Telegram" is
 * answered: the Verify screen (owner, 2026-10-13/14). It has no session. Its
 * credential is `initData`, the string Telegram signs with the one bot's
 * token, verified on every request (miniAppAuth.js) and claimed once by
 * whichever request ACTS on it (repositories/telegram.js). The contact the
 * person shares arrives the same way, signed, and its phone is Telegram's own.
 *
 *   GET  /api/telegram/mini-app?panel=     is there a bot
 *   POST /api/telegram/mini-app/context    what was this opened for (reads only)
 *   POST /api/telegram/mini-app/approve    answer a sign-in (Verify / Deny)
 *   POST /api/telegram/mini-app/continue   Verify, opened from the bot itself
 *
 * What the page was opened FOR is the `start_param` Telegram signed into
 * `initData` (telegramClient.miniAppLink): a sign-in's id (`c…`), or a
 * referral (`ref-<CODE>`), or nothing. The page cannot alter it; the server
 * reads it only from the verified string.
 *
 * Replaces the webhooks (`telegram.routes.js`): no update from Telegram is ever
 * received now, so there is no webhook path, secret or bot conversation.
 */
import express from 'express';
import { db } from '#db';
import { miniAppBot } from './telegramClient.js';
import { verifyInitData, verifyContact } from './miniAppAuth.js';
import { miniAppRefusal } from './miniAppRefusals.js';
import {
  CHALLENGE_PARAM, telegramUnavailable, REDEEM_WINDOW_SECONDS, CHALLENGE_TTL_SECONDS,
  TICKET_TTL_SECONDS, destinationFor, newTicket, newChallengeId,
} from '../identity/telegramChallenge.service.js';
import { normaliseReferralCode } from '../identity/signupFields.js';
import { generateReferralCode } from '../referral/referral.service.js';
import { respondError, refusal } from '../../shared/httpError.js';
import { TELEGRAM_AUDIENCES, MATCH_STRIKES } from '#db/repositories/telegram.js';
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
 * contact, and either find the account of that number or create one (a
 * player, or a merchant application an admin approves).
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

/** What a new account would be, should this approval create one. */
async function signupFor(audience, rawCode = null) {
  if (audience !== 'PLAYER') return { userId: db.users.newUserId() };
  const { referrer } = await referrerFor(rawCode);
  return { userId: db.users.newUserId(), referralCode: generateReferralCode(), referredBy: referrer?.userId ?? null };
}

/** The invite line of the Verify screen. */
async function referralLine(rawCode) {
  if (!rawCode) return undefined;
  const invite = await referrerFor(rawCode);
  return { code: invite.referrer ? invite.code : null, invitedBy: invite.referrer?.username || '', unknown: !invite.referrer };
}

/**
 * GET /api/telegram/mini-app?panel=PLAYER|MERCHANT — public.
 *
 * Whether Telegram is available at all, and the bot's @username — what a
 * sign-in screen needs before it offers "Continue with Telegram", so that no
 * bot is said plainly. Cacheable for a minute: it changes only when an admin
 * saves a bot.
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
        const account = await accountFor(tg.id, ch.audience);
        // The Verify screen: where Verify sends them, whose account it enters,
        // and for a MATCH the three numbers, never which is right.
        start = {
          kind: 'TELEGRAM_LOGIN',
          panel: ch.audience,
          state,
          needsContact: account.isNew,
          expiresAt: ch.expiresAt,
          request: { at: ch.createdAt, ip: ch.requestedIp, device: ch.requestedAgent },
          delivery: ch.delivery,
          choices: ch.delivery === 'MATCH' ? ch.matchChoices : null,
          strikesLeft: ch.delivery === 'MATCH' ? Math.max(0, MATCH_STRIKES - ch.matchStrikes) : null,
          destination: destinationLabel(ch.audience),
          account,
          referral: await referralLine(ch.referralCode),
        };
      }
    } else if (!param || REFERRAL_PARAM.test(param)) {
      // Opened from the bot itself, or by a referral link: no website asked,
      // so Verify creates the sign-in and sends the person to the site
      // (`/mini-app/continue`). "Continue with Telegram" is one action: the
      // account is found, or made.
      const account = await accountFor(tg.id, 'PLAYER');
      start = {
        kind: 'CONTINUE', panel: 'PLAYER', needsContact: account.isNew,
        destination: destinationLabel('PLAYER'), account,
        referral: await referralLine(param ? param.match(REFERRAL_PARAM)[1] : null),
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
 * Acts on the sign-in the page was OPENED for (its signed `start_param`),
 * never on one named in the body. What approving needs is
 * `telegram.answerChallenge`'s; this route proves the strings and maps the
 * answer. A first Verify that makes a merchant application says so: it signs
 * nobody in until an admin approves it.
 */
// Both doors that can MAKE an account carry the account-creation budget, which
// counts only the requests that made one (`res.locals.accountCreated`): a
// returning person signing in is never counted against their address.
const creationBudget = [signupLimiter, createSubnetLimiter('signup', { countOnly: 'successes' })];

router.post('/mini-app/approve', miniAppLimiter, ...creationBudget, async (req, res) => {
  try {
    const { bot, proof } = await proveInitData(req);
    if (!CHALLENGE_PARAM.test(proof.startParam)) throw refuseWith('START_PARAM_INVALID');
    const decision = req.body?.decision;
    if (decision !== 'approve' && decision !== 'deny') {
      throw refusal(400, 'DECISION_INVALID', 'Choose approve or deny.');
    }
    const contact = proveContact(bot, req.body?.contact, { required: false });
    const challenge = await db.telegram.getChallenge(proof.startParam);
    if (!challenge) throw refuseWith('NO_CHALLENGE');

    // ── The number match ─────────────────────────────────────────────────
    // A wrong pick is a strike, committed on its own before anything else is
    // asked (`strike`), and the approval is not attempted: the `initData` is
    // not spent, so the person can pick again, three times in all.
    const pick = Number.isInteger(req.body?.pick) ? req.body.pick : null;
    if (decision === 'approve' && challenge.delivery === 'MATCH') {
      const struck = await db.telegram.strike({ challengeId: challenge.challengeId, pick, telegramUserId: proof.user.id });
      if (struck.wrong) {
        throw struck.denied
          ? refusal(403, 'TOO_MANY_WRONG', 'That was the third wrong number, so this sign-in has been refused. Start again from the website or app.')
          : refusal(400, 'WRONG_NUMBER', `That is not the number on the screen you are signing in on. ${struck.strikesLeft} ${struck.strikesLeft === 1 ? 'try' : 'tries'} left.`);
      }
    }

    // A HANDOFF approval travels as a ticket, opened on the site by this page.
    const handoff = decision === 'approve' && challenge.delivery === 'HANDOFF';
    const ticket = handoff ? { ...newTicket(), ttlSeconds: TICKET_TTL_SECONDS } : null;
    const redirectUrl = handoff ? destinationFor(challenge.audience, ticket.ticket) : null;

    const answer = await db.telegram.answerChallenge({
      challengeId: proof.startParam, decision, telegramUser: proof.user,
      initData: initDataClaim(proof), contact, redeemWindowSeconds: REDEEM_WINDOW_SECONDS,
      pick, ticket,
      signup: await signupFor(challenge.audience, challenge.referralCode),
    });
    if (!answer.ok) throw refuseWith(answer.code);
    res.locals.accountCreated = Boolean(answer.created);
    // A merchant application waits for an admin: no site to open, and the
    // screen that asked is told the same when it next asks.
    const application = answer.approved && answer.created && answer.panel === 'MERCHANT';
    return res.json({
      success: true,
      panel: answer.panel,
      approved: answer.approved, relinked: answer.relinked, verified: answer.verified,
      created: Boolean(answer.created),
      redirectUrl: answer.approved && !application ? redirectUrl : null,
      message: !answer.approved
        ? 'Refused. Nobody was signed in.'
        : application
          ? 'Your merchant application is submitted. An admin will review it; once approved, Continue with Telegram signs you in.'
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
router.post('/mini-app/continue', miniAppLimiter, ...creationBudget, async (req, res) => {
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
      ticket, signup: await signupFor('PLAYER', code),
      open: { audience: 'PLAYER', ttlSeconds: CHALLENGE_TTL_SECONDS, referralCode: normaliseReferralCode(code) },
    });
    if (!answer.ok) throw refuseWith(answer.code);
    res.locals.accountCreated = Boolean(answer.created);
    return res.json({
      success: true, panel: 'PLAYER', created: Boolean(answer.created),
      redirectUrl, message: `Opening ${destinationLabel('PLAYER')}…`,
    });
  } catch (err) {
    return respondError(res, err, 'telegram/mini-app/continue', { message: 'Could not sign you in. Please try again.' });
  }
});

export default router;
