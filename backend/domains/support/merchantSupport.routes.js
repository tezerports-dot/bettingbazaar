// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/support/merchantSupport.routes.js — the merchant's support desk
 * (CLAUDE.md §2, "Support desks"), mounted at /api/merchant/support.
 *
 * Its own desk, queue and staff permission, apart from the players' (owner,
 * 2026-10-21). A ticket belongs to the LOGIN that opened it (`req.userId`: the
 * owner, or a merchant account's sub-member with their own Telegram); a
 * dispute contact is for an order assigned to this merchant.
 */
import express from 'express';
import { merchantAuth } from '../../middleware/merchantAuth.js';
import { accountSupportHandlers } from './accountSupport.js';

const router = express.Router();
const desk = accountSupportHandlers({
  desk: 'MERCHANT',
  // A merchant row made before merchants had a login of their own carries no
  // user id; its tickets are the merchant's.
  accountOf: (req) => req.userId || String(req.merchantId),
  orderOwner: (req) => ({ merchantId: String(req.merchantId) }),
  // A merchant may message support on Telegram without a ticket (owner, 2026-10-22).
  direct: true,
});

router.get('/desk', merchantAuth, desk.desk);
router.post('/tickets', merchantAuth, desk.openLimiter, desk.open);
router.get('/tickets', merchantAuth, desk.list);
router.get('/tickets/:ticketId', merchantAuth, desk.one);
router.post('/tickets/:ticketId/rate', merchantAuth, desk.rate);
router.get('/dispute-contact/:orderId', merchantAuth, desk.disputeContact);

export default router;
