// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/telegram/telegram.routes.js — the bot webhooks.
 *
 * ── What the bot does now, and what it stopped doing ───────────────────────
 * The account is created by a FORM (domains/identity/playerAuth.routes.js).
 * Telegram is the VERIFICATION step that follows it, and only that:
 *
 *   • a CONTACT SHARE, matched against an account that already exists, which is
 *     what turns a number somebody typed into a number Telegram has verified;
 *   • a CHANNEL JOIN, auto-approved, which is the standing membership rule.
 *
 * Gone with the form: taking an Aadhaar number over a chat, creating accounts
 * from a conversation, the one-time login link and the six-digit login code.
 * **A bot cannot mint a session any more.** That is the security half of the
 * change — a compromised or suspended bot could previously hand out logins —
 * and it is why `issueLoginToken` and `telegramOtp.service.js` are deleted
 * rather than left mounted.
 *
 * ── The sign-in bot is a FLEET, so the webhook is per-bot ──────────────────
 * `POST /webhook/:botId`. One path per bot, deliberately, because each bot has
 * its OWN secret token and the constant-time compare has to know which secret
 * to compare against. Looking the bot up BY its secret would work and is what a
 * single shared path would force; it would also mean an index lookup keyed on a
 * secret, and there is no reason to build that when Telegram will happily
 * deliver to a path that names the bot.
 *
 * The bot id in the path is PUBLIC — it is Telegram's own numeric id for a bot
 * whose @username anyone can see. It identifies; the secret authenticates.
 *
 * ── Every reply is sent BY THE BOT THE UPDATE ARRIVED ON ───────────────────
 * A Telegram bot may only message somebody who has opened a chat with IT. With
 * one bot that was invisible. With a fleet it is the central fact: a player
 * assigned bot #47 is in a chat with #47 and nothing else, and a reply from #1
 * is refused by Telegram with "bot can't initiate conversation with a user" —
 * which reads to the player as a conversation that simply stopped. So `bot` is
 * threaded through every handler here and every send goes through `sendAs`.
 *
 * ── Why the webhook always answers 200 ─────────────────────────────────────
 * Telegram retries an update it considers failed, and retries the SAME update,
 * which for a handler that half-succeeded means doing the ambiguous part again.
 * Once an update is authenticated it is acknowledged immediately and processed
 * for effect; genuine failures are logged and surfaced through metrics rather
 * than through a status code that makes Telegram replay them.
 */
import express from 'express';
import { db } from '#db';
import crypto from 'crypto';
import {
  activeConfig, sendAs, approveJoinRequest, sendRecoveryMessage, liveBot, callApi,
} from './telegramClient.js';
import { decryptField } from '../identity/fieldCrypto.util.js';
import { applyMemberUpdate, isJoinedStatus, joinPrompt, membershipFor } from './telegramMembership.js';
import { completeVerification, noteContactChange } from '../identity/signupVerification.service.js';
import { issueResetLink } from '../identity/passwordReset.service.js';
import { normalisePhone, isValidAadhaar } from '../identity/signupFields.js';
import { sendTemplate } from './telegramTemplates.service.js';
import { hashAadhaarCandidates } from '../identity/aadhaarHash.util.js';

const router = express.Router();

/** Constant-time compare — a secret checked with === leaks its prefix. */
function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The share-contact button.
 *
 * `request_contact` is the ONLY way to get a number Telegram itself vouches
 * for. A number typed into the chat is a number somebody typed, which is what
 * the form already has.
 */
const contactKeyboard = {
  keyboard: [[{ text: '📱 Share my contact', request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

/**
 * The reset offer, shown to somebody whose contact just matched an account.
 *
 * ── Why a BUTTON and not an automatic link ────────────────────────────────
 * A contact share is also the VERIFICATION step, so the same tap means two
 * different things depending on who is doing it. Sending a reset link
 * automatically would put a live credential in the chat of every player who was
 * merely finishing their signup — and they never asked for one.
 *
 * So it is offered and they press it. `callback_data` rather than a URL,
 * because the link does not exist until somebody asks: a URL button would have
 * to carry a token minted in advance, which is a credential sitting in a
 * message whether or not it is ever wanted.
 */
const RESET_CALLBACK = 'bb:reset';
const resetOffer = {
  inline_keyboard: [[{ text: '🔑 I forgot my password', callback_data: RESET_CALLBACK }]],
};

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/telegram/webhook/:botId — every update from one sign-in bot
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve the bot this delivery names, and prove the delivery is Telegram's.
 *
 * Refuses a RETIRED bot. An operator who retires a bot has decided it must stop
 * doing this job, and Telegram keeps delivering until the webhook is cleared —
 * a call that a banned or deleted bot refuses, so "we told Telegram to stop" is
 * never something this platform may assume. The refusal here is what actually
 * stops it.
 */
async function resolveDeliveringBot(req) {
  const secrets = await db.telegram.getBotSecrets(String(req.params.botId || ''));
  if (!secrets || secrets.role !== 'signin' || secrets.status === 'RETIRED') return null;
  if (!secretMatches(req.get('X-Telegram-Bot-Api-Secret-Token'), secrets.webhookSecret)) return null;
  let token = null;
  try { token = decryptField(secrets.tokenEncrypted); } catch { token = null; }
  if (!token) {
    // IDENTITY_ENCRYPTION_KEY changed, or the row was tampered with. Loud,
    // because every player assigned to this bot is now stuck at a step they
    // cannot pass and nothing else on the platform would ever say why.
    console.error(`[telegram] bot ${secrets.botId} token could not be decrypted — check IDENTITY_ENCRYPTION_KEY`);
    return null;
  }
  return { botId: secrets.botId, username: secrets.username, token };
}

router.post('/webhook/:botId', async (req, res) => {
  const bot = await resolveDeliveringBot(req);
  // Deliberately terse, and the same answer for an unknown bot and a wrong
  // secret: an attacker probing for the endpoint learns neither which bot ids
  // exist nor whether their secret was close.
  if (!bot) return res.status(401).json({ ok: false });

  res.json({ ok: true });

  try {
    await handleUpdate(req.body, bot);
  } catch (err) {
    console.error('[telegram] update handling failed:', err.message);
  }
});

async function handleUpdate(update, bot) {
  if (update?.message) return handleMessage(update.message, bot);
  // The reset offer, pressed.
  if (update?.callback_query) return handleCallback(update.callback_query, bot);
  // The channel is PRIVATE and admits on a join request, so this is the update
  // that actually lets somebody in.
  if (update?.chat_join_request) return handleJoinRequest(update.chat_join_request, bot);
  // `chat_member` is what keeps membership current without polling — including
  // the LEAVE that re-gates somebody.
  if (update?.chat_member) return handleChatMember(update.chat_member, bot);
  return undefined;
}

// ── Messages: /start, and a shared contact. That is the whole conversation. ──

async function handleMessage(message, bot) {
  const from = message.from;
  if (!from || from.is_bot) return;
  const telegramUserId = String(from.id);
  const chatId = message.chat.id;
  const firstName = from.first_name || '';

  if (message.contact) {
    return handleContact({ message, telegramUserId, chatId, bot });
  }

  // ── Anything that is not a contact gets the same answer ──────────────────
  // There is nothing else to type. The conversation this replaced had a state
  // machine because it was collecting an Aadhaar number; this one has one
  // button, so "send /start to begin" and "that is not 12 digits" and the four
  // step-specific prompts all collapse into: tell them where they are, and show
  // the button if they still need it.
  const identity = await db.telegram.getIdentityByTelegramId(telegramUserId);

  if (!identity || !identity.contactActive) {
    return sendTemplate({
      bot, chatId, key: identity ? 'ask_contact' : 'welcome',
      vars: { firstName, botUsername: bot.username },
      extra: { reply_markup: contactKeyboard },
    });
  }

  // Linked. The only question left is the channel, and it is asked against the
  // CURRENT one: an admin may have replaced it since they joined, in which case
  // the right answer is "join again", not "you are all set".
  return replyWithChannelState({ bot, chatId, identity, firstName });
}

/**
 * Tell somebody who is already linked what, if anything, is left.
 *
 * `refresh: false` — the cache only. This runs on every stray message a bot
 * receives, and a `getChatMember` per message would put the fleet's whole
 * message volume onto the Bot API's per-bot rate limit, which is the very thing
 * the fleet exists to stay under. `chat_member` keeps the cache honest.
 */
async function replyWithChannelState({ bot, chatId, identity, firstName }) {
  const verdict = await membershipFor(identity, { refresh: false });
  if (verdict.joined || verdict.unconfigured) {
    // The reset offer rides on the "you are all set" message, because that is
    // the one a player who has come back for their password will see: they are
    // already verified, so nothing else is asked of them and this is the only
    // thing the conversation has left to offer.
    return sendTemplate({
      bot, chatId, key: 'verified', vars: { firstName },
      extra: { reply_markup: resetOffer },
    });
  }
  const prompt = await joinPrompt();
  return sendTemplate({
    bot, chatId, key: 'contact_confirmed',
    vars: {
      firstName,
      inviteLink: prompt?.inviteLink || '',
      channelUsername: prompt?.channelUsername || '',
    },
    extra: { reply_markup: { remove_keyboard: true } },
  });
}

/**
 * "I forgot my password", pressed.
 *
 * ── What proves they may have it ──────────────────────────────────────────
 * The LINK, not the press. A `callback_query` carries the Telegram user id, and
 * that id is linked to exactly one account by a contact share Telegram itself
 * verified — so pressing this from a Telegram account that is not linked
 * reaches no account at all. There is nothing to guess and nothing to enumerate:
 * the button is only ever shown to somebody whose contact already matched.
 *
 * `answerCallbackQuery` is not optional. Telegram shows a spinner on the button
 * until it is answered, and a button that spins forever is a button people press
 * again — which on this path means another token and another live credential.
 */
async function handleCallback(query, bot) {
  const telegramUserId = String(query.from?.id || '');
  const chatId = query.message?.chat?.id ?? telegramUserId;
  const ack = (text) => callApi(bot.token, 'answerCallbackQuery', {
    callback_query_id: query.id, ...(text ? { text, show_alert: false } : {}),
  }).catch(() => {});

  if (query.data !== RESET_CALLBACK || !telegramUserId) return ack();

  const identity = await db.telegram.getIdentityByTelegramId(telegramUserId);
  if (!identity || !identity.contactActive) {
    await ack();
    return sendAs(bot, chatId,
      'Share your contact first — that is how we know which account to reset.',
      { reply_markup: contactKeyboard });
  }

  const issued = await issueResetLink({
    userId: identity.userId,
    telegramUserId,
    baseUrl: process.env.PUBLIC_APP_ORIGIN,
  });

  if (!issued.ok) {
    await ack();
    const copy = {
      blocked: 'This account is blocked, so a password reset would not restore access. '
        + 'Please contact support.',
    }[issued.reason] || 'We could not start a password reset just now. Please try again shortly.';
    return sendAs(bot, chatId, copy);
  }

  await ack('Link sent');
  return sendTemplate({
    bot, chatId, key: 'password_reset',
    vars: { resetUrl: issued.url, minutes: issued.minutes, firstName: identity.firstName || '' },
  });
}

/**
 * The contact share — the step that proves the number.
 *
 * Everything this can refuse is a sentence somebody has to be TOLD, and each
 * one has a different next action, so none of them are collapsed into one
 * message.
 */
async function handleContact({ message, telegramUserId, chatId, bot }) {
  const firstName = message.from?.first_name || '';

  // Telegram includes the owning user's id on a shared contact. If it is not
  // the sender's own id, they forwarded somebody ELSE's contact card — which
  // would register that person's number against this Telegram account.
  const contactUserId = message.contact.user_id;
  if (contactUserId && String(contactUserId) !== String(telegramUserId)) {
    return sendAs(bot, chatId,
      'Please share YOUR OWN contact using the button — a forwarded contact cannot be used.',
      { reply_markup: contactKeyboard });
  }

  const phone = normalisePhone(message.contact.phone_number);
  if (!phone) {
    return sendAs(bot, chatId, 'We could not read that phone number. Please try again.',
      { reply_markup: contactKeyboard });
  }

  // ── The number CHANGED under an existing link ────────────────────────────
  // Checked before the link is attempted, because this is the one moment a
  // changed Telegram number is visible at all (see signupVerification.service).
  // `linkTelegramToAccount` would answer `already_linked` here, which is true
  // and useless: it would tell somebody whose number moved that their own
  // account belongs to somebody else.
  const existing = await db.telegram.getIdentityByTelegramId(telegramUserId);
  if (existing && String(existing.phone) !== phone) {
    await noteContactChange({
      userId: existing.userId,
      telegramUserId,
      wasPhone: existing.phone,
      nowPhone: phone,
    });
    return sendAs(bot, chatId,
      'This Telegram account now uses a different mobile number from the one your '
      + 'Betting Bazaar account was verified with.\n\nYour verification has been paused and '
      + 'our team has been notified. Please contact support — this is not something you can '
      + 'fix from here.',
      { reply_markup: { remove_keyboard: true } });
  }

  const cfg = await activeConfig();
  const result = await db.telegram.linkTelegramToAccount({
    telegramUserId,
    phone,
    telegramUsername: message.from?.username || '',
    firstName,
    generation: cfg?.generation ?? 0,
  });

  if (!result.ok) {
    if (result.reason === 'no_account') {
      // They have done exactly what they were asked and there is nothing here.
      // The only useful reply names the form.
      return sendTemplate({
        bot, chatId, key: 'not_registered', vars: { firstName },
        extra: { reply_markup: { remove_keyboard: true } },
      });
    }
    const copy = {
      already_linked: 'This Telegram account is already verifying a different Betting Bazaar '
        + 'account. Use the Telegram account you signed up with.',
      phone_taken: 'That mobile number has already been verified by a different Telegram '
        + 'account. Please contact support.',
    }[result.reason] || 'Something went wrong. Please try again.';
    return sendAs(bot, chatId, copy, { reply_markup: { remove_keyboard: true } });
  }

  // Verified. Now the channel — and they may already be in it, which happens on
  // a re-share and whenever somebody joined the channel before signing up.
  const identity = await db.telegram.getIdentityByTelegramId(telegramUserId);
  return replyWithChannelState({ bot, chatId, identity, firstName });
}

// ── chat_join_request: the private channel's front door ────────────────────

/**
 * Admit somebody who asked to join.
 *
 * The channel is private and admits on a JOIN REQUEST, so a link does not add
 * anybody — it queues them. Approval is immediate and automatic: the request is
 * the player doing exactly what they were told to do, and a queue waiting for
 * an admin would make signing up take as long as somebody's attention span.
 *
 * Approving does NOT itself record membership. Telegram emits a `chat_member`
 * update for the join that follows, and that is the one writer of the cache —
 * writing it here as well would be a second writer for one value (§2), and the
 * two would disagree the first time an approval succeeded and the join did not.
 */
async function handleJoinRequest(request, bot) {
  const cfg = await activeConfig();
  if (!cfg?.channelId) return;
  if (String(request.chat?.id) !== String(cfg.channelId)) return;

  const telegramUserId = String(request.from?.id || '');
  if (!telegramUserId) return;

  const res = await approveJoinRequest(bot, cfg.channelId, telegramUserId);
  if (!res.ok) {
    // The player is sitting on a pending request that nobody will approve, and
    // the commonest cause is that this bot is not an administrator of the
    // channel with permission to invite. Nothing else would say so.
    console.error(`[telegram] could not approve join request from ${telegramUserId} `
      + `via @${bot.username}: ${res.error}`);
  }
}

// ── chat_member: the membership cache's primary writer ─────────────────────

async function handleChatMember(chatMember, bot) {
  const cfg = await activeConfig();
  // No channel configured: there is no membership to record. Checked explicitly
  // rather than relying on `String(null)` failing to match an id, which is true
  // but only by accident.
  if (!cfg?.channelId) return;
  // Only the official channel matters; the bot may be in other chats.
  if (String(chatMember.chat?.id) !== String(cfg.channelId)) return;

  const telegramUserId = String(chatMember.new_chat_member?.user?.id || '');
  const status = chatMember.new_chat_member?.status || 'unknown';
  if (!telegramUserId) return;

  // Writes a LEAVE exactly as it writes a join. That is how "if they leave they
  // must be asked to join again" is enforced with no sweep and no timer: the
  // next authenticated request reads this row and the gate closes.
  await applyMemberUpdate({ telegramUserId, status, generation: cfg.generation });

  if (!isJoinedStatus(status)) return;

  const identity = await db.telegram.getIdentityByTelegramId(telegramUserId);
  if (!identity) return;

  // ── This is where a signup FINISHES ──────────────────────────────────────
  // The joining number and the referrer's ₹25 are claimed here and nowhere
  // else, because this is the first moment both halves of verification hold.
  // Idempotent: a redelivered update, and every re-join after a channel
  // replacement, do nothing.
  const done = await completeVerification({ userId: identity.userId });

  // Only a FIRST completion is worth a message. This handler fires on every
  // join, and a channel replacement makes the entire user base re-join — so
  // sending on each would push one message per player through the fleet in the
  // same few seconds, at the exact moment everyone is trying to get back in.
  if (!done.firstCompletion) return undefined;

  // In a private chat Telegram's chat id IS the user's id.
  return sendTemplate({
    bot, chatId: telegramUserId, key: 'verified',
    vars: { firstName: identity.firstName || '' },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/telegram/recovery/webhook — the SECOND bot
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Separate token, separate secret, separate endpoint, and SINGULAR — there is
 * one recovery bot, enforced by the partial unique index on `live_slot`. A
 * compromised sign-in bot must not be able to hand out other people's accounts,
 * and one door is a door somebody can watch.
 *
 * ── What recovery is FOR, now that there are passwords ────────────────────
 * Not signing in. A player who has lost their Telegram account still has their
 * password and still logs in with it — what they cannot do is verify, because
 * `one_active_identity_per_user` refuses a second live link and the old,
 * unreachable Telegram account is holding the one they have.
 *
 * So recovery MOVES THE LINK to their new Telegram account, against the same
 * two proofs it always required: the Aadhaar on the account, and a contact
 * share of the same mobile. It no longer issues a session — it cannot, and that
 * is the point of the change.
 */
const RECOVERY_SESSION_SECONDS = 10 * 60;

// ── The half-finished recovery lives in the DATABASE ──────────────────────
// It was a process-local `Map`, and this platform is built for horizontal
// scale. Behind a load balancer the Aadhaar message and the contact message
// land on different instances, and the second answers "please send your Aadhaar
// first" to somebody who just did: intermittent, indistinguishable from their
// own mistake, on the one path a person reaches BECAUSE they have already lost
// access. Its size cap was also a `clear()` at 10,000, which wiped live
// recoveries rather than old ones. Audit F-002.
//
// It stores HASHES. `attemptRecovery` only ever compared, so it never needed
// the number — the plaintext exists for the length of one function call and is
// never stored, which is stronger than the ciphertext onboarding held.
async function rememberRecovery(id, aadhaar) {
  const aadhaarHashes = hashAadhaarCandidates(aadhaar);
  if (!aadhaarHashes.length) return false;
  await db.telegram.putRecoverySession({
    telegramUserId: String(id), aadhaarHashes, ttlSeconds: RECOVERY_SESSION_SECONDS,
  });
  return true;
}

router.post('/recovery/webhook', async (req, res) => {
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
    const { attemptRecovery } = await import('./telegramRecovery.service.js');

    if (message.contact) {
      const held = await db.telegram.getRecoverySession(telegramUserId);
      if (!held) {
        // ── No Aadhaar held: this is the PASSWORD path, not the recovery one ──
        // Somebody who has lost their password and opened the recovery bot has
        // done a reasonable thing, and telling them to send an Aadhaar number
        // sends them down a flow that ends in "we could not verify these
        // details" — for a problem that is one link away. So a contact share
        // with no Aadhaar behind it is read as what it almost always is, and
        // answered from the LINK that already exists (owner, 2026-09-24: both
        // bots issue a reset).
        //
        // It grants nothing this bot could not already do: the identity is the
        // one a verified contact share created, and an unlinked Telegram
        // account reaches no account at all.
        const phone = normalisePhone(message.contact.phone_number);
        const linked = phone
          ? await db.telegram.getIdentityByTelegramId(telegramUserId)
          : null;
        if (linked?.contactActive && String(linked.phone) === phone) {
          const issued = await issueResetLink({
            userId: linked.userId, telegramUserId, baseUrl: process.env.PUBLIC_APP_ORIGIN,
          });
          if (issued.ok) {
            return sendTemplate({
              chatId, key: 'password_reset', role: 'recovery',
              vars: { resetUrl: issued.url, minutes: issued.minutes, firstName: message.from?.first_name || '' },
              extra: { reply_markup: { remove_keyboard: true } },
            });
          }
        }
        return sendRecoveryMessage(chatId,
          'To move your account to this Telegram account, send your 12-digit Aadhaar number first.\n\n'
          + 'If you only need a new PASSWORD, share your contact from the Telegram account you '
          + 'already verified with and we will send you a reset link.',
          { reply_markup: { remove_keyboard: true } });
      }
      const result = await attemptRecovery({
        newTelegramUserId: telegramUserId,
        phone: message.contact.phone_number,
        contactUserId: message.contact.user_id,
        aadhaarHashes: held.aadhaarHashes,
      });
      // Consumed whether it succeeded or failed: one attempt per Aadhaar sent,
      // so a wrong contact share cannot be retried against a held Aadhaar.
      await db.telegram.deleteRecoverySession(telegramUserId);

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

      // ── No link, and no session ──────────────────────────────────────────
      // This bot could previously sign somebody in. It cannot now: the player
      // has a password, so the thing recovery had to restore was the Telegram
      // LINK, and it just did. Sending them to the app to use the password they
      // already have is both the correct instruction and one fewer credential
      // this bot is able to mint.
      const prompt = await joinPrompt();
      return sendRecoveryMessage(chatId,
        '✅ Your Telegram account is now linked again.\n\n'
        + 'Sign in to Betting Bazaar with your mobile number and password as usual. '
        + 'Your balance, history and referrals are unchanged.'
        + (prompt?.inviteLink ? `\n\nIf you are not in our channel yet, join here: ${prompt.inviteLink}` : ''),
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
      // AWAITED. The session is a database row and the very next message reads
      // it — telling the person to share their contact before the write has
      // landed is a race whose loser is answered "send your Aadhaar first"
      // after doing exactly that.
      const remembered = await rememberRecovery(telegramUserId, text);
      if (!remembered) {
        return sendRecoveryMessage(chatId,
          'We could not start recovery just now. Please send your Aadhaar number again in a moment.');
      }
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
// GET /api/telegram/public-config — what an ANONYMOUS visitor needs
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Public and unauthenticated, and much smaller than it was.
 *
 * It no longer names a sign-in bot, because an anonymous visitor no longer
 * needs one: they fill the form first, and WHICH bot they are then sent to is
 * decided by the rotation, per account, and served by the authenticated
 * verification endpoint. Publishing "the" bot here would be a second answer to
 * that question and it would be the wrong one for all but 1/N of players.
 *
 * What remains is what is genuinely public and genuinely needed before anybody
 * has an account: the channel a visitor may want to look at, and the recovery
 * bot, which is the one door somebody with no working account can be pointed
 * at. No token, no secret, no channel id.
 */
router.get('/public-config', async (req, res) => {
  try {
    const cfg = await activeConfig();
    // Short cache: a replacement should reach visitors in about a minute, but
    // this must not be a per-page-load database read at 10k DAU.
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json({
      success: true,
      recoveryBotUsername: cfg?.recoveryBotUsername || '',
      channelInviteLink: cfg?.channelInviteLink || '',
      channelUsername: cfg?.channelUsername || '',
    });
  } catch (err) {
    console.error('[telegram] public config failed:', err.message);
    return res.status(500).json({ success: false, message: 'Could not load sign-in details.' });
  }
});

export default router;
