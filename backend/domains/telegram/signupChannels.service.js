// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/telegram/signupChannels.service.js — the channels a new player is
 * asked to join at Verify, and the join requests Telegram reports for them
 * (owner, 2026-10-21).
 *
 * ── What Telegram allows, and so what this does ─────────────────────────────
 * A page cannot send a join request for anybody: the person taps "Request to
 * join" in Telegram. So the Mini App opens the channel's invite link after
 * Verify, and the sign-in never waits on it. The link is made by our bot with
 * `creates_join_request` and no expiry date; `refreshInviteLinks` checks it and
 * makes a new one when Telegram revoked it or another bot is now in use.
 *
 * The requests reach us by POLLING (`getUpdates`, only `chat_join_request`):
 * there is still no webhook and the bot still messages nobody. Nothing is
 * approved here on its own; `approveWaiting` runs only when an admin presses
 * it, and records each request Telegram no longer holds as GONE, so the next
 * Verify asks that person again.
 *
 * With no channel switched on, nothing here does anything.
 */
import { db } from '#db';
import { callApi, miniAppBot, miniAppBots } from './telegramClient.js';
import { refusal } from '../../shared/httpError.js';

/** The name our invite links carry in the channel's admin list. */
export const INVITE_LINK_NAME = 'Betting Bazaar signup';

/** How many updates one read asks for (Telegram's maximum). */
const UPDATES_PER_READ = 100;

/** How many waiting requests one press approves; press again for more. */
export const APPROVE_PER_PRESS = 1000;

/** Pause between approvals, under Telegram's per-bot rate. */
const APPROVE_GAP_MS = Number(process.env.TELEGRAM_APPROVE_GAP_MS ?? 40);

/** What an admin may type for a channel: @name, t.me/name, or its -100… id. */
const CHANNEL_REF = /^(?:@|https?:\/\/t\.me\/)?([A-Za-z][A-Za-z0-9_]{3,31})$|^(-100\d{5,20})$/;

/**
 * The channel an admin typed, as Telegram describes it, refused unless our bot
 * in use is an administrator there who may invite people (it makes the link
 * and approves the requests).
 */
export async function describeChannel(ref, { bot } = {}) {
  const m = String(ref ?? '').trim().match(CHANNEL_REF);
  if (!m) throw refusal(400, 'CHANNEL_INVALID', 'Enter the channel as @name, a t.me/name link, or its -100… id.');
  const use = bot ?? await miniAppBot();
  if (!use) throw refusal(503, 'TELEGRAM_UNAVAILABLE', 'Save a bot first: the bot makes the invite link and reads the join requests.');
  const chatRef = m[1] ? `@${m[1]}` : m[2];

  const chat = await callApi(use.token, 'getChat', { chat_id: chatRef });
  if (!chat.ok) throw refusal(400, 'CHANNEL_NOT_FOUND', `Telegram could not find that channel for @${use.botUsername}: ${chat.error}. Add the bot to the channel as an administrator first.`);
  if (chat.result.type !== 'channel' && chat.result.type !== 'supergroup') {
    throw refusal(400, 'NOT_A_CHANNEL', 'That is not a channel or a group.');
  }
  const member = await callApi(use.token, 'getChatMember', { chat_id: chat.result.id, user_id: Number(use.botId) });
  const admin = member.ok && (member.result.status === 'administrator' || member.result.status === 'creator');
  if (!admin || (member.result.status === 'administrator' && !member.result.can_invite_users)) {
    throw refusal(400, 'BOT_NOT_ADMIN', `Make @${use.botUsername} an administrator of that channel with "Invite users via link" on, then add it again.`);
  }
  return { chatId: String(chat.result.id), title: chat.result.title || chatRef, username: chat.result.username || '' };
}

/** Add (or switch back on) a channel, and make its invite link at once. */
export async function addChannel({ ref, by }) {
  const bot = await miniAppBot();
  const found = await describeChannel(ref, { bot });
  const saved = await db.telegramChannels.saveChannel({ ...found, addedBy: by });
  return (await ensureInviteLink(saved, bot)) ?? saved;
}

/**
 * Keep one channel's link usable: keep it when the bot in use made it and
 * Telegram still honours it, otherwise make a new one. An error is recorded on
 * the row for the admin page, never thrown.
 */
export async function ensureInviteLink(channel, bot) {
  if (!bot) return db.telegramChannels.setInviteLink({ chatId: channel.chatId, error: 'No bot is saved.' });
  if (channel.inviteLink && channel.linkBotId === bot.botId) {
    const kept = await callApi(bot.token, 'editChatInviteLink', {
      chat_id: channel.chatId, invite_link: channel.inviteLink,
      name: INVITE_LINK_NAME, creates_join_request: true,
    });
    if (kept.ok && !kept.result?.is_revoked) {
      return db.telegramChannels.setInviteLink({ chatId: channel.chatId });
    }
    // A timeout or 5xx is Telegram's weather: keep the link, try next time.
    if (!kept.ok && (!kept.status || kept.status >= 500 || kept.status === 429)) {
      return db.telegramChannels.setInviteLink({ chatId: channel.chatId, error: `Could not check the link: ${kept.error}` });
    }
  }
  const made = await callApi(bot.token, 'createChatInviteLink', {
    chat_id: channel.chatId, name: INVITE_LINK_NAME, creates_join_request: true,
  });
  if (!made.ok || !made.result?.invite_link) {
    return db.telegramChannels.setInviteLink({ chatId: channel.chatId, error: `Could not make an invite link: ${made.error || 'no link returned'}` });
  }
  return db.telegramChannels.setInviteLink({
    chatId: channel.chatId, inviteLink: made.result.invite_link, botId: bot.botId,
  });
}

/** The `telegram-channel-links` job: every channel switched on, checked. */
export async function refreshInviteLinks() {
  const channels = await db.telegramChannels.activeChannels();
  if (!channels.length) return 0;
  const bot = await miniAppBot();
  for (const channel of channels) await ensureInviteLink(channel, bot);
  return channels.length;
}

let _reading = false;

/**
 * The `telegram-join-requests` job: read each saved bot's new join requests
 * and record the ones for our channels. Every bot is read, so a request that
 * reached a standby is not lost; recording is idempotent. A bot's reading
 * moves forward only after its requests are written.
 */
export async function readJoinRequests() {
  if (_reading) return 0;
  _reading = true;
  try {
    const channels = await db.telegramChannels.activeChannels();
    if (!channels.length) return 0;
    let recorded = 0;
    for (const bot of (await miniAppBots()).filter((b) => !b.suspended)) {
      const offset = await db.telegramChannels.updateOffset(bot.botId);
      const res = await callApi(bot.token, 'getUpdates', {
        offset, limit: UPDATES_PER_READ, timeout: 0, allowed_updates: ['chat_join_request'],
      });
      if (!res.ok) {
        console.warn(`[telegram] could not read join requests for @${bot.botUsername}: ${res.error}`);
        continue;
      }
      let next = offset;
      for (const update of res.result || []) {
        next = Math.max(next, Number(update.update_id) + 1);
        const jr = update.chat_join_request;
        if (!jr?.chat?.id || !jr?.from?.id) continue;
        const saved = await db.telegramChannels.recordJoinRequest({
          chatId: String(jr.chat.id), telegramUserId: String(jr.from.id),
          requestedAt: new Date(Number(jr.date || 0) * 1000 || Date.now()),
        });
        if (saved) recorded += 1;
      }
      if (next > offset) await db.telegramChannels.advanceOffset(bot.botId, next);
    }
    return recorded;
  } finally {
    _reading = false;
  }
}

/** Telegram's answers that mean the request is no longer there to approve. */
const REQUEST_GONE = /HIDE_REQUESTER_MISSING|USER_ID_INVALID|user not found/i;
/** …and the one that means the person is already in. */
const ALREADY_IN = /USER_ALREADY_PARTICIPANT/i;

const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Approve a channel's waiting requests, oldest first, up to
 * `APPROVE_PER_PRESS` (an admin's press; owner, 2026-10-21: requests are never
 * approved on their own). Stops at the first answer that is neither an
 * approval nor a request Telegram no longer holds, and says why.
 */
export async function approveWaiting({ chatId, by, limit = APPROVE_PER_PRESS }) {
  const channel = (await db.telegramChannels.listChannels()).find((c) => c.chatId === String(chatId));
  if (!channel) throw refusal(404, 'CHANNEL_UNKNOWN', 'That channel is not saved.');
  const bot = await miniAppBot();
  if (!bot) throw refusal(503, 'TELEGRAM_UNAVAILABLE', 'No bot is saved, so nothing can be approved.');

  const waiting = await db.telegramChannels.waitingRequests(channel.chatId, { limit });
  let approved = 0; let gone = 0; let stopped = null;
  for (const userId of waiting) {
    const res = await callApi(bot.token, 'approveChatJoinRequest', { chat_id: channel.chatId, user_id: Number(userId) });
    if (res.ok || ALREADY_IN.test(res.error || '')) {
      if (await db.telegramChannels.decideRequest({ chatId: channel.chatId, telegramUserId: userId, status: 'APPROVED', by })) approved += 1;
    } else if (REQUEST_GONE.test(res.error || '')) {
      if (await db.telegramChannels.decideRequest({ chatId: channel.chatId, telegramUserId: userId, status: 'GONE', by, error: res.error })) gone += 1;
    } else {
      stopped = res.retryAfter
        ? `Telegram asked us to wait ${res.retryAfter} s. Press again after that.`
        : `Telegram refused: ${res.error}. Check that @${bot.botUsername} is still an administrator of ${channel.title}.`;
      break;
    }
    if (APPROVE_GAP_MS > 0) await pause(APPROVE_GAP_MS);
  }
  const left = (await db.telegramChannels.listChannels()).find((c) => c.chatId === channel.chatId)?.waiting ?? 0;
  return { approved, gone, waiting: left, stopped };
}
