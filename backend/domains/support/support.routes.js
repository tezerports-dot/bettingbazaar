// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/support/support.routes.js — the player's side of support.
 * Mounted at /api/support in server.js.
 *
 *   GET  /api/support/status              feature readiness (no secrets)
 *   POST /api/support/ask                 authenticated Q&A over the help centre
 *   POST /api/support/tickets             open a ticket
 *   GET  /api/support/tickets             the player's own tickets
 *   GET  /api/support/tickets/:ticketId   one ticket and its messages
 *   POST /api/support/tickets/:ticketId/reply
 *
 * ── Why the ticket routes exist ─────────────────────────────────────────────
 * They did not, and the admin side did. `db.social.openTicket`, `listTickets`,
 * `listTicketMessages` and `replyToTicket` were all written; the admin desk at
 * /api/admin/support/tickets could list, read and reply. There was simply no
 * way for a player to put anything INTO that queue, so agents worked a desk
 * nothing could reach.
 *
 * The user panel filled the hole with a fake. Its "Live Support" panel appended
 * a canned "an agent is looking into this and will reply here shortly", made no
 * network call at all, and displayed a hardcoded "Agent online · avg reply
 * 2 min". A player with a money problem was told help was coming and nothing
 * was sent anywhere.
 *
 * ── Ownership is the whole security surface here ────────────────────────────
 * A ticket is a private conversation about somebody's money. Every route below
 * loads the ticket and compares its user_id to the caller's before returning or
 * writing anything, and answers 404 rather than 403 on someone else's ticket —
 * a 403 confirms the id exists, which is itself a disclosure when ids are
 * guessable.
 */
import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { authenticate } from '../identity/auth.middleware.js';
import { db } from '#db';
import { answer, ragStatus } from './ragService.js';
import { serverError } from '../../shared/httpError.js';

const router = express.Router();

// Per-user limiter — the route is authenticated, so key by user id (fair, and it
// sidesteps the express-rate-limit v8 IPv6 keyGenerator pitfall). ipKeyGenerator
// is only the fallback for the theoretically-unauthenticated case.
const askLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RAG_ASK_RATE || 10),
  standardHeaders: true,
  legacyHeaders: false,
  // Key on `userId` — the ONLY identifier an authenticated request carries.
  // This read `req.user?._id`, a field the users table has never produced
  // (the row mapper emits `userId`), so the guard was always false and every
  // authenticated ask fell through to the IP key. Behind a proxy or a mobile
  // carrier NAT that is one shared 10/min budget: one player exhausts the
  // assistant for everybody on that egress address.
  keyGenerator: (req) => (req.user?.userId ? `u:${req.user.userId}` : ipKeyGenerator(req.ip)),
  message: { success: false, message: 'Too many support questions. Please wait a minute.' },
});

router.get('/status', async (req, res) => {
  try {
    res.json({ success: true, ...(await ragStatus()) });
  } catch (e) {
    return serverError(res, e, 'GET /api/support/status');
  }
});

router.post('/ask', authenticate, askLimiter, async (req, res) => {
  try {
    const { query, category, topK } = req.body || {};
    if (!query || !String(query).trim()) {
      return res.status(400).json({ success: false, message: 'query is required' });
    }
    const result = await answer({
      query: String(query).slice(0, 2000),
      category: category ? String(category).slice(0, 64) : null,
      topK: Number(topK) || 5,
    });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

// Opening a ticket writes a row per call, so it is limited like /ask.
const ticketLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.SUPPORT_TICKET_RATE || 5),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user?.userId ? `t:${req.user.userId}` : ipKeyGenerator(req.ip)),
  message: { success: false, message: 'Too many support requests. Please wait a minute.' },
});

/**
 * Load a ticket the caller owns, or nothing.
 *
 * 404 for someone else's ticket, never 403: a 403 confirms the id is real, and
 * ticket ids appear in URLs. The caller cannot tell "not yours" from "no such
 * ticket", which is the only safe answer to give.
 */
async function ownedTicket(ticketId, userId) {
  const ticket = await db.social.getTicket(String(ticketId));
  if (!ticket || String(ticket.userId) !== String(userId)) return null;
  return ticket;
}

router.post('/tickets', authenticate, ticketLimiter, async (req, res) => {
  try {
    const { subject, message, category } = req.body || {};
    if (!subject || !String(subject).trim()) {
      return res.status(400).json({ success: false, message: 'A subject is required.' });
    }
    const ticket = await db.social.openTicket({
      userId: req.user.userId,
      subject: String(subject).slice(0, 200).trim(),
      category: category ? String(category).slice(0, 32) : 'GENERAL',
    });

    // The opening message is part of the ticket, not a separate step: a ticket
    // with a subject and no body is one an agent has to ask about before they
    // can start, which is the delay the player came here to avoid.
    if (message && String(message).trim()) {
      await db.social.replyToTicket({
        ticketId: ticket.ticketId,
        senderId: req.user.userId,
        senderType: 'USER',
        content: String(message).slice(0, 4000).trim(),
      });
    }
    res.json({ success: true, ticket });
  } catch (e) {
    console.error('POST /support/tickets error:', e);
    res.status(500).json({ success: false, message: 'Could not open your support ticket.' });
  }
});

router.get('/tickets', authenticate, async (req, res) => {
  try {
    // Scoped by userId in the query, not filtered afterwards.
    const tickets = await db.social.listTickets({ userId: req.user.userId, limit: 50 });
    res.json({ success: true, tickets });
  } catch (e) {
    console.error('GET /support/tickets error:', e);
    res.status(500).json({ success: false, message: 'Could not load your tickets.' });
  }
});

router.get('/tickets/:ticketId', authenticate, async (req, res) => {
  try {
    const ticket = await ownedTicket(req.params.ticketId, req.user.userId);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
    const messages = await db.social.listTicketMessages(ticket.ticketId);
    res.json({ success: true, ticket, messages });
  } catch (e) {
    console.error('GET /support/tickets/:ticketId error:', e);
    res.status(500).json({ success: false, message: 'Could not load that ticket.' });
  }
});

router.post('/tickets/:ticketId/reply', authenticate, async (req, res) => {
  try {
    const { content } = req.body || {};
    if (!content || !String(content).trim()) {
      return res.status(400).json({ success: false, message: 'A message is required.' });
    }
    const ticket = await ownedTicket(req.params.ticketId, req.user.userId);
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket not found' });
    if (ticket.status === 'CLOSED') {
      return res.status(400).json({ success: false, message: 'This ticket is closed. Open a new one.' });
    }

    const saved = await db.social.replyToTicket({
      ticketId: ticket.ticketId,
      senderId: req.user.userId,
      // Stamped from the session, never from the body — a client that could
      // name itself AGENT could forge a reply from support.
      senderType: 'USER',
      content: String(content).slice(0, 4000).trim(),
    });
    res.json({ success: true, message: saved });
  } catch (e) {
    console.error('POST /support/tickets/:ticketId/reply error:', e);
    res.status(500).json({ success: false, message: 'Could not send your message.' });
  }
});

export default router;
