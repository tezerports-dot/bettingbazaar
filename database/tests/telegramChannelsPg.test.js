// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Signup channels and their join requests (owner, 2026-10-21), against a REAL
 * PostgreSQL with Telegram's Bot API replaced by a recording stand-in.
 *
 * The properties: with no channel on nothing happens and Telegram is not
 * asked; a channel is saved only when our bot administers it; a request
 * Telegram reports is recorded once, only for our channels, and NEVER approved
 * by reading it; an admin's approval moves only waiting rows, records a
 * request Telegram no longer holds as GONE (so Verify asks again), and stops
 * at a refusal leaving the rest waiting; a bot's reading never goes backward;
 * a revoked link, or one another bot made, is replaced, and an outage keeps it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';

const calls = [];
let answers = {};
const BOT = { slot: 1, botId: '7000001', botUsername: 'TestBot', token: '7000001:test', suspended: false };
let bots = [BOT];

vi.mock('../../backend/domains/telegram/telegramClient.js', () => ({
  callApi: async (token, method, payload) => {
    calls.push({ token, method, payload });
    const a = answers[method];
    return typeof a === 'function' ? a(payload) : (a ?? { ok: false, error: `no answer for ${method}` });
  },
  miniAppBot: async () => bots.find((b) => !b.suspended) ?? null,
  miniAppBots: async () => bots,
}));

const describePg = pgConfigured() ? describe : describe.skip;

const RUN = String(Date.now()).slice(-9);
const chatA = `-100${RUN}1`;
const chatB = `-100${RUN}2`;
const stranger = `-100${RUN}9`;
const user = (n) => `${RUN}${n}`;

let svc;
let repo;

describePg('signup channels and join requests', () => {
  beforeAll(async () => {
    await applySchema();
    svc = await import('../../backend/domains/telegram/signupChannels.service.js');
    repo = await import('../repositories/telegramChannels.js');
  });

  beforeEach(() => {
    calls.length = 0;
    bots = [BOT];
    answers = {
      getChat: (p) => ({ ok: true, result: { id: Number(p.chat_id) || Number(chatA), type: 'channel', title: 'Bazaar News', username: 'bazaarnews' } }),
      getChatMember: { ok: true, result: { status: 'administrator', can_invite_users: true } },
      createChatInviteLink: { ok: true, result: { invite_link: `https://t.me/+L${RUN}a` } },
      editChatInviteLink: { ok: true, result: { is_revoked: false } },
    };
  });

  afterAll(async () => {
    await pgQuery('DELETE FROM telegram_join_requests WHERE chat_id = ANY($1)', [[chatA, chatB]]);
    await pgQuery('DELETE FROM telegram_channels WHERE chat_id = ANY($1)', [[chatA, chatB]]);
    await pgQuery('DELETE FROM telegram_update_offsets WHERE bot_id = ANY($1)', [[BOT.botId, '7000002']]);
    await closePg();
  });

  it('refuses a channel our bot does not administer, and saves nothing', async () => {
    answers.getChatMember = { ok: true, result: { status: 'member' } };
    await expect(svc.addChannel({ ref: chatA, by: 'admin' })).rejects.toMatchObject({ status: 400, code: 'BOT_NOT_ADMIN' });
    const { rows } = await pgQuery('SELECT 1 FROM telegram_channels WHERE chat_id = $1', [chatA]);
    expect(rows).toHaveLength(0);
  });

  it('refuses what is not a channel reference before asking Telegram', async () => {
    await expect(svc.addChannel({ ref: 'not a channel!', by: 'admin' })).rejects.toMatchObject({ code: 'CHANNEL_INVALID' });
    expect(calls).toHaveLength(0);
  });

  it('with no channel of ours on, a person is asked to join nothing', async () => {
    const before = await repo.channelsToJoin(user(1));
    expect(before.map((c) => c.chatId)).not.toContain(chatA);
  });

  it('saves a channel Telegram describes, with a join-request link, and asks a new person to join it', async () => {
    const saved = await svc.addChannel({ ref: chatA, by: 'admin' });
    expect(saved).toMatchObject({ chatId: chatA, title: 'Bazaar News', active: true, inviteLink: `https://t.me/+L${RUN}a`, linkBotId: BOT.botId });
    const made = calls.find((c) => c.method === 'createChatInviteLink');
    expect(made.payload).toMatchObject({ chat_id: chatA, creates_join_request: true });
    expect(made.payload).not.toHaveProperty('expire_date');
    expect((await repo.channelsToJoin(user(1))).map((c) => c.chatId)).toContain(chatA);
  });

  it('records a reported request once, only for our channels, and never approves it', async () => {
    const offset = await repo.updateOffset(BOT.botId);
    const updates = [
      { update_id: offset + 5, chat_join_request: { chat: { id: Number(chatA) }, from: { id: Number(user(1)) }, date: 1_760_000_000 } },
      { update_id: offset + 6, chat_join_request: { chat: { id: Number(stranger) }, from: { id: Number(user(2)) }, date: 1_760_000_000 } },
    ];
    answers.getUpdates = { ok: true, result: updates };
    expect(await svc.readJoinRequests()).toBe(1);
    // The same updates again (a reading that raced) write nothing new.
    await svc.readJoinRequests();
    const { rows } = await pgQuery('SELECT chat_id, status FROM telegram_join_requests WHERE telegram_user_id = ANY($1)', [[user(1), user(2)]]);
    expect(rows).toEqual([{ chat_id: chatA, status: 'PENDING' }]);
    expect(calls.some((c) => c.method === 'approveChatJoinRequest')).toBe(false);
    expect(calls.find((c) => c.method === 'getUpdates').payload.allowed_updates).toEqual(['chat_join_request']);
    expect(await repo.updateOffset(BOT.botId)).toBe(offset + 7);
    // A waiting request is not asked for again.
    expect((await repo.channelsToJoin(user(1))).map((c) => c.chatId)).not.toContain(chatA);
  });

  it('never moves a bot\'s reading backward', async () => {
    const at = await repo.updateOffset(BOT.botId);
    await repo.advanceOffset(BOT.botId, at - 3);
    expect(await repo.updateOffset(BOT.botId)).toBe(at);
  });

  it('approves waiting requests on an admin\'s press, records the gone ones, and stops at a refusal', async () => {
    for (const n of [3, 4, 5, 6]) {
      await repo.recordJoinRequest({ chatId: chatA, telegramUserId: user(n), requestedAt: new Date(Date.now() + n) });
    }
    answers.approveChatJoinRequest = (p) => {
      if (String(p.user_id) === user(4)) return { ok: false, status: 400, error: 'Bad Request: HIDE_REQUESTER_MISSING' };
      if (String(p.user_id) === user(5)) return { ok: false, status: 400, error: 'Bad Request: CHAT_ADMIN_REQUIRED' };
      return { ok: true, result: true };
    };
    const r = await svc.approveWaiting({ chatId: chatA, by: 'admin' });
    expect(r.approved).toBe(2); // user(1) and user(3), oldest first
    expect(r.gone).toBe(1);
    expect(r.stopped).toMatch(/CHAT_ADMIN_REQUIRED/);
    const { rows } = await pgQuery(
      'SELECT telegram_user_id, status, decided_by FROM telegram_join_requests WHERE chat_id = $1 ORDER BY telegram_user_id', [chatA],
    );
    const status = Object.fromEntries(rows.map((x) => [x.telegram_user_id, x.status]));
    expect(status).toEqual({ [user(1)]: 'APPROVED', [user(3)]: 'APPROVED', [user(4)]: 'GONE', [user(5)]: 'PENDING', [user(6)]: 'PENDING' });
    expect(rows.find((x) => x.telegram_user_id === user(1)).decided_by).toBe('admin');
    // Telegram no longer holds user(4)'s request, so their next Verify asks again.
    expect((await repo.channelsToJoin(user(4))).map((c) => c.chatId)).toContain(chatA);
    // A decided request is not decided again.
    expect(await repo.decideRequest({ chatId: chatA, telegramUserId: user(1), status: 'GONE', by: 'x' })).toBe(false);
  });

  it('a new request from someone approved stays approved; from someone gone, waits again', async () => {
    await repo.recordJoinRequest({ chatId: chatA, telegramUserId: user(1), requestedAt: new Date() });
    await repo.recordJoinRequest({ chatId: chatA, telegramUserId: user(4), requestedAt: new Date() });
    const { rows } = await pgQuery(
      'SELECT telegram_user_id, status FROM telegram_join_requests WHERE chat_id = $1 AND telegram_user_id = ANY($2)', [chatA, [user(1), user(4)]],
    );
    expect(Object.fromEntries(rows.map((x) => [x.telegram_user_id, x.status]))).toEqual({ [user(1)]: 'APPROVED', [user(4)]: 'PENDING' });
  });

  it('keeps a link Telegram honours, keeps it through an outage, and replaces a revoked one', async () => {
    const [channel] = (await repo.listChannels()).filter((c) => c.chatId === chatA);
    await svc.ensureInviteLink(channel, BOT);
    expect(calls.map((c) => c.method)).toEqual(['editChatInviteLink']);
    calls.length = 0;

    answers.editChatInviteLink = { ok: false, status: 502, error: 'Bad Gateway' };
    const kept = await svc.ensureInviteLink(channel, BOT);
    expect(kept.inviteLink).toBe(channel.inviteLink);
    expect(kept.linkError).toMatch(/Bad Gateway/);

    answers.editChatInviteLink = { ok: true, result: { is_revoked: true } };
    answers.createChatInviteLink = { ok: true, result: { invite_link: `https://t.me/+L${RUN}b` } };
    const replaced = await svc.ensureInviteLink(channel, BOT);
    expect(replaced.inviteLink).toBe(`https://t.me/+L${RUN}b`);
    expect(replaced.linkError).toBe('');
  });

  it('a link another bot made is replaced by the bot in use', async () => {
    const standby = { ...BOT, slot: 2, botId: '7000002', botUsername: 'Standby', token: '7000002:test' };
    const [channel] = (await repo.listChannels()).filter((c) => c.chatId === chatA);
    answers.createChatInviteLink = { ok: true, result: { invite_link: `https://t.me/+L${RUN}c` } };
    const r = await svc.ensureInviteLink(channel, standby);
    expect(calls.map((c) => c.method)).toEqual(['createChatInviteLink']);
    expect(r).toMatchObject({ inviteLink: `https://t.me/+L${RUN}c`, linkBotId: '7000002' });
  });

  it('a channel switched off is asked of nobody; several on are all asked', async () => {
    answers.getChat = { ok: true, result: { id: Number(chatB), type: 'channel', title: 'Bazaar Two', username: '' } };
    answers.createChatInviteLink = { ok: true, result: { invite_link: `https://t.me/+L${RUN}d` } };
    await svc.addChannel({ ref: chatB, by: 'admin' });
    const both = (await repo.channelsToJoin(user(8))).map((c) => c.chatId);
    expect(both).toEqual(expect.arrayContaining([chatA, chatB]));

    await repo.setChannelActive({ chatId: chatA, active: false, by: 'admin' });
    const one = (await repo.channelsToJoin(user(8))).map((c) => c.chatId);
    expect(one).toContain(chatB);
    expect(one).not.toContain(chatA);
  });

  it('the row refuses an id or link that is not Telegram\'s shape', async () => {
    await expect(pgQuery(`INSERT INTO telegram_channels (chat_id, title) VALUES ('12345', 'x')`)).rejects.toThrow(/telegram_channels_chat_id_shape/);
    await expect(pgQuery('UPDATE telegram_channels SET invite_link = $2 WHERE chat_id = $1', [chatB, 'https://evil.example/+x']))
      .rejects.toThrow(/telegram_channels_link_shape/);
  });
});
