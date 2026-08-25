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
import crypto from 'crypto';
import mongoose from 'mongoose';
import { TelegramIdentity, TelegramPendingLink } from './telegram.model.js';
import { activeConfig, sendMessage } from './telegramClient.js';
import { applyMemberUpdate, isJoinedStatus, joinPrompt } from './telegramMembership.js';
import {
  beginOnboarding, submitAadhaar, completeContactShare, completeOnboarding, isValidAadhaar,
} from './telegramOnboarding.service.js';
import { issueLoginToken } from './telegramLogin.service.js';

const router = express.Router();

/** Constant-time compare — a secret checked with === leaks its prefix. */
function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Copy shown to players ───────────────────────────────────────────────────

const ASK_AADHAAR =
  'Welcome to <b>Betting Bazaar</b>.\n\n'
  + 'To create your account, send your <b>12-digit Aadhaar number</b>.\n\n'
  + '⚠️ Sign up with the Telegram account registered on the <b>same mobile number '
  + 'that is linked to this Aadhaar</b>. They must match, or verification will fail.';

const ASK_CONTACT =
  'Thank you. Now tap the <b>Share my contact</b> button below.\n\n'
  + 'We use it to confirm your number — it must be the mobile linked to the '
  + 'Aadhaar you just sent.';

const contactKeyboard = {
  keyboard: [[{ text: '📱 Share my contact', request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/telegram/webhook — every update from the primary bot
// ═══════════════════════════════════════════════════════════════════════════
router.post('/webhook', async (req, res) => {
  const cfg = await activeConfig();
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
    const payload = text.split(/\s+/)[1] || null;
    const begun = await beginOnboarding({
      telegramUserId,
      username: from.username,
      firstName: from.first_name,
      referralCode: payload,
    });

    if (begun.alreadyLinked) {
      // An existing player pressing /start is asking to log in.
      return sendLoginLink({ chatId, telegramUserId, userId: begun.userId, cfg });
    }
    return sendMessage(chatId, ASK_AADHAAR);
  }

  // Anything else, while a signup is open, is treated as the Aadhaar attempt.
  const pending = await TelegramPendingLink.findOne({ telegramUserId }).select('step').lean();
  if (!pending) {
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
    return sendMessage(chatId, ASK_CONTACT, { reply_markup: contactKeyboard });
  }

  if (pending.step === 'AWAITING_CONTACT') {
    return sendMessage(chatId, ASK_CONTACT, { reply_markup: contactKeyboard });
  }

  return sendMessage(chatId, 'Please join our channel to finish signing up.');
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
  const link = prompt?.inviteLink || '';
  return sendMessage(chatId,
    '✅ Number confirmed.\n\n'
    + `<b>Last step:</b> join our official channel${link ? ` — ${link}` : ''}\n\n`
    + 'Come back here once you have joined and I will send your login link.',
    { reply_markup: { remove_keyboard: true } });
}

// ── chat_member: the membership cache's primary writer ─────────────────────

async function handleChatMember(chatMember, cfg) {
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

  await completeOnboarding({ userId: identity.userId });
  return sendLoginLink({ chatId: telegramUserId, telegramUserId, userId: identity.userId, cfg });
}

async function sendLoginLink({ chatId, telegramUserId, userId, cfg }) {
  const { url, expiresAt } = await issueLoginToken({ userId, telegramUserId });
  const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60000));
  return sendMessage(chatId,
    `🎉 You are all set.\n\n<a href="${url}">Tap here to open Betting Bazaar</a>\n\n`
    + `This link signs you in automatically and expires in ${minutes} minutes. `
    + 'Send /start any time for a new one.');
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
  const cfg = await activeConfig();
  if (!cfg?.recoveryWebhookSecret) return res.status(503).json({ ok: false });
  if (!secretMatches(req.get('X-Telegram-Bot-Api-Secret-Token'), cfg.recoveryWebhookSecret)) {
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
      return sendRecoveryMessage(chatId,
        '<b>Account recovery</b>\n\n'
        + 'Use this only if you have lost the Telegram account you signed up with, '
        + 'but still use the same mobile number.\n\n'
        + 'Send your <b>12-digit Aadhaar number</b> to begin.');
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

    const User = mongoose.model('User');
    const user = await User.findById(claim.userId).select('+phantomAccess');
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
