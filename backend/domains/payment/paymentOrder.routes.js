// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Payment (BBEPS Phase 003 §3.3). Owns payment-order lifecycle: listing,
// force-approve/reject/cancel, and dispute resolution (money movement + order status).
// Does NOT own merchant assignment/selection — that's domains/merchant/merchant.assignment.routes.js.
// Split out of the old backend/routes/admin/queue.admin.routes.js on 2026-07-01 as part
// of the Merchant+Payment domain migration (BBEPS Phase 004). See backend/domains/README.md.

import { express, mongoose, authenticate, hasPermission, getModels } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
import { creditDeposit, creditWinnings } from '../wallet/walletAuthority.service.js';
// The order state machine. Every status change goes through here so an illegal
// move is refused by the database rather than by whichever check ran first.
import { completeOrder, cancelOrder } from './orderLifecycle.service.js';
import { debitMerchantTokens } from '../merchant/merchantWallet.service.js';
import { emitAdminUpdate, emitOrderUpdate, emitWalletUpdate } from '../notification/realtimeEmitters.js';

const router = express.Router();

// ─── GET /api/admin/payment-queue ─────────────────────────────────────────────────
router.get('/payment-queue', authenticate, hasPermission('canViewTransactions'), async (req, res) => {
  try {
    const { status } = req.query;
    const { PaymentOrder } = getModels();
    const query = {};
    if (status && status !== 'all') query.status = status;
    const orders = await PaymentOrder.find(query)
      .populate('userId',     'username mobile kycStatus')
      .populate('merchantId', 'username mobile')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    const grouped = {
      pending:    orders.filter(o => o.status === 'PENDING_QUEUE'),
      assigned:   orders.filter(o => o.status === 'ASSIGNED'),
      processing: orders.filter(o => o.status === 'PROCESSING'),
      paid:       orders.filter(o => o.status === 'PAID'),
      disputed:   orders.filter(o => o.status === 'DISPUTED'),
      completed:  orders.filter(o => o.status === 'COMPLETED'),
    };
    res.json({
      success: true, orders, grouped,
      stats: {
        pending:    grouped.pending.length,
        assigned:   grouped.assigned.length,
        processing: grouped.processing.length,
        paid:       grouped.paid.length,
        disputed:   grouped.disputed.length,
        completed:  grouped.completed.length,
        total:      orders.length,
      },
    });
  } catch (error) {
    console.error('GET /payment-queue error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch Payment queue' });
  }
});

// ─── POST /api/admin/payment-orders/:orderId/action ───────────────────────────────
router.post('/payment-orders/:orderId/action', authenticate, hasPermission('canResolveDisputes'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const { action, reason } = req.body;
    if (!['APPROVE', 'REJECT', 'CANCEL'].includes(action)) {
      return res.status(400).json({ success: false, message: 'action must be APPROVE, REJECT, or CANCEL' });
    }
    const { PaymentOrder } = getModels();
    const order = await db.orders.getOrderRecord(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (['COMPLETED', 'CANCELLED'].includes(order.status)) {
      return res.status(400).json({ success: false, message: `Order already ${order.status}` });
    }

    // The TRANSITION IS THE GATE, and it runs before the money.
    //
    // This used to credit first and set the status afterwards, guarded only by
    // the `order.status` read above — a stale value by the time `save()` ran.
    // Two admins double-clicking APPROVE both passed that read; only
    // creditDeposit's own idempotency key stopped the second credit, which
    // means the protection lived in a different domain from the decision.
    //
    // Now the guarded update decides. Exactly one caller matches a row, and
    // only that caller goes on to move money.
    let moved;
    if (action === 'APPROVE') {
      moved = await completeOrder(order._id, {
        set: { completedAt: new Date(), adminNote: reason || 'Force-approved by admin' },
      });
    } else {
      moved = await cancelOrder(order._id, {
        set: {
          cancelledAt: new Date(),
          cancelReason: reason || 'Rejected by admin',
          adminNote: reason || 'Rejected by admin',
        },
      });
    }

    if (!moved.ok) {
      // An illegal move is a 409, not a 500: the request was understood and
      // refused because the order is not in a state this action is valid from.
      return res.status(409).json({
        success: false,
        message: `Cannot ${action} an order that is ${moved.status ?? 'missing'}`,
        reason: moved.reason,
      });
    }

    // `idempotent` means a previous delivery already made this move. The money
    // side is idempotent on its own key, so re-running it is harmless — but not
    // re-running it is clearer about what actually happened.
    if (!moved.idempotent) {
      if (action === 'APPROVE' && order.type === 'DEPOSIT') {
        await creditDeposit(order.userId, order.tokenAmount, `Admin-approved deposit: ${order.orderId}`);
      } else if (action !== 'APPROVE' && order.type === 'WITHDRAWAL') {
        await creditWinnings(order.userId, order.tokenAmount, `Cancelled withdrawal refund: ${order.orderId}`);
      }
    }

    const settled = moved.order ?? order;
    emitAdminUpdate('queue_order_update', { orderId: settled._id, status: moved.status });
    // The POST-transition document, not the stale one read at the top.
    res.json({ success: true, message: `Order ${action}D successfully`, order: settled });
  } catch (err) {
    console.error('POST /p2p-orders/:orderId/action error:', err);
    res.status(500).json({ success: false, message: 'Failed to process order action' });
  }
});

// ─── POST /api/admin/payment-orders/:orderId/resolve — admin resolves dispute ─
// Body: { resolution: 'release' | 'refund', reason: string }
// release: complete the order, credit/debit tokens, mark merchant stats as success
// refund:  cancel order, refund escrow, mark merchant stats as failure
router.post('/payment-orders/:orderId/resolve', authenticate, hasPermission('canResolveDisputes'), async (req, res) => {
  try {
    const { orderId } = req.params;
    const { resolution, reason } = req.body;
    if (!['release', 'refund'].includes(resolution))
      return res.status(400).json({ success: false, message: 'resolution must be "release" or "refund"' });
    if (!reason?.trim())
      return res.status(400).json({ success: false, message: 'reason is required' });

    const { PaymentOrder } = getModels();

    const order = await db.orders.getOrderRecord(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'DISPUTED')
      return res.status(400).json({ success: false, message: `Can only resolve DISPUTED orders. Current: ${order.status}` });

    const now = new Date();

    // THE TRANSITION IS THE GATE, and it runs before the money — the same shape
    // as the /action handler above, for the same reason. Both branches below
    // moved value first and set the status afterwards, guarded only by the
    // `order.status !== 'DISPUTED'` read above; two admins resolving one dispute
    // in opposite directions ran BOTH, because the per-call idempotency keys
    // protect a call against itself and not against its opposite.
    const resolved = await (resolution === 'release' ? completeOrder : cancelOrder)(order._id, {
      expectFrom: 'DISPUTED',
      set: {
        disputeResolvedAt: now,
        disputeResolvedBy: req.user.userId,
        disputeResolution: resolution === 'release' ? 'released' : 'refunded',
        resolutionNotes:   reason.trim(),
        updatedAt:         now,
        ...(resolution === 'release'
          ? { completedAt: now }
          : { cancelReason: 'DISPUTE_REFUNDED', cancelledAt: now }),
      },
    });
    if (!resolved.ok) {
      return res.status(409).json({
        success: false,
        message: `Can only resolve DISPUTED orders. Current: ${resolved.status ?? 'missing'}`,
      });
    }
    if (resolved.idempotent) {
      return res.json({ success: true, message: 'Dispute already resolved', order: resolved.order ?? order });
    }

    if (resolution === 'release') {
      // Release: complete the order — credit tokens to user (DEPOSIT) or mark complete (WITHDRAWAL)
      if (order.type === 'DEPOSIT') {
        await creditDeposit(order.userId, order.tokenAmount, order._id.toString());
      } else {
        // WITHDRAWAL release: tokens were already locked/debited on order creation
        // Just mark complete and debit from lockedBalance (already done by escrow)
        order.escrowLocked = false;
        await emitWalletUpdate(order.userId);
      }

      // Merchant inventory deduction for DEPOSIT
      // GOVERNANCE §1: via merchantWallet.service.js; canonical txId means a
      // deposit already deducted via the normal confirm/approve path is NOT
      // deducted again here (idempotent no-op). allowOverdraft preserves this
      // site's historical blind-$inc semantics.
      if (order.type === 'DEPOSIT' && order.merchantId) {
        await debitMerchantTokens({
          merchantId: order.merchantId, amount: order.tokenAmount,
          reason: `Deposit ${order.orderId} released via dispute resolution`,
          refModel: 'PaymentOrder', refId: order._id.toString(),
          txId: `mw_dep_deduct_${order._id}`, allowOverdraft: true,
        }).catch(e => console.error('[dispute resolve] tokenBalance decrement:', e.message));
      }

      // The order was written by the transition above, resolution fields and
      // all — there is no second save, and therefore no window in which the
      // tokens have moved but the order does not yet say so.
      Object.assign(order, resolved.order);

      // Merchant stats: success
      if (order.merchantId) {
        await mongoose.model('Merchant').findByIdAndUpdate(order.merchantId, {
          $inc: { totalOrdersAll: 1, totalOrdersCompleted: 1 },
        });
      }

      emitOrderUpdate(order.userId.toString(), 'order_completed', {
        orderId:   order.orderId, _id: order._id, status: 'COMPLETED', server_ts: Date.now(),
      });
    } else {
      // Refund: cancel order, refund escrow/tokens
      if (order.type === 'DEPOSIT') {
        // No tokens were credited to user yet (was in DISPUTED before confirm) — nothing to refund
      } else {
        // WITHDRAWAL: refund escrow back to winningsBalance
        if (order.escrowLocked) {
          await creditWinnings(
            order.userId, order.tokenAmount,
            `Admin dispute refund: ${order.orderId}`,
            'PaymentOrder', order._id, `dispute_refund_${order._id}`
          );
          order.escrowLocked = false;
        }
      }

      Object.assign(order, resolved.order);

      // Merchant stats: failure
      if (order.merchantId) {
        await mongoose.model('Merchant').findByIdAndUpdate(order.merchantId, {
          $inc: { totalOrdersAll: 1, activeOrderCount: -1 },
        });
      }

      await emitWalletUpdate(order.userId);
      emitOrderUpdate(order.userId.toString(), 'order_update', {
        orderId:   order.orderId, _id: order._id, status: 'CANCELLED', server_ts: Date.now(),
      });
    }

    emitAdminUpdate('queue_order_update', { orderId: order._id, status: order.status, server_ts: Date.now() });

    res.json({ success: true, message: `Dispute resolved: ${resolution}`, order });
  } catch (error) {
    console.error('POST /admin/payment-orders/:orderId/resolve error:', error);
    res.status(500).json({ success: false, message: 'Failed to resolve dispute' });
  }
});

export default router;
