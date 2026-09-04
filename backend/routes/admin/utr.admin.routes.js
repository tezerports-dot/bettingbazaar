// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * utr.admin.routes.js — the bank-reference anti-fraud control, from an
 * operator's side.
 *
 * A UTR is the reference a player quotes to prove they paid. One reference
 * belongs to one order, enforced by the registry's primary key: reusing one is
 * either a mistake or a fraud attempt, and both are refused by the same index.
 *
 * ── Two things this file used to get wrong ──────────────────────────────────
 *
 * 1. FLAGGING WAS UNATTRIBUTED. `{ $set: { status: 'FRAUD' } }` — no actor, no
 *    reason. A fraud marking nobody signed is one nobody can defend in a
 *    dispute, and it blocks a real customer who then has nobody to appeal to.
 *    `flagFraud` requires both, and the row insists.
 *
 * 2. THE RESOLVE ROUTE CALLED `.save()` ON A PLAIN OBJECT. It read the order
 *    through the repository, mutated seven fields on the returned object, and
 *    called a method that does not exist — so every fraud resolution threw a
 *    TypeError after appearing to do its work.
 */
import { express, authenticate, isAdmin } from './_adminShared.js';
import { db } from '#db';
import { cancelOrder as cancelOrderState } from '../../domains/payment/orderLifecycle.service.js';

const router = express.Router();

// ─── GET /api/admin/utr-registry ─────────────────────────────────────────────
// The registry, filterable by status (ACTIVE | RELEASED | FRAUD).
router.get('/utr-registry', authenticate, isAdmin, async (req, res) => {
  try {
    const { status, limit = 50, page = 1 } = req.query;
    // Page and total from one query, with the player and order joined rather
    // than populated per row.
    const result = await db.utr.listRegistry({ status, page, limit });
    res.json({
      success: true,
      entries: result.entries,
      pagination: { total: result.total, page: result.page, limit: result.limit },
    });
  } catch (error) {
    console.error('GET /utr-registry error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch UTR registry' });
  }
});

// ─── GET /api/admin/utr-registry/:utr ────────────────────────────────────────
router.get('/utr-registry/:utr', authenticate, isAdmin, async (req, res) => {
  try {
    const entry = await db.utr.getRegistryEntry(req.params.utr);
    if (!entry) return res.status(404).json({ success: false, message: 'UTR not found in registry' });
    res.json({ success: true, entry });
  } catch (error) {
    console.error('GET /utr-registry/:utr error:', error);
    res.status(500).json({ success: false, message: 'Failed to lookup UTR' });
  }
});

/**
 * PUT /api/admin/utr-registry/:utr/flag — mark a reference fraudulent.
 *
 * Does NOT reverse the order it belongs to. Flagging and reversing are separate
 * decisions with separate evidence, and coupling them means an operator marking
 * a suspicious reference silently cancels a player's deposit.
 */
router.put('/utr-registry/:utr/flag', authenticate, isAdmin, async (req, res) => {
  try {
    const { reason } = req.body || {};
    if (!String(reason ?? '').trim()) {
      return res.status(400).json({
        success: false,
        message: 'A reason is required. It is what the player is shown if they appeal.',
      });
    }

    const result = await db.utr.flagFraud(req.params.utr, {
      actor: req.user.userId, reason: String(reason).trim(),
    });
    if (!result.ok) return res.status(404).json({ success: false, message: 'UTR not found in registry' });

    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'UTR_FLAGGED_FRAUD', category: 'SECURITY',
      targetType: 'UTRRegistry', targetId: result.entry.utr,
      details: { reason: String(reason).trim(), orderId: result.entry.orderId },
    });
    res.json({ success: true, message: 'UTR flagged as FRAUD', entry: result.entry });
  } catch (error) {
    console.error('PUT /utr-registry/:utr/flag error:', error);
    res.status(500).json({ success: false, message: 'Failed to flag UTR' });
  }
});

/** Lift a flag. Recorded as a state change, never by erasing the previous one. */
router.put('/utr-registry/:utr/clear', authenticate, isAdmin, async (req, res) => {
  try {
    const result = await db.utr.clearFraudFlag(req.params.utr, { actor: req.user.userId });
    if (!result.ok) return res.status(404).json({ success: false, message: 'That UTR is not flagged' });
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'UTR_FLAG_CLEARED', category: 'SECURITY',
      targetType: 'UTRRegistry', targetId: result.entry.utr, details: {},
    });
    res.json({ success: true, message: 'Flag cleared', entry: result.entry });
  } catch (error) {
    console.error('PUT /utr-registry/:utr/clear error:', error);
    res.status(500).json({ success: false, message: 'Failed to clear the flag' });
  }
});

// ─── GET /api/admin/utr/flagged — orders held for review ─────────────────────
router.get('/utr/flagged', authenticate, isAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const size = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const result = await db.orders.findOrders({
      requiresReview: true,
      limit: size,
      offset: Math.max(parseInt(page, 10) - 1, 0) * size,
    });
    res.json({
      success: true,
      flaggedOrders: result.orders,
      pagination: { page: Math.max(parseInt(page, 10) || 1, 1), limit: size, total: result.total },
    });
  } catch (error) {
    console.error('GET /utr/flagged error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch flagged orders' });
  }
});

/**
 * The review queue proper: references somebody tried to REUSE.
 *
 * A refused duplicate is the signal this control exists to catch, and a signal
 * nobody looks at is not a control. The attempt increments a counter on the row
 * rather than vanishing into a 400.
 *
 * Paged, and newest contest first. This asked for a fixed slice of 200 ordered
 * by attempt count, which made it a queue nobody could work: nothing ever
 * leaves the registry, so contested rows accumulate forever and the top 200 by
 * count is the same list every day. A reference an operator flagged by hand
 * starts at zero attempts and sorted below all of them, so it never appeared at
 * all.
 */
router.get('/utr/contested', authenticate, isAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const result = await db.utr.contestedUtrs({ page, limit });
    res.json({
      success: true,
      contested: result.entries,
      pagination: { total: result.total, page: result.page, limit: result.limit },
    });
  } catch (error) {
    console.error('GET /utr/contested error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch contested UTRs' });
  }
});

// ─── GET /api/admin/utr/stats ────────────────────────────────────────────────
router.get('/utr/stats', authenticate, isAdmin, async (req, res) => {
  try {
    res.json({ success: true, stats: await db.utr.utrStats() });
  } catch (error) {
    console.error('GET /utr/stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch UTR stats' });
  }
});

// ─── GET /api/admin/utr/user-history/:userId ─────────────────────────────────
router.get('/utr/user-history/:userId', authenticate, isAdmin, async (req, res) => {
  try {
    const history = await db.utr.userUtrHistory(req.params.userId, { limit: 100 });
    res.json({ success: true, history, totalUTRs: history.length });
  } catch (error) {
    console.error('GET /utr/user-history error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch user UTR history' });
  }
});

/**
 * POST /api/admin/utr/resolve/:orderId — clear an order held for review.
 *
 * `reject` CANCELS the order, and it goes through the state machine rather than
 * being written onto the row: cancelling has a legal from-set, it releases a
 * withdrawal's escrow, and it belongs in the order's history. This route used to
 * set `status = 'CANCELLED'` directly and then call `.save()` on a plain object
 * — so the cancellation neither happened nor was recorded, and the handler
 * threw.
 */
router.post('/utr/resolve/:orderId', authenticate, isAdmin, async (req, res) => {
  try {
    const { action, notes } = req.body || {};
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ success: false, message: 'action must be approve or reject' });
    }

    const order = await db.orders.getOrderRecord(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const review = {
      requiresReview: false,
      reviewedBy: req.user.userId,
      reviewedAt: new Date(),
      reviewAction: action,
      reviewNotes: notes || '',
    };

    if (action === 'reject') {
      // The transition carries the review fields with it, so an order cannot be
      // found CANCELLED without the decision that cancelled it.
      const cancelled = await cancelOrderState(order.orderId, {
        set: {
          ...review,
          cancelReason: `UTR fraud: ${order.utrWarningMessage || 'admin review'}`,
          cancelledAt: new Date(),
        },
      });
      if (!cancelled.ok) {
        return res.status(409).json({
          success: false,
          message: `Cannot cancel an order that is ${cancelled.status ?? 'missing'}`,
        });
      }
      await db.audit.recordDetailed({
        performedBy: req.user.userId, action: 'UTR_REVIEW_REJECTED', category: 'SECURITY',
        targetType: 'PaymentOrder', targetId: order.orderId,
        details: { notes: notes || '', utr: order.utrNumber },
      });
      return res.json({ success: true, message: 'Order rejected', order: cancelled.order });
    }

    const approved = await db.orders.setOrderFields(order.orderId, review);
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'UTR_REVIEW_APPROVED', category: 'SECURITY',
      targetType: 'PaymentOrder', targetId: order.orderId,
      details: { notes: notes || '', utr: order.utrNumber },
    });
    res.json({ success: true, message: 'Order approved', order: approved });
  } catch (error) {
    console.error('POST /utr/resolve error:', error);
    res.status(500).json({ success: false, message: 'Failed to resolve order' });
  }
});

export default router;
