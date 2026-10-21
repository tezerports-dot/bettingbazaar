// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/support/accountSupport.routes.js — an account's own side of a
 * support desk (CLAUDE.md §2, "Support desks"). One router per desk:
 *
 *   player    /api/support/...          (support.routes.js)
 *   merchant  /api/merchant/support/... (merchantSupport.routes.js)
 *
 *   GET  /desk                    topics, whether a ticket was opened today
 *   POST /tickets                 open a ticket (one per India day)
 *   GET  /tickets                 own tickets, last ACCOUNT_HISTORY_DAYS
 *   GET  /tickets/:ticketId       one, with the agent's notes
 *   POST /tickets/:ticketId/rate  1-5, once, after it is resolved
 *   GET  /dispute-contact/:orderId  the Dispute Manager's Telegram, on a DISPUTED order
 *
 * The conversation is on Telegram (the ticket's `telegramLink`), so there is no
 * reply route: what the account adds, it adds in that chat.
 *
 * Someone else's ticket, another desk's, and one older than the window all
 * answer 404: ticket ids travel in URLs, and a 403 would confirm which are real.
 */
import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { db } from '#db';
import { createRateLimitStore } from '../../middleware/redisRateLimitStore.js';
import { respondError, refusal } from '../../shared/httpError.js';

const {
  TICKET_TOPICS, ACCOUNT_HISTORY_DAYS, DESCRIPTION_MIN, DESCRIPTION_MAX, REFERENCE_MAX,
} = db.supportDesk;

/**
 * @param {object} o
 * @param {'PLAYER'|'MERCHANT'} o.desk
 * @param {import('express').RequestHandler} o.authenticate
 * @param {(req: import('express').Request) => string} o.accountOf  the signed-in login's user id
 * @param {(req: import('express').Request) => object} o.orderOwner  `{ userId }` or `{ merchantId }`
 */
export function accountSupportRouter({ desk, authenticate, accountOf, orderOwner }) {
  const router = express.Router();
  const topics = TICKET_TOPICS[desk];
  const topicKeys = new Set(topics.map((t) => t.key));

  // A ticket a day is the database's rule; this only stops a script hammering
  // the door while it is refused.
  const openLimiter = rateLimit({
    windowMs: 60_000,
    store: createRateLimitStore(`rl:supportticket:${desk}:`),
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (accountOf(req) ? `t:${accountOf(req)}` : ipKeyGenerator(req.ip)),
    message: { success: false, message: 'Too many support requests. Please wait a minute.' },
  });

  router.get('/desk', authenticate, async (req, res) => {
    try {
      const today = await db.supportDesk.openedToday({ userId: accountOf(req) });
      res.json({
        success: true, topics, historyDays: ACCOUNT_HISTORY_DAYS,
        descriptionMin: DESCRIPTION_MIN, descriptionMax: DESCRIPTION_MAX, referenceMax: REFERENCE_MAX,
        ...today,
      });
    } catch (e) { return respondError(res, e, `GET support/desk ${desk}`); }
  });

  router.post('/tickets', authenticate, openLimiter, async (req, res) => {
    try {
      const { topic, reference = '', description } = req.body || {};
      if (!topicKeys.has(topic)) throw refusal(400, 'UNKNOWN_TOPIC', 'Pick what your problem is about.');
      const text = String(description ?? '').trim();
      if (text.length < DESCRIPTION_MIN) {
        throw refusal(400, 'DESCRIPTION_TOO_SHORT', `Tell us what happened in at least ${DESCRIPTION_MIN} characters.`);
      }
      if (text.length > DESCRIPTION_MAX) {
        throw refusal(400, 'DESCRIPTION_TOO_LONG', `Keep it under ${DESCRIPTION_MAX} characters.`);
      }
      const ref = String(reference ?? '').trim();
      if (ref.length > REFERENCE_MAX) throw refusal(400, 'REFERENCE_TOO_LONG', `A reference is at most ${REFERENCE_MAX} characters.`);

      const opened = await db.supportDesk.openTicket({
        userId: accountOf(req), desk, topic, reference: ref, description: text,
      });
      if (!opened.ok) {
        const { nextTicketAt } = await db.supportDesk.openedToday({ userId: accountOf(req) });
        return res.status(429).json({
          success: false, code: 'ONE_TICKET_A_DAY', nextTicketAt,
          message: 'You can open one support ticket a day. Continue in your Telegram chat about today\'s ticket.',
        });
      }
      res.json({ success: true, ticket: opened.ticket });
    } catch (e) { return respondError(res, e, `POST support/tickets ${desk}`); }
  });

  router.get('/tickets', authenticate, async (req, res) => {
    try {
      const tickets = await db.supportDesk.accountTickets({ userId: accountOf(req), desk });
      res.json({ success: true, tickets, historyDays: ACCOUNT_HISTORY_DAYS });
    } catch (e) { return respondError(res, e, `GET support/tickets ${desk}`); }
  });

  router.get('/tickets/:ticketId', authenticate, async (req, res) => {
    try {
      const found = await db.supportDesk.accountTicket({ ticketId: req.params.ticketId, userId: accountOf(req), desk });
      if (!found) return res.status(404).json({ success: false, message: 'Ticket not found' });
      res.json({ success: true, ...found });
    } catch (e) { return respondError(res, e, `GET support/tickets/:id ${desk}`); }
  });

  router.post('/tickets/:ticketId/rate', authenticate, async (req, res) => {
    try {
      const rating = Number(req.body?.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw refusal(400, 'RATING_RANGE', 'A rating is 1 to 5.');
      const ok = await db.supportDesk.rateTicket({ ticketId: req.params.ticketId, userId: accountOf(req), desk, rating });
      if (!ok) throw refusal(409, 'NOT_RATEABLE', 'You can rate a ticket once, after it is resolved.');
      res.json({ success: true });
    } catch (e) { return respondError(res, e, `POST support/tickets/:id/rate ${desk}`); }
  });

  router.get('/dispute-contact/:orderId', authenticate, async (req, res) => {
    try {
      const found = await db.supportDesk.disputeContactFor({ orderId: req.params.orderId, ...orderOwner(req) });
      if (!found.disputed) return res.status(404).json({ success: false, message: 'No dispute on that order' });
      res.json({ success: true, contact: found.contact });
    } catch (e) { return respondError(res, e, `GET support/dispute-contact ${desk}`); }
  });

  return router;
}
