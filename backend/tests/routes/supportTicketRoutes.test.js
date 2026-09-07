// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The player's side of support, over HTTP against a real database.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * These routes did not exist and the admin side did. openTicket, listTickets,
 * listTicketMessages and replyToTicket were all written, and the admin desk
 * could list, read and reply — but nothing could put a ticket INTO that queue,
 * so agents worked a desk no player could reach.
 *
 * The panel filled the hole with a fake: a canned "an agent is looking into
 * this and will reply here shortly", no network call at all, and a hardcoded
 * "Agent online · avg reply 2 min".
 *
 * ── What is actually being protected ────────────────────────────────────────
 * A ticket is a private conversation about somebody's money. The ownership
 * cases below are the point of this file; the happy path is the easy part.
 * Reading another player's ticket must be indistinguishable from a ticket that
 * does not exist, because ticket ids travel in URLs and a 403 would confirm
 * which ids are real.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pgConfigured, applySchema, closePg } from '#db/client.js';
import { listTicketMessages, listTickets } from '#db/repositories/social.js';
import { mountRouter, actor, as, request } from './_harness.js';

const describePg = pgConfigured() ? describe : describe.skip;

describePg('player support tickets', () => {
  let app;

  beforeAll(async () => {
    await applySchema();
    const mod = await import('../../domains/support/support.routes.js');
    app = mountRouter(mod.default);
  }, 60_000);

  afterAll(async () => { await closePg(); });

  /**
   * A fresh player per test.
   *
   * Opening a ticket is rate-limited per user (SUPPORT_TICKET_RATE, 5/min), and
   * sharing one actor across the file exhausted it partway through — the later
   * cases failed on a 429 that had nothing to do with what they were asserting.
   * A new actor also means no test can see another's tickets by accident, which
   * is the property half of them are about.
   */
  const player = () => actor({});
  const open = (who, body) => as(app, who).post('/tickets').send(body);

  it('refuses every ticket route without a token', async () => {
    expect((await request(app).post('/tickets').send({ subject: 'x' })).status).toBe(401);
    expect((await request(app).get('/tickets')).status).toBe(401);
    expect((await request(app).get('/tickets/anything')).status).toBe(401);
    expect((await request(app).post('/tickets/anything/reply').send({ content: 'x' })).status).toBe(401);
  });

  it('opens a ticket and stores the opening message with it', async () => {
    const alice = await player();
    // A ticket with a subject and no body is one an agent must ask about before
    // they can start — the delay the player came here to avoid.
    const res = await open(alice, { subject: 'Deposit not credited', message: 'UTR 123456789012, paid 20 minutes ago.' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ticket.subject).toBe('Deposit not credited');

    const messages = await listTicketMessages(res.body.ticket.ticketId);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toMatch(/UTR 123456789012/);
    expect(messages[0].senderType).toBe('USER');
  });

  it('refuses a ticket with no subject', async () => {
    const alice = await player();
    expect((await open(alice, { message: 'help' })).status).toBe(400);
    expect((await open(alice, { subject: '   ' })).status).toBe(400);
  });

  it('lists only the caller’s own tickets', async () => {
    const alice = await player(); const mallory = await player();
    const mine = await open(alice, { subject: 'Mine only' });
    await open(mallory, { subject: 'Not yours' });

    const res = await as(app, alice).get('/tickets');
    expect(res.status).toBe(200);
    const ids = res.body.tickets.map((t) => t.ticketId);
    expect(ids).toContain(mine.body.ticket.ticketId);
    // Scoped in the query, not filtered after the fact.
    const subjects = res.body.tickets.map((t) => t.subject);
    expect(subjects).not.toContain('Not yours');
  });

  it('answers 404 — never 403 — for another player’s ticket', async () => {
    const alice = await player(); const mallory = await player();
    // A 403 confirms the id is real. Ticket ids travel in URLs, so "not yours"
    // and "no such ticket" must be the same answer.
    const theirs = await open(mallory, { subject: 'Private' });
    const id = theirs.body.ticket.ticketId;

    const read = await as(app, alice).get(`/tickets/${id}`);
    expect(read.status).toBe(404);

    const reply = await as(app, alice).post(`/tickets/${id}/reply`).send({ content: 'let me in' });
    expect(reply.status).toBe(404);

    // …and nothing was written to it.
    expect(await listTicketMessages(id)).toHaveLength(0);
  });

  it('returns a ticket with its messages to its owner', async () => {
    const alice = await player();
    const t = await open(alice, { subject: 'Withdrawal stuck', message: 'first' });
    const id = t.body.ticket.ticketId;
    await as(app, alice).post(`/tickets/${id}/reply`).send({ content: 'second' });

    const res = await as(app, alice).get(`/tickets/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m) => m.content)).toEqual(['first', 'second']);
  });

  it('stamps senderType from the session, so a client cannot forge an agent', async () => {
    const alice = await player();
    // A player who could name themselves AGENT could write a reply that reads
    // as coming from support — inside a conversation about their own money.
    const t = await open(alice, { subject: 'Forge attempt' });
    const id = t.body.ticket.ticketId;
    await as(app, alice).post(`/tickets/${id}/reply`).send({ content: 'trust me', senderType: 'AGENT' });

    const messages = await listTicketMessages(id);
    expect(messages.every((m) => m.senderType === 'USER')).toBe(true);
  });

  it('refuses an empty reply', async () => {
    const alice = await player();
    const t = await open(alice, { subject: 'Empty' });
    const id = t.body.ticket.ticketId;
    for (const body of [{}, { content: '' }, { content: '   ' }]) {
      expect((await as(app, alice).post(`/tickets/${id}/reply`).send(body)).status).toBe(400);
    }
  });

  it('does not let a player reply to a closed ticket', async () => {
    const alice = await player();
    const t = await open(alice, { subject: 'To be closed' });
    const id = t.body.ticket.ticketId;
    const { setTicketStatus } = await import('#db/repositories/social.js');
    await setTicketStatus(id, 'CLOSED');

    const res = await as(app, alice).post(`/tickets/${id}/reply`).send({ content: 'reopen please' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/closed/i);
  });

  it('rate-limits ticket opening per player', async () => {
    // Each call writes a row, so this is the guard against one account filling
    // the agents' queue. Asserted rather than worked around: sharing an actor
    // across this file tripped it, and a limit nobody tests is one that can be
    // removed without anything noticing.
    const spammer = await player();
    const codes = [];
    for (let i = 0; i < 8; i += 1) {
      codes.push((await open(spammer, { subject: `spam ${i}` })).status);
    }
    expect(codes).toContain(429);
    // …and a different player is unaffected, so the key really is the user.
    const bystander = await player();
    expect((await open(bystander, { subject: 'unaffected' })).status).toBe(200);
  });

  it('puts the ticket where the admin desk will find it', async () => {
    const alice = await player();
    // The whole point: the queue agents work must now have an input.
    const t = await open(alice, { subject: 'Reaches the desk' });
    const all = await listTickets({ limit: 500 });
    expect(all.some((x) => x.ticketId === t.body.ticket.ticketId)).toBe(true);
  });
});
