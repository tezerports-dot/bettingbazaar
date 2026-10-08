// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A security alert reaches every staff member who linked Telegram, by the one
 * bot, and nobody else (Step 3, owner 2026-10-07: "keep them for staff who
 * linked Telegram").
 *
 * It used to post to the staff CHANNEL through `activeConfig`, which the
 * channel removal deleted; the dynamic import then failed inside a catch and
 * every alert went nowhere, silently. Asserted here at Telegram's door (the
 * Bot API request), because the failure mode is a message never sent.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { saveTestBot, removeTestBot, linkTelegram, TEST_BOT_TOKEN } from '../miniAppFixture.js';
import { actor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('staff security alerts', () => {
  let staff; let blocked; let player;
  const sent = [];

  beforeAll(async () => {
    await applySchema();
    staff = await actor({ isAdmin: true });
    blocked = await actor({ isAdmin: true });
    player = await actor({});
    await linkTelegram(staff.userId, { telegramUserId: '7100000001' });
    await linkTelegram(blocked.userId, { telegramUserId: '7100000002' });
    await linkTelegram(player.userId, { telegramUserId: '7100000003' });
    await pgQuery(`UPDATE users SET is_blocked = TRUE, block_reason = 'alert test', blocked_at = now()
                    WHERE user_id = $1`, [blocked.userId]);
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }));
  });
  afterEach(async () => { sent.length = 0; await removeTestBot(); });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await pgQuery('DELETE FROM telegram_links WHERE user_id = ANY($1)', [[staff.userId, blocked.userId, player.userId]]);
    await closePg();
  });

  it('messages each linked, unblocked staff member, and no player', async () => {
    await saveTestBot();
    const { sendAlert } = await import('../../services/alerting.service.js');
    await sendAlert(`staff-alert-${Date.now()}`, 'test alert', { why: 'test' });
    const chats = sent.filter((s) => s.url.includes(`/bot${TEST_BOT_TOKEN}/sendMessage`)).map((s) => s.body.chat_id);
    expect(chats).toContain('7100000001');
    expect(chats).not.toContain('7100000002');
    expect(chats).not.toContain('7100000003');
  });

  it('sends nothing when no bot is configured', async () => {
    const { sendAlert } = await import('../../services/alerting.service.js');
    await sendAlert(`staff-alert-nobot-${Date.now()}`, 'test alert');
    expect(sent.filter((s) => s.url.includes('/sendMessage'))).toHaveLength(0);
  });
});
