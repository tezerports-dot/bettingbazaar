// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The support desks over HTTP against a real database (CLAUDE.md §2,
 * "Support desks"; owner, 2026-10-21).
 *
 * What is protected here, and why each case exists:
 *   - one ticket per account per India day, held by the database;
 *   - a ticket is given a support Telegram account and a code, and its link
 *     opens that account with the code typed in;
 *   - someone else's ticket, another desk's, and a guessed id all answer 404;
 *   - an agent sees the mobile masked, and the full number only by a reveal
 *     that leaves a row;
 *   - a player-desk agent cannot reach a merchant ticket, and the other way;
 *   - the Dispute Manager's Telegram is offered only on the caller's own
 *     DISPUTED order.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { pgConfigured, applySchema, closePg, pgQuery } from '#db/client.js';
import { mountRouter, actor, merchantActor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

const DESCRIPTION = 'My bet on the 1 minute board shows no result after the round ended.';

describePg('support desks', () => {
  let playerApp; let merchantApp; let adminApp;
  let playerAgent; let merchantAgent;
  const tag = Math.random().toString(36).slice(2, 7);

  beforeAll(async () => {
    await applySchema();
    playerApp = mountRouter((await import('../../domains/support/support.routes.js')).default);
    merchantApp = mountRouter((await import('../../domains/support/merchantSupport.routes.js')).default);
    adminApp = express();
    adminApp.use(express.json());
    adminApp.use(cookieParser());
    adminApp.use('/admin', (await import('../../domains/support/supportDesk.admin.routes.js')).default);
    playerAgent = await actor({ isSubAdmin: true, permissions: { canManageSupportTickets: true } });
    merchantAgent = await actor({ isSubAdmin: true, permissions: { canManageMerchantSupport: true } });
    // One support account per desk, so every ticket below gets one.
    await pgQuery(`UPDATE support_contacts SET active = FALSE WHERE desk IN ('PLAYER', 'MERCHANT', 'DISPUTE')`);
    const admin = await actor({ isAdmin: true });
    for (const [desk, name] of [['PLAYER', `bbhelp_${tag}`], ['MERCHANT', `bbmerch_${tag}`], ['DISPUTE', `bbdispute_${tag}`]]) {
      const res = await as(adminApp, admin).post('/admin/support/contacts').send({ desk, telegramUsername: `@${name}` });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
  }, 60_000);

  afterAll(async () => { await closePg(); });

  const open = (app, who, body = {}) => as(app, who).post('/tickets')
    .send({ topic: 'BETS', description: DESCRIPTION, ...body });

  it('refuses every account route without a token', async () => {
    expect((await request(playerApp).post('/tickets').send({})).status).toBe(401);
    expect((await request(playerApp).get('/tickets')).status).toBe(401);
    expect((await request(playerApp).get('/desk')).status).toBe(401);
    expect((await request(merchantApp).get('/tickets')).status).toBe(401);
  });

  it('opens a ticket with a code and a Telegram link to its support account', async () => {
    const alice = await actor({});
    const res = await open(playerApp, alice, { reference: 'BET-123' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { ticket } = res.body;
    expect(ticket.code).toMatch(/^S-[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(ticket.telegramUsername).toBe(`bbhelp_${tag}`);
    expect(ticket.telegramLink).toBe(`https://t.me/bbhelp_${tag}?text=${encodeURIComponent(`Ticket ${ticket.code}`)}`);
    expect(ticket.reference).toBe('BET-123');
  });

  it('opens one ticket a day, and says so', async () => {
    const bob = await actor({});
    expect((await open(playerApp, bob)).status).toBe(200);
    const second = await open(playerApp, bob);
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('ONE_TICKET_A_DAY');
    expect(second.body.nextTicketAt).toBeTruthy();
    const desk = await as(playerApp, bob).get('/desk');
    expect(desk.body.openedToday).toBe(true);
  });

  it('refuses an unknown topic, a short description and a long reference', async () => {
    const carol = await actor({});
    expect((await open(playerApp, carol, { topic: 'POOL' })).status).toBe(400); // a merchant topic
    expect((await open(playerApp, carol, { description: 'too short' })).status).toBe(400);
    expect((await open(playerApp, carol, { reference: 'x'.repeat(65) })).status).toBe(400);
    // None of those used up the day's ticket.
    expect((await open(playerApp, carol)).status).toBe(200);
  });

  it('answers 404, never 403, for another account’s ticket', async () => {
    const owner = await actor({}); const other = await actor({});
    const id = (await open(playerApp, owner)).body.ticket.ticketId;
    expect((await as(playerApp, other).get(`/tickets/${id}`)).status).toBe(404);
    expect((await as(playerApp, owner).get(`/tickets/${id}`)).status).toBe(200);
    const mine = await as(playerApp, other).get('/tickets');
    expect(mine.body.tickets.map((t) => t.ticketId)).not.toContain(id);
  });

  it('shows an account only its last 7 days', async () => {
    const dave = await actor({});
    const id = (await open(playerApp, dave)).body.ticket.ticketId;
    await pgQuery(`UPDATE support_tickets SET created_at = now() - interval '8 days', opened_day = opened_day - 8 WHERE ticket_id = $1`, [id]);
    expect((await as(playerApp, dave).get('/tickets')).body.tickets).toHaveLength(0);
    expect((await as(playerApp, dave).get(`/tickets/${id}`)).status).toBe(404);
  });

  it('gives the agent a masked number, and the full one only by a logged reveal', async () => {
    const erin = await actor({});
    const id = (await open(playerApp, erin)).body.ticket.ticketId;

    const queue = await as(adminApp, playerAgent).get('/admin/support/tickets');
    expect(queue.status).toBe(200);
    const row = queue.body.tickets.find((t) => t.ticketId === id);
    expect(row.account.mobileMasked).toContain('•');
    expect(JSON.stringify(queue.body)).not.toContain(erin.mobile);

    const reveal = await as(adminApp, playerAgent).post(`/admin/support/tickets/${id}/reveal-number`);
    expect(reveal.status).toBe(200);
    expect(reveal.body.mobile).toBe(erin.mobile);
    const detail = await as(adminApp, playerAgent).get(`/admin/support/tickets/${id}`);
    expect(detail.body.reveals).toHaveLength(1);
    expect(detail.body.reveals[0].staffId).toBe(playerAgent.userId);
  });

  it('keeps each desk to its own agents', async () => {
    const frank = await actor({});
    const id = (await open(playerApp, frank)).body.ticket.ticketId;
    // The merchant-desk agent holds no player-desk permission…
    expect((await as(adminApp, merchantAgent).get('/admin/support/tickets')).status).toBe(403);
    // …and the merchant desk's routes do not find a player ticket by its id.
    expect((await as(adminApp, merchantAgent).get(`/admin/merchant-support/tickets/${id}`)).status).toBe(404);
    expect((await as(adminApp, merchantAgent).post(`/admin/merchant-support/tickets/${id}/reveal-number`)).status).toBe(404);
  });

  it('lets an agent note and resolve, and the player rate once', async () => {
    const gina = await actor({});
    const id = (await open(playerApp, gina)).body.ticket.ticketId;
    const note = await as(adminApp, playerAgent).post(`/admin/support/tickets/${id}/notes`).send({ content: 'Refunded the round, see your wallet.' });
    expect(note.status).toBe(200);
    expect(note.body.ticket.status).toBe('ASSIGNED');
    expect((await as(playerApp, gina).post(`/tickets/${id}/rate`).send({ rating: 5 })).status).toBe(409);
    const done = await as(adminApp, playerAgent).post(`/admin/support/tickets/${id}/status`).send({ status: 'RESOLVED' });
    expect(done.body.ticket.status).toBe('RESOLVED');
    const seen = await as(playerApp, gina).get(`/tickets/${id}`);
    expect(seen.body.messages.map((m) => m.senderType)).toEqual(['USER', 'AGENT']);
    expect((await as(playerApp, gina).post(`/tickets/${id}/rate`).send({ rating: 5 })).status).toBe(200);
    expect((await as(playerApp, gina).post(`/tickets/${id}/rate`).send({ rating: 4 })).status).toBe(409);
  });

  it('runs a separate merchant desk', async () => {
    const m = await merchantActor();
    const res = await open(merchantApp, m, { topic: 'POOL' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ticket.telegramUsername).toBe(`bbmerch_${tag}`);
    const id = res.body.ticket.ticketId;
    expect((await as(adminApp, merchantAgent).get(`/admin/merchant-support/tickets/${id}`)).status).toBe(200);
    expect((await as(adminApp, playerAgent).get(`/admin/support/tickets/${id}`)).status).toBe(404);
  });

  it('refuses a support account with a bad username, and a duplicate', async () => {
    const admin = await actor({ isAdmin: true });
    const bad = await as(adminApp, admin).post('/admin/support/contacts').send({ desk: 'PLAYER', telegramUsername: 'ab' });
    expect(bad.status).toBe(400);
    const dup = await as(adminApp, admin).post('/admin/support/contacts').send({ desk: 'PLAYER', telegramUsername: `BBHELP_${tag}` });
    expect(dup.status).toBe(409);
    // The player-desk agent cannot change who players chat with.
    expect((await as(adminApp, playerAgent).post('/admin/support/contacts').send({ desk: 'PLAYER', telegramUsername: 'someone_else' })).status).toBe(403);
  });

  it('offers the Dispute Manager’s Telegram only on the caller’s own disputed order', async () => {
    const hank = await actor({}); const ivy = await actor({});
    const orderId = `ord-sup-${tag}`;
    await pgQuery(
      `INSERT INTO order_states (order_id, user_id, state, order_type, currency, token_amount_paise, payment_mode, order_hmac)
       VALUES ($1, $2, 'DISPUTED', 'DEPOSIT', 'INR', 50000, 'CASH_ATM', 'x')`,
      [orderId, hank.userId],
    ).catch((e) => { throw new Error(`fixture order: ${e.message}`); });
    const mine = await as(playerApp, hank).get(`/dispute-contact/${orderId}`);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body.contact.telegramLink).toBe(`https://t.me/bbdispute_${tag}?text=${encodeURIComponent(`Dispute ${orderId}`)}`);
    expect((await as(playerApp, ivy).get(`/dispute-contact/${orderId}`)).status).toBe(404);
  });
});
