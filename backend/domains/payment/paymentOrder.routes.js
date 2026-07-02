// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Payment (BBEPS Phase 003 §3.3). Owns payment-order lifecycle: listing,
// force-approve/reject/cancel, and dispute resolution (money movement + order status).
// Does NOT own merchant assignment/selection — that's domains/merchant/merchant.assignment.routes.js.
// Split out of the old backend/routes/admin/queue.admin.routes.js on 2026-07-01 as part
// of the Merchant+Payment domain migration (BBEPS Phase 004). See backend/domains/README.md.

import { express, mongoose, authenticate, isAdminOrSubAdmin, getModels } from '../../routes/admin/_adminShared.js';
import { creditDeposit, creditWinnings } from '../../services/walletAuthority.service.js';
import { emitAdminUpdate, emitOrderUpdate, emitWalletUpdate } from '../../services/realtimeEmitters.js';

const router = express.Router();

// ─── GET /api/admin/payment-queue ─────────────────────────────────────────────────
router.get('/payment-queue', authenticate, isAdminOrSubAdmin, async (req, res) => {
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
router.post('/payment-orders/:orderId/action', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { action, reason } = req.body;
    if (!['APPROVE', 'REJECT', 'CANCEL'].includes(action)) {
      return res.status(400).json({ success: false, message: 'action must be APPROVE, REJECT, or CANCEL' });
    }
    const { PaymentOrder } = getModels();
    const order = await PaymentOrder.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (['COMPLETED', 'CANCELLED'].includes(order.status)) {
      return res.status(400).json({ success: false, message: `Order already ${order.status}` });
    }

    if (action === 'APPROVE') {
      if (order.type === 'DEPOSIT') {
        await creditDeposit(order.userId, order.tokenAmount, `Admin-approved deposit: ${order.orderId}`);
      }
      order.status      = 'COMPLETED';
      order.completedAt = new Date();
      order.adminNote   = reason || 'Force-approved by admin';
      await order.save();
    } else {
      if (order.type === 'WITHDRAWAL') {
        await creditWinnings(order.userId, order.tokenAmount, `Cancelled withdrawal refund: ${order.orderId}`);
      }
      order.status          = 'CANCELLED';
      order.cancelledAt     = new Date();
      order.cancelReason    = reason || 'Rejected by admin';
      order.adminNote       = reason || 'Rejected by admin';
      await order.save();
    }

    emitAdminUpdate('queue_order_update', { orderId: order._id, status: order.status });
    res.json({ success: true, message: `Order ${action}D successfully`, order });
  } catch (err) {
    console.error('POST /p2p-orders/:orderId/action error:', err);
    res.status(500).json({ success: false, message: 'Failed to process order action' });
  }
});

// ─── POST /api/admin/payment-orders/:orderId/resolve — admin resolves dispute ─
// Body: { resolution: 'release' | 'refund', reason: string }
// release: complete the order, credit/debit tokens, mark merchant stats as success
// refund:  cancel order, refund escrow, mark merchant stats as failure
router.post('/payment-orders/:orderId/resolve', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { resolution, reason } = req.body;
    if (!['release', 'refund'].includes(resolution))
      return res.status(400).json({ success: false, message: 'resolution must be "release" or "refund"' });
    if (!reason?.trim())
      return res.status(400).json({ success: false, message: 'reason is required' });

    const { PaymentOrder } = getModels();
    const Merchant = mongoose.model('Merchant');

    const order = await PaymentOrder.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'DISPUTED')
      return res.status(400).json({ success: false, message: `Can only resolve DISPUTED orders. Current: ${order.status}` });

    const now = new Date();

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
      if (order.type === 'DEPOSIT' && order.merchantId) {
        await Merchant.findByIdAndUpdate(order.merchantId, {
          $inc: { tokenBalance: -order.tokenAmount },
        }).catch(e => console.error('[dispute resolve] tokenBalance decrement:', e.message));
      }

      order.status            = 'COMPLETED';
      order.completedAt       = now;
      order.disputeResolvedAt = now;
      order.disputeResolvedBy = req.user._id;
      order.disputeResolution = 'released';
      order.resolutionNotes   = reason.trim();
      order.updatedAt         = now;
      await order.save();

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

      order.status            = 'CANCELLED';
      order.cancelReason      = 'DISPUTE_REFUNDED';
      order.cancelledAt       = now;
      order.disputeResolvedAt = now;
      order.disputeResolvedBy = req.user._id;
      order.disputeResolution = 'refunded';
      order.resolutionNotes   = reason.trim();
      order.updatedAt         = now;
      await order.save();

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
