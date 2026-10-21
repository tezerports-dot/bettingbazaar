// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/support/support.routes.js — the player's side of support.
 * Mounted at /api/support in server.js.
 *
 *   GET  /api/support/status              feature readiness (no secrets)
 *   POST /api/support/ask                 authenticated Q&A over the help centre
 *   GET  /api/support/desk                topics; whether today's ticket is used
 *   POST /api/support/tickets             open a ticket (one per India day)
 *   GET  /api/support/tickets             own tickets, last 7 days
 *   GET  /api/support/tickets/:ticketId   one, with the agent's notes
 *   POST /api/support/tickets/:ticketId/rate
 *   GET  /api/support/dispute-contact/:orderId  the Dispute Manager's Telegram
 *        (handlers: accountSupport.js)
 *
 * Tickets are a form plus a Telegram chat with the support account the ticket
 * was given (owner, 2026-10-21); the old in-app reply thread is gone.
 */
import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { authenticatePlayer } from '../identity/auth.middleware.js';
import { createRateLimitStore } from '../../middleware/redisRateLimitStore.js';
import { answer, ragStatus } from './ragService.js';
import { serverError, respondError } from '../../shared/httpError.js';
import { accountSupportHandlers } from './accountSupport.js';

const router = express.Router();

// Per-user limiter — the route is authenticated, so key by user id (fair, and it
// sidesteps the express-rate-limit v8 IPv6 keyGenerator pitfall). ipKeyGenerator
// is only the fallback for the theoretically-unauthenticated case.
const askLimiter = rateLimit({
  windowMs: 60_000,
  store: createRateLimitStore('rl:supportask:'),   // shared across workers (§36)
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

router.post('/ask', authenticatePlayer, askLimiter, async (req, res) => {
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
    return respondError(res, e, 'POST /support/ask');
  }
});

// The player's support desk (CLAUDE.md §2, "Support desks"): the form, the
// day's one ticket, the Telegram chat it opens, and the Dispute Manager's
// Telegram on a disputed order.
const desk = accountSupportHandlers({
  desk: 'PLAYER',
  accountOf: (req) => req.user?.userId,
  orderOwner: (req) => ({ userId: req.user.userId }),
});
router.get('/desk', authenticatePlayer, desk.desk);
router.post('/tickets', authenticatePlayer, desk.openLimiter, desk.open);
router.get('/tickets', authenticatePlayer, desk.list);
router.get('/tickets/:ticketId', authenticatePlayer, desk.one);
router.post('/tickets/:ticketId/rate', authenticatePlayer, desk.rate);
router.get('/dispute-contact/:orderId', authenticatePlayer, desk.disputeContact);

export default router;
