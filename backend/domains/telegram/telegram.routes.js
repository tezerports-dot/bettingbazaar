// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/telegram/telegram.routes.js — the bot webhook and the session
 * exchange.
 *
 * ── The webhook is an unauthenticated public endpoint ───────────────────────
 * It carries no session, because the caller is Telegram, not a logged-in user.
 * The ONLY thing separating it from the open internet is the secret token
 * Telegram echoes in `X-Telegram-Bot-Api-Secret-Token`, so that check is done
 * first, in constant time, and a mismatch is refused before any body is parsed
 * or any database read happens. Anyone who could forge an update here could
 * create accounts and complete other people's onboarding.
 *
 * ── Why it always answers 200 ───────────────────────────────────────────────
 * Telegram retries an update it considers failed, and retries the SAME update,
 * which for a handler that half-succeeded means doing the ambiguous part again.
 * Once an update is authenticated it is acknowledged immediately and processed
 * for effect; genuine failures are logged and surfaced through metrics rather
 * than through a status code that makes Telegram replay them.
 */
import express from 'express';
import { db } from '#db';
import crypto from 'crypto';
import { TelegramIdentity, TelegramPendingLink } from './telegram.model.js';
import { activeConfig, sendMessage, liveBot } from './telegramClient.js';
import { applyMemberUpdate, isJoinedStatus, joinPrompt, membershipFor } from './telegramMembership.js';
import { authenticate } from '../identity/auth.middleware.js';
import {
  beginOnboarding, submitAadhaar, completeContactShare, completeOnboarding, isValidAadhaar,
  resubmitAadhaar, MAX_KYC_SUBMISSIONS,
} from './telegramOnboarding.service.js';
import { issueLoginToken } from './telegramLogin.service.js';
import { sendTemplate } from './telegramTemplates.service.js';

const router = express.Router();

/** Constant-time compare — a secret checked with === leaks its prefix. */
function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Copy the bot sends lives in telegramTemplates.service.js, where an admin can
 * edit it without a deploy — the shipped wording is the fallback there, so this
 * module no longer holds any player-facing sentence that is subject to change.
 *
 * The short operational replies below stay inline on purpose: they answer a
 * specific malformed input ("that is not 12 digits"), they are not the first
 * thing anyone reads, and making every one of them a row an operator can blank
 * out adds ways to break the conversation without adding anything worth having.
 */
const contactKeyboard = {
  keyboard: [[{ text: '📱 Share my contact', request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/telegram/webhook — every update from the primary bot
// ═══════════════════════════════════════════════════════════════════════════
/**
 * The webhook needs a BOT. It does not need a channel.
 *
 * `activeConfig()` returns null when no channel generation is active, and this
 * handler used to refuse everything on that basis — which made a perfectly
 * good sign-in bot look completely dead. That is not a hypothetical state: it
 * is exactly where a launch sits between registering the bot (which registers
 * its webhook with Telegram, so updates start arriving immediately) and setting
 * the channel. Telegram would deliver, we would answer 503 to all of it, and
 * nothing anywhere would say why.
 *
 * It is also inconsistent with the rest of the system, which already treats a
 * missing channel as "membership is not enforced yet" rather than as an outage
 * — see requireChannelMembership's `unconfigured` branch.
 *
 * So the bot is resolved on its own terms. With no channel there is no
 * `channelId`, which makes `handleChatMember` ignore every membership event —
 * correct, because there is no channel to be a member of.
 */
async function webhookContext() {
  const cfg = await activeConfig();
  if (cfg?.webhookSecret) return cfg;

  const bot = await liveBot('signin');
  if (!bot?.webhookSecret) return null;

  console.warn('[telegram] a sign-in bot is live but no channel generation is active — '
    + 'signup will run without the channel step until one is set in the admin panel');
  return {
    generation: 0,
    botUsername: bot.username,
    botToken: bot.token,
    webhookSecret: bot.webhookSecret,
    channelId: null,
    channelUsername: '',
    channelInviteLink: '',
  };
}

router.post('/webhook', async (req, res) => {
  const cfg = await webhookContext();
  if (!cfg) return res.status(503).json({ ok: false });

  if (!secretMatches(req.get('X-Telegram-Bot-Api-Secret-Token'), cfg.webhookSecret)) {
    // Deliberately terse: an attacker probing for the endpoint learns nothing
    // about whether the path or the secret was wrong.
    return res.status(401).json({ ok: false });
  }

  // Acknowledge before doing the work, so a slow database cannot make Telegram
  // resend an update that is already being handled.
  res.json({ ok: true });

  try {
    await handleUpdate(req.body, cfg);
  } catch (err) {
    console.error('[telegram] update handling failed:', err.message);
  }
});

async function handleUpdate(update, cfg) {
  if (update?.message) return handleMessage(update.message, cfg);
  // `chat_member` is the event that keeps membership current without polling.
  if (update?.chat_member) return handleChatMember(update.chat_member, cfg);
  return undefined;
}

// ── Messages: /start, an Aadhaar number, a shared contact ──────────────────

async function handleMessage(message, cfg) {
  const from = message.from;
  if (!from || from.is_bot) return;
  const telegramUserId = String(from.id);
  const chatId = message.chat.id;

  // A shared contact ends the signup — check it before any text handling.
  if (message.contact) {
    return handleContact({ message, telegramUserId, chatId, cfg });
  }

  const text = String(message.text || '').trim();

  if (text.startsWith('/start')) {
    // Referral attribution rides in the deep link: t.me/<bot>?start=<code>
    //
    // Telegram delivers the payload as the argument to /start the moment the
    // conversation opens, which is why a referral link needs no code entry and
    // no instructions: the referred player taps the link and the bot already
    // knows who sent them. This is the ONLY message that carries it.
    const payload = text.split(/\s+/)[1] || null;
    const begun = await beginOnboarding({
      telegramUserId,
      username: from.username,
      firstName: from.first_name,
      referralCode: payload,
    });

    if (begun.alreadyLinked) {
      // A rejected player is not asking to log in — they are stuck. Handing
      // them a session would drop them into an app that refuses every action
      // with "your Aadhaar could not be verified" and offers nothing to do
      // about it. The useful reply is to take a corrected number.
      if (begun.canReapply) {
        return sendMessage(chatId,
          'Your Aadhaar could not be verified.\n\n'
          + 'If you mistyped it, send the correct <b>12-digit Aadhaar number</b> now and '
          + 'we will check it again.\n\n'
          + 'It must be the Aadhaar linked to this Telegram account\u2019s mobile number.');
      }
      if (begun.kycStatus === 'REJECTED') {
        return sendMessage(chatId,
          'Your Aadhaar could not be verified, and you have used all '
          + `${MAX_KYC_SUBMISSIONS} attempts.\n\nPlease contact support — they can help sort this out.`);
      }
      // An existing player pressing /start is asking to log in.
      return sendLoginLink({ chatId, telegramUserId, userId: begun.userId, cfg });
    }
    return sendTemplate({
      chatId,
      key: 'welcome',
      vars: { firstName: from.first_name || '', botUsername: cfg.botUsername || '' },
    });
  }

  // Anything else, while a signup is open, is treated as the Aadhaar attempt.
  const pending = await TelegramPendingLink.findOne({ telegramUserId }).select('step').lean();
  if (!pending) {
    // No signup in progress. If this is a REJECTED player sending a corrected
    // Aadhaar, that is the reapply path — their signup conversation ended long
    // ago, which is exactly why sending a new number used to do nothing at all.
    if (isValidAadhaar(text)) {
      const linked = await TelegramIdentity.findOne({ telegramUserId }).select('userId').lean();
      if (linked) return handleReapply({ chatId, userId: linked.userId, aadhaar: text });
    }
    return sendMessage(chatId, 'Send /start to begin.');
  }

  if (pending.step === 'AWAITING_AADHAAR') {
    if (!isValidAadhaar(text)) {
      return sendMessage(chatId, 'That does not look like a 12-digit Aadhaar number. Please send just the 12 digits.');
    }
    const result = await submitAadhaar({ telegramUserId, aadhaar: text });
    if (!result.ok) {
      if (result.reason === 'already_registered') {
        return sendMessage(chatId,
          'This Aadhaar is already registered on Betting Bazaar. '
          + 'Each Aadhaar can hold one account. If you have lost access, use our recovery bot.');
      }
      return sendMessage(chatId, 'We could not accept that Aadhaar number. Please check it and try again.');
    }
    return sendTemplate({
      chatId, key: 'ask_contact', vars: { firstName: from.first_name || '' },
      extra: { reply_markup: contactKeyboard },
    });
  }

  if (pending.step === 'AWAITING_CONTACT') {
    return sendTemplate({
      chatId, key: 'ask_contact', vars: { firstName: from.first_name || '' },
      extra: { reply_markup: contactKeyboard },
    });
  }

  // AWAITING_CHANNEL: the account exists and the only thing left is the join.
  // The invite link is fetched rather than assumed, because the channel is
  // replaceable and a player sitting at this step through a replacement must be
  // sent to the CURRENT one. Without the link this reply was a dead end — an
  // instruction with nothing to act on.
  const prompt = await joinPrompt();
  return sendMessage(chatId,
    'Almost done — join our official channel to finish signing up'
    + `${prompt?.inviteLink ? `:\n\n${prompt.inviteLink}` : '.'}`
    + '\n\nI will send your login link the moment you have joined.');
}

async function handleContact({ message, telegramUserId, chatId, cfg }) {
  const result = await completeContactShare({
    telegramUserId,
    phone: message.contact.phone_number,
    contactUserId: message.contact.user_id,
  });

  if (!result.ok) {
    const copy = {
      no_session: 'Send /start to begin.',
      aadhaar_first: 'Please send your 12-digit Aadhaar number first.',
      not_own_contact: 'Please share YOUR OWN contact using the button — a forwarded contact cannot be used.',
      invalid_phone: 'We could not read that phone number. Please try again.',
      phone_already_linked: 'This mobile number is already linked to an account.',
      duplicate: 'An account already exists for these details.',
    }[result.reason] || 'Something went wrong. Please try again.';
    return sendMessage(chatId, copy, { reply_markup: { remove_keyboard: true } });
  }

  const prompt = await joinPrompt();
  return sendTemplate({
    chatId,
    key: 'contact_confirmed',
    vars: {
      inviteLink: prompt?.inviteLink || '',
      channelUsername: prompt?.channelUsername || '',
      firstName: message.from?.first_name || '',
    },
    extra: { reply_markup: { remove_keyboard: true } },
  });
}

/**
 * A rejected player submits a different Aadhaar.
 *
 * Every refusal below is deliberately specific EXCEPT `already_registered`,
 * which is the one an attacker would want: repeated submissions that report
 * whether a number is on the platform is an enumeration oracle. It is bounded
 * by MAX_KYC_SUBMISSIONS rather than made vague, because a player who really
 * did mistype needs to be told the difference between "wrong number" and
 * "that one belongs to somebody else".
 */
async function handleReapply({ chatId, userId, aadhaar }) {
  const result = await resubmitAadhaar({ userId, aadhaar });

  if (result.ok) {
    return sendMessage(chatId,
      `\u2705 Received \u2014 Aadhaar ending <b>${result.last4}</b>.\n\n`
      + 'It is queued for verification. This is done in batches, so it is not instant, '
      + 'and there is nothing more for you to do. We will let you know.');
  }

  const copy = {
    not_rejected: 'Your Aadhaar is not awaiting a correction. Send /start to sign in.',
    too_many_attempts: `You have used all ${MAX_KYC_SUBMISSIONS} attempts. Please contact support.`,
    invalid_format: 'That does not look like a 12-digit Aadhaar number. Please send just the 12 digits.',
    already_registered: 'That Aadhaar is already registered to another account. '
      + 'Each Aadhaar can hold one account.',
    state_refused: 'We could not accept that right now. Please try again shortly.',
  }[result.reason] || 'We could not accept that Aadhaar number. Please check it and try again.';

  return sendMessage(chatId, copy);
}

// ── chat_member: the membership cache's primary writer ─────────────────────

async function handleChatMember(chatMember, cfg) {
  // No channel configured: there is no membership to record. Checked explicitly
  // rather than relying on `String(null)` failing to match an id, which is true
  // but only by accident.
  if (!cfg.channelId) return;
  // Only the official channel matters; the bot may be in other chats.
  if (String(chatMember.chat?.id) !== String(cfg.channelId)) return;

  const telegramUserId = String(chatMember.new_chat_member?.user?.id || '');
  const status = chatMember.new_chat_member?.status || 'unknown';
  if (!telegramUserId) return;

  await applyMemberUpdate({ telegramUserId, status, generation: cfg.generation });

  if (!isJoinedStatus(status)) return;

  // They just joined. If a signup was waiting on exactly this, finish it.
  const identity = await TelegramIdentity.findOne({ telegramUserId }).select('userId').lean();
  if (!identity) return;

  const done = await completeOnboarding({ userId: identity.userId });

  // ── Only a FIRST completion earns an unsolicited login link ───────────────
  //
  // This handler fires on every join, and a channel replacement makes every
  // existing player join. Sending a login link on each of those would, at the
  // moment of a flip, mint a token and push a message to the entire active user
  // base — through the single bot they are all simultaneously trying to sign in
  // with, against a Bot API limit of roughly thirty messages a second. The flip
  // would rate-limit the recovery it exists to enable, and the messages would be
  // unsolicited login links to people who are already signed in.
  //
  // A returning player who genuinely wants a link sends /start and gets one.
  if (!done.firstCompletion) return undefined;

  // In a private chat Telegram's chat id IS the user's id, which is why the
  // same value serves as both here.
  return sendLoginLink({ chatId: telegramUserId, telegramUserId, userId: identity.userId, cfg });
}

async function sendLoginLink({ chatId, telegramUserId, userId, cfg }) {
  const { url, expiresAt } = await issueLoginToken({ userId, telegramUserId });
  const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60000));
  return sendTemplate({ chatId, key: 'login_link', vars: { loginUrl: url, minutes } });
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/telegram/recovery/webhook — the SECOND bot
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Separate token, separate secret, separate endpoint. A compromised primary bot
 * must not be able to hand out other people's accounts, which it could if
 * recovery shared its credentials.
 *
 * The conversation is deliberately tiny: Aadhaar, then contact. There is no
 * channel step and no referral payload — this is not a signup.
 */
const recoverySessions = new Map();   // telegramUserId -> { aadhaar, at }
const RECOVERY_SESSION_MS = 10 * 60 * 1000;

function rememberRecovery(id, aadhaar) {
  // Bounded: a chat that stops halfway must not pin an Aadhaar in memory, and
  // the map must not grow without limit under a flood of /start messages.
  const now = Date.now();
  for (const [k, v] of recoverySessions) if (now - v.at > RECOVERY_SESSION_MS) recoverySessions.delete(k);
  if (recoverySessions.size > 10_000) recoverySessions.clear();
  recoverySessions.set(String(id), { aadhaar, at: now });
}

router.post('/recovery/webhook', async (req, res) => {
  // Resolved the same way the primary webhook is, and for the same reason: a
  // recovery bot registered in the fleet works whether or not a channel
  // generation happens to be active.
  const cfg = await activeConfig();
  const secret = cfg?.recoveryWebhookSecret || (await liveBot('recovery'))?.webhookSecret;
  if (!secret) return res.status(503).json({ ok: false });
  if (!secretMatches(req.get('X-Telegram-Bot-Api-Secret-Token'), secret)) {
    return res.status(401).json({ ok: false });
  }
  res.json({ ok: true });

  try {
    const message = req.body?.message;
    if (!message?.from || message.from.is_bot) return;
    const telegramUserId = String(message.from.id);
    const chatId = message.chat.id;
    const { sendRecoveryMessage } = await import('./telegramClient.js');
    const { attemptRecovery } = await import('./telegramRecovery.service.js');

    if (message.contact) {
      const held = recoverySessions.get(telegramUserId);
      if (!held) {
        return sendRecoveryMessage(chatId, 'Please send your 12-digit Aadhaar number first.');
      }
      const result = await attemptRecovery({
        newTelegramUserId: telegramUserId,
        phone: message.contact.phone_number,
        contactUserId: message.contact.user_id,
        aadhaar: held.aadhaar,
      });
      recoverySessions.delete(telegramUserId);

      if (!result.ok) {
        const copy = {
          not_own_contact: 'Please share YOUR OWN contact using the button.',
          invalid_phone: 'We could not read that number. Please try again.',
          blocked: 'This account is blocked. Please contact support.',
          telegram_already_linked: 'This Telegram account is already linked to a different account.',
          // Every genuine mismatch lands here with one message, on purpose.
          no_match: 'We could not verify these details. The Aadhaar and the mobile number must both '
            + 'match the account exactly, and you must be messaging from the number the account uses.',
        }[result.reason] || 'We could not complete recovery. Please contact support.';
        return sendRecoveryMessage(chatId, copy, { reply_markup: { remove_keyboard: true } });
      }

      const { url } = await issueLoginToken({ userId: result.userId, telegramUserId });
      return sendRecoveryMessage(chatId,
        `✅ Account recovered.\n\n<a href="${url}">Tap here to sign in</a>\n\n`
        + 'Your balance, history and referrals are unchanged. '
        + 'Use the main bot from now on.',
        { reply_markup: { remove_keyboard: true } });
    }

    const text = String(message.text || '').trim();
    if (text.startsWith('/start')) {
      return sendTemplate({
        chatId, key: 'recovery_welcome', role: 'recovery',
        vars: { firstName: message.from?.first_name || '' },
      });
    }

    if (isValidAadhaar(text)) {
      rememberRecovery(telegramUserId, text);
      return sendRecoveryMessage(chatId,
        'Now tap the button below to share the contact of <b>this</b> Telegram account. '
        + 'It must be the same mobile number your account uses.',
        { reply_markup: contactKeyboard });
    }

    return sendRecoveryMessage(chatId, 'Please send your 12-digit Aadhaar number, or /start to begin again.');
  } catch (err) {
    console.error('[telegram] recovery handling failed:', err.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/telegram/public-config — where the sign-in button points
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Public and unauthenticated, because it is what an anonymous visitor needs in
 * order to sign in at all. It carries only what is already public the moment
 * the bot exists: its @username, the recovery bot's, and the channel's invite
 * link. No token, no secret, no channel id.
 *
 * It exists so that replacing a suspended bot is a database write and nothing
 * more. Baking @username into the panel would mean a rebuild and a redeploy of
 * three applications before anyone could sign up again — during an outage where
 * nobody can.
 */
router.get('/public-config', async (req, res) => {
  try {
    const cfg = await activeConfig();
    if (!cfg?.botUsername) {
      return res.status(503).json({ success: false, message: 'Sign-in is being configured. Please try again shortly.' });
    }
    // Short cache: a bot replacement should reach visitors in about a minute,
    // but this must not be a per-page-load database read at 10k DAU.
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json({
      success: true,
      botUsername: cfg.botUsername,
      recoveryBotUsername: cfg.recoveryBotUsername || '',
      channelInviteLink: cfg.channelInviteLink || '',
      channelUsername: cfg.channelUsername || '',
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Could not load sign-in details.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/telegram/membership — "have I joined yet?"
// ═══════════════════════════════════════════════════════════════════════════
/**
 * What the join prompt asks after the player says they have joined.
 *
 * ── Why this reads the cache first ──────────────────────────────────────────
 * Replacing the channel makes every cached membership stale in one instant, so
 * on a flip the prompt appears for every logged-in player at once. If each
 * "I've joined" tap forced a getChatMember, a flip would aim the entire active
 * user base at the Bot API in the same few seconds and rate-limit the bot that
 * everyone is simultaneously trying to sign in through.
 *
 * It does not need to. Joining a channel emits a `chat_member` update, and that
 * webhook writes the cache within about a second of the tap — for free. So the
 * default read is cache-only, and a live check is something the client asks for
 * explicitly, once, after giving the webhook a moment to arrive.
 *
 * The live check is additionally floored per user, because the button is a
 * button and people press buttons.
 */
const lastLiveCheck = new Map();  // userId -> epoch ms
const LIVE_CHECK_FLOOR_MS = 20_000;

function mayCheckLive(userId) {
  const now = Date.now();
  // Bounded, same posture as the recovery session map above: a large logged-in
  // population must not be able to grow this without limit.
  if (lastLiveCheck.size > 50_000) lastLiveCheck.clear();
  const last = lastLiveCheck.get(String(userId)) || 0;
  if (now - last < LIVE_CHECK_FLOOR_MS) return false;
  lastLiveCheck.set(String(userId), now);
  return true;
}

router.get('/membership', authenticate, async (req, res) => {
  try {
    const identity = await TelegramIdentity.findOne({ userId: req.user.userId })
      .select('telegramUserId channelStatus channelCheckedAt channelGeneration')
      .lean();

    const wantsLive = req.query.verify === '1';
    const refresh = wantsLive && mayCheckLive(req.user.userId);
    const verdict = await membershipFor(identity, { refresh });

    const prompt = await joinPrompt();
    return res.json({
      success: true,
      joined: Boolean(verdict.joined),
      linked: Boolean(identity),
      unconfigured: Boolean(verdict.unconfigured),
      // True when a live check was ASKED for and declined by the floor, so the
      // client can say "checking again shortly" instead of "you have not joined".
      throttled: wantsLive && !refresh,
      checked: Boolean(verdict.checked),
      telegram: prompt,
    });
  } catch (err) {
    console.error('[telegram] membership check failed:', err.message);
    if (!res.headersSent) res.status(503).json({ success: false, message: 'Could not check your membership right now.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/telegram/exchange — the browser trades the link for a session
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Mounted here rather than under /api/v1/auth because it is part of the
 * Telegram surface, but it issues exactly the same session the password path
 * does — `issueSession` is imported, not reimplemented, so a Telegram login and
 * a staff login can never drift into granting different claims.
 */
router.post('/exchange', async (req, res) => {
  try {
    const { redeemLoginToken } = await import('./telegramLogin.service.js');
    const claim = await redeemLoginToken(req.body?.token);
    if (!claim.ok) {
      return res.status(401).json({ success: false, message: 'This login link is invalid or has already been used. Send /start to the bot for a new one.' });
    }

    const user = await db.users.getUser(claim.userId);
    if (!user) return res.status(401).json({ success: false, message: 'Account not found' });
    if (user.isBlocked || user.status === 'BLOCKED') {
      return res.status(403).json({ success: false, message: 'Account blocked. Contact support.' });
    }

    const { issueSession } = await import('../../routes.js');
    return issueSession(user, res);
  } catch (err) {
    console.error('[telegram] session exchange failed:', err.message);
    return res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
  }
});

export default router;
