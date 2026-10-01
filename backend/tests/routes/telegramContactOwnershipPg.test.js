// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * A contact share proves a number only when the contact is the SENDER'S OWN.
 *
 * ── The defect (R6, 2026-09-30) ─────────────────────────────────────────────
 * The webhook refused a contact whose `user_id` differed from the sender's —
 * and skipped the check when `user_id` was ABSENT. A contact card from a
 * phone's address book, for a number that is not matched to a Telegram
 * account, arrives with no `user_id` at all. So anybody could send a contact
 * card carrying a victim's mobile, be linked to the victim's account as its
 * verified Telegram, and then press the password-reset button the bot offers
 * to exactly that link: an account takeover of any account not yet verified.
 *
 * The `request_contact` button — the only way this bot asks for a number —
 * always carries the sender's own `user_id`, so requiring it costs a real
 * player nothing.
 *
 * Driven through the real webhook with a bot seeded directly (the way the
 * browser pass seeds one: `registerBot` would ask Telegram to verify the
 * token). Outbound replies fail against the fake token; the assertions are on
 * the rows, which is what the reply would have been about.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { encryptField } from '../../domains/identity/fieldCrypto.util.js';
import { actor } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

const BOT_ID = `rt-contact-bot-${process.pid}`;
const SECRET = 'rt-contact-secret';

describePg('a contact share must be the sender\'s own', () => {
  let app;
  const tgIds = [];

  const share = (fromId, contact) => {
    tgIds.push(String(fromId));
    return request(app).post(`/api/telegram/webhook/${BOT_ID}`)
      .set('X-Telegram-Bot-Api-Secret-Token', SECRET)
      .send({ update_id: Date.now(), message: {
        message_id: 1, date: Math.floor(Date.now() / 1000),
        from: { id: fromId, is_bot: false, first_name: 'RT' },
        chat: { id: fromId, type: 'private' },
        contact,
      } });
  };
  // The webhook answers Telegram FIRST and handles the update after, so the
  // row appears some milliseconds later. A link is polled for; the absence of
  // one is only believed after the full window (the old code linked in ~120ms).
  const linkedTo = async (telegramUserId, { waitMs = 2000 } = {}) => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const rows = (await pgQuery(
        `SELECT user_id FROM telegram_identities WHERE telegram_user_id = $1 AND audience = 'PLAYER'`,
        [String(telegramUserId)])).rows.map((r) => r.user_id);
      if (rows.length || Date.now() > deadline) return rows;
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  beforeAll(async () => {
    await applySchema();
    await pgQuery(
      `INSERT INTO telegram_bots (bot_id, label, role, audience, username,
                                  token_encrypted, webhook_secret, status, activated_at)
       VALUES ($1, 'route test', 'signin', 'PLAYER', $2, $3, $4, 'ACTIVE', now())
       ON CONFLICT (bot_id) DO NOTHING`,
      [BOT_ID, `rt_contact_${process.pid}`, encryptField('0:rt-contact'), SECRET]);
    app = express();
    app.use(express.json());
    app.use('/api/telegram', (await import('../../domains/telegram/telegram.routes.js')).default);
  }, 60_000);

  afterAll(async () => {
    await pgQuery(`DELETE FROM telegram_identities WHERE telegram_user_id = ANY($1)`, [tgIds]).catch(() => {});
    await pgQuery(`DELETE FROM telegram_bots WHERE bot_id = $1`, [BOT_ID]).catch(() => {});
    await closePg();
  });

  it('does NOT link somebody who shares a contact card of another person\'s number with no user_id', async () => {
    const victim = await actor({});
    const attacker = 700000000 + Math.floor(Math.random() * 99_999_999);
    await share(attacker, { phone_number: `+91${victim.mobile}`, first_name: 'Victim' });
    expect(await linkedTo(attacker)).toEqual([]);
  });

  it('does NOT link a forwarded contact that names a different Telegram user', async () => {
    const victim = await actor({});
    const attacker = 700000000 + Math.floor(Math.random() * 99_999_999);
    await share(attacker, { phone_number: `+91${victim.mobile}`, first_name: 'Victim', user_id: attacker + 1 });
    expect(await linkedTo(attacker)).toEqual([]);
  });

  it('links a player who shares their OWN contact through the button', async () => {
    const player = await actor({});
    const tg = 700000000 + Math.floor(Math.random() * 99_999_999);
    await share(tg, { phone_number: `+91${player.mobile}`, first_name: 'Me', user_id: tg });
    expect(await linkedTo(tg)).toEqual([player.userId]);
  });
});
