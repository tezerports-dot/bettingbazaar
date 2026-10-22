// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Cold storage (owner, 2026-10-20): an ended order's old chat and a player's
 * old notifications leave the live tables and are kept whole in
 * `cold_archive`, append-only; a live order's chat, a recent message and a
 * recent notification stay. Against a real database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { archiveOldChats, archiveOldNotifications, listArchive, getArchiveEntry } from '../repositories/coldArchive.js';

const describePg = pgConfigured() ? describe : describe.skip;

async function order(state, extra = '') {
  const id = `ORD-COLD-${randomUUID().slice(0, 8)}`;
  await pgQuery(
    `INSERT INTO order_states (order_id, user_id, order_type, state, token_amount_paise, fiat_amount_paise${extra ? ', dispute_window_until' : ''})
     VALUES ($1, $2, 'DEPOSIT', $3, 50000, 50000${extra ? `, ${extra}` : ''})`,
    [id, `u-${id}`, state],
  );
  return id;
}
const say = (orderId, daysAgo, text = 'hello') => pgQuery(
  `INSERT INTO chat_messages (order_id, sender_id, sender_type, message, created_at)
   VALUES ($1, 'u', 'USER', $2, now() - make_interval(days => $3)) RETURNING id`, [orderId, text, daysAgo]);
const chatOf = async (orderId) => (await pgQuery('SELECT message FROM chat_messages WHERE order_id = $1 ORDER BY id', [orderId])).rows.map((r) => r.message);
const coldOf = async (kind, ref) => (await pgQuery('SELECT * FROM cold_archive WHERE kind = $1 AND ref = $2', [kind, ref])).rows;

describePg('cold storage', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });

  it('moves an ended order\'s old chat whole, and leaves live and recent chats', async () => {
    const done = await order('COMPLETED');
    await say(done, 45, 'first'); await say(done, 40, 'second');
    const live = await order('DISPUTED');
    await say(live, 60, 'still disputed');
    const recent = await order('CANCELLED');
    await say(recent, 50, 'old'); await say(recent, 2, 'new');
    const inWindow = await order('REJECTED', "now() + interval '1 hour'");
    await say(inWindow, 45, 'can still be disputed');

    for (;;) { const { orders } = await archiveOldChats({ days: 30 }); if (!orders) break; }

    expect(await chatOf(done)).toEqual([]);
    const [entry] = await coldOf('CHAT', done);
    expect(entry.row_count).toBe(2);
    expect(entry.rows.map((r) => r.row.message)).toEqual(['first', 'second']);
    expect(entry.rows.every((r) => r.table === 'chat_messages')).toBe(true);
    expect(await chatOf(live)).toEqual(['still disputed']);
    expect(await chatOf(recent)).toEqual(['old', 'new']);
    expect(await chatOf(inWindow)).toEqual(['can still be disputed']);
    expect(await coldOf('CHAT', live)).toEqual([]);
  });

  it('moves old notifications per player and keeps recent ones', async () => {
    const user = `u-cold-${randomUUID().slice(0, 8)}`;
    const note = (daysAgo, title) => pgQuery(
      `INSERT INTO notifications (user_id, title, created_at) VALUES ($1, $2, now() - make_interval(days => $3))`,
      [user, title, daysAgo]);
    await note(40, 'old one'); await note(35, 'old two'); await note(1, 'fresh');

    for (;;) { const { notifications } = await archiveOldNotifications({ days: 30 }); if (!notifications) break; }

    const { rows } = await pgQuery('SELECT title FROM notifications WHERE user_id = $1', [user]);
    expect(rows.map((r) => r.title)).toEqual(['fresh']);
    const cold = await coldOf('NOTIFICATION', user);
    expect(cold.flatMap((c) => c.rows.map((r) => r.row.title)).sort()).toEqual(['old one', 'old two']);

    const page = await listArchive({ kind: 'NOTIFICATION', ref: user });
    expect(page.entries.length).toBe(cold.length);
    expect(page.entries[0]).not.toHaveProperty('rows');
    expect((await getArchiveEntry(page.entries[0].id)).rows.length).toBe(page.entries[0].rowCount);
  });

  it('is append-only, and refuses an unknown kind by name', async () => {
    const [{ id }] = (await pgQuery('SELECT id FROM cold_archive ORDER BY id DESC LIMIT 1')).rows;
    await expect(pgQuery('UPDATE cold_archive SET ref = ref WHERE id = $1', [id])).rejects.toThrow(/append-only/);
    await expect(pgQuery('DELETE FROM cold_archive WHERE id = $1', [id])).rejects.toThrow(/append-only/);
    await expect(listArchive({ kind: 'BETS' })).rejects.toMatchObject({ status: 400, code: 'UNKNOWN_KIND' });
  });
});
