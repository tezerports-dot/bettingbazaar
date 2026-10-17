// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/merchant/merchant.assignment.routes.js — the queue manager's levers
 * over who serves an order.
 *
 * ── There is no picker any more ─────────────────────────────────────────────
 * Every order reaches an approved team member through team routing
 * (`db.teamRouting.assignToTeam`, PROJECT_STATUS §3.10 2c, §3.11): the admin's
 * routing priority, then the fastest average response, then fewest open
 * orders, then least recently assigned, on the order's rail, with a buy's
 * tokens held in the team's pool in the same transaction. A queue manager
 * hand-picking a merchant would bypass every one of those checks — the pool,
 * the cap, Ready, the approval — so the levers left are the ones that go
 * THROUGH it:
 *
 *   POST /queue/assign/:orderId          offer a queued order to the teams now
 *   POST /payment-orders/:id/reassign    take an assigned order off its member
 *                                        and offer it to the next one
 *   GET  /queue/pending-orders           the worklist
 *
 * Payment-order lifecycle (approve / reject / cancel / resolve-dispute) is
 * Payment domain territory and lives in domains/payment/paymentOrder.routes.js.
 */
import { express, authenticate, queueManagerOrPermission } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
import { requeueOrder } from '../payment/orderLifecycle.service.js';
import { tryAssignMerchant } from '../payment/paymentProcessing.service.js';
import { emitAdminUpdate, emitMerchantUpdate, emitOrderUpdate } from '../notification/realtimeEmitters.js';
import { respondError } from '../../shared/httpError.js';

const router = express.Router();

// NOTE: GET /payment-queue is intentionally not registered in the Merchant
// domain. The canonical queue listing lives in the Payment domain
// (domains/payment/paymentOrder.routes.js), where it enforces the granular
// canViewTransactions permission.

// ─── POST /api/admin/payment-orders/:id/reassign ─────────────────────────────
/**
 * Take a started order off its member and offer it to the next one.
 *
 * Only while nobody can have paid on it (`mayChangeHands`): a sell its member
 * has not paid, or a cash buy with no ATM QR scanned. Any other buy shows the
 * player where to pay from the moment it starts, and moving it would send them
 * to somebody who never receives the money; such an order is resolved through
 * a dispute instead. Asked again under the row lock (`refuseIfPayableWithin`).
 *
 * The requeue and the release of the team's pool hold are one transaction, so
 * the order is never queued while still holding a team's tokens. It is then
 * offered through routing with the previous member barred; if nobody is free it
 * waits PENDING_QUEUE for the assignment sweep, like any other.
 *
 * Not a refusal by the member — the admin moved it — so nothing is counted
 * against them.
 */
router.post('/payment-orders/:id/reassign', authenticate, queueManagerOrPermission('canManageMerchants'), async (req, res) => {
  try {
    const order = await db.orders.getOrderRecord(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!db.orders.mayChangeHands(order)) {
      return res.status(400).json({
        success: false,
        code: 'CANNOT_REASSIGN',
        message: order.status === 'PROCESSING'
          ? 'The player has been shown where to pay this member, and may already be paying. Resolve it through a dispute instead.'
          : `Order is ${order.status}, cannot reassign`,
      });
    }
    const previousMerchantId = order.merchantId;

    const requeued = await requeueOrder(order.orderId, {
      expectFrom: 'PROCESSING',
      set: { merchantId: null, merchantSnapshot: null, expiresAt: null },
      actor: `admin:${req.user.userId}`,
      reason: 'Reassigned by a queue manager',
      within: async (client) => {
        await db.orders.refuseIfPayableWithin(client, order.orderId);
        await db.teamPools.detachFromTeamWithin(client, order.orderId, {
          actor: `admin:${req.user.userId}`, reason: 'Reassigned by a queue manager',
        });
      },
    });
    if (!requeued.ok || requeued.idempotent) {
      return res.status(409).json({ success: false, message: `Order is ${requeued.status ?? 'missing'}, cannot reassign` });
    }
    Object.assign(order, requeued.order);

    // The member it was taken from learns it is gone from their queue.
    if (previousMerchantId) {
      emitMerchantUpdate(String(previousMerchantId), 'order_update', {
        orderId: order.orderId, status: 'PENDING_QUEUE', server_ts: Date.now(),
      });
    }

    const assigned = await tryAssignMerchant(order, { alsoBar: previousMerchantId ? [previousMerchantId] : [] });

    // Recorded HERE: "who moved this order off my queue" is the first thing the
    // previous member asks, and the admin audit log is where every other
    // operator action lives.
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'ORDER_REASSIGNED', category: 'MERCHANT',
      targetType: 'PaymentOrder', targetId: order.orderId,
      details: {
        fromMerchant: previousMerchantId ?? null,
        toMerchant: assigned ? order.merchantId : null,
        tokenAmount: order.tokenAmount,
      },
    });

    if (!assigned) {
      emitOrderUpdate(String(order.userId), 'order_update', {
        orderId: order.orderId, _id: order.orderId, status: 'PENDING_QUEUE', server_ts: Date.now(),
      });
    }
    emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: order.status, server_ts: Date.now() });
    res.json({
      success: true,
      message: assigned
        ? 'Order reassigned to another member.'
        : 'Order taken off its member. Nobody else is free yet; it stays queued and is offered again automatically.',
      order: await db.orders.getOrderRecord(order.orderId),
    });
  } catch (error) {
    // The player may already be paying (asked under the row lock): said as it is.
    return respondError(res, error, 'POST /payment-orders/:id/reassign', { message: 'Failed to reassign order' });
  }
});

// ─── GET /api/admin/queue/pending-orders ──────────────────────────────────────
router.get('/queue/pending-orders', authenticate, queueManagerOrPermission('canManageMerchants'), async (req, res) => {
  try {
    // One query with the player joined, not a populate per page. A player who
    // has since been deleted comes back with null columns rather than a `null`
    // reference the mapper turned into the string 'Unknown' — a closed account
    // and a data problem looked identical.
    const orders = await db.orders.queuePendingOrders({ limit: 50 });
    res.json({
      success: true,
      orders: orders.map((o) => ({
        ...o,
        userName:      o.userName ?? 'Deleted account',
        userMobile:    o.userMobile ?? '',
      })),
    });
  } catch (error) {
    console.error('GET /queue/pending-orders error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch pending orders' });
  }
});

// ─── POST /api/admin/queue/assign/:orderId (queue manager) ────────────────────
/**
 * Offer one queued order to the teams NOW, rather than waiting for the sweep.
 * Through routing, never to a hand-picked merchant (see the header). Answers
 * 409 naming why when nobody can take it, so the queue manager knows whether to
 * wait or to ask a supervisor to fund a pool or fill a team.
 */
router.post('/queue/assign/:orderId', authenticate, queueManagerOrPermission('canManageMerchants'), async (req, res) => {
  try {
    const order = await db.orders.getOrderRecord(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'PENDING_QUEUE') {
      return res.status(400).json({ success: false, message: `Order status is ${order.status}, cannot assign` });
    }
    const assigned = await tryAssignMerchant(order);
    if (!assigned) {
      return res.status(409).json({
        success: false,
        code: 'NO_MEMBER_FREE',
        message: 'No member can take this order right now: every working team on its rail is at its cap, '
          + 'not ready, or short of pool tokens. It stays queued and is offered again automatically.',
      });
    }
    emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: order.status, server_ts: Date.now() });
    res.json({
      success: true,
      message: 'Order assigned',
      order: await db.orders.getOrderRecord(order.orderId),
    });
  } catch (error) {
    console.error('POST /queue/assign/:orderId error:', error);
    res.status(500).json({ success: false, message: 'Failed to assign order' });
  }
});

export default router;
