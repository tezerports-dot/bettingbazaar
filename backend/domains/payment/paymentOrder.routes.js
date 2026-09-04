// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Payment (BBEPS Phase 003 §3.3). Owns payment-order lifecycle: listing,
// force-approve/reject/cancel, and dispute resolution (money movement + order status).
// Does NOT own merchant assignment/selection — that's domains/merchant/merchant.assignment.routes.js.
// Split out of the old backend/routes/admin/queue.admin.routes.js on 2026-07-01 as part
// of the Merchant+Payment domain migration (BBEPS Phase 004). See backend/domains/README.md.

import { express, authenticate, hasPermission } from '../../routes/admin/_adminShared.js';
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
    // The parties come from a join rather than two populates, and the per-state
    // counts from the whole table rather than from the capped list. The route
    // this replaced derived its stats by filtering the 200 rows it had just
    // fetched, so a queue with 900 pending orders reported 200 and looked calm.
    const queue = await db.orders.paymentQueue({ state: status, limit: 200 });
    res.json({ success: true, ...queue });
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
        await creditDeposit(order.userId, order.tokenAmount, String(order.orderId));
      } else {
        // WITHDRAWAL release: the tokens were locked when the order was created
        // and the escrow already debited them, so completing is all that is
        // left — but the escrow flag has to be CLEARED IN THE DATABASE.
        //
        // The line this replaced assigned `order.escrowLocked = false` on a
        // plain object and never wrote it back, so every released withdrawal
        // dispute left the order still marked escrow-locked. The refund branch
        // below reads that same flag, so a later refund on the same order would
        // have credited the player a second time for money already released.
        await db.orders.setOrderFields(order.orderId, { escrowLocked: false });
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
          refModel: 'PaymentOrder', refId: String(order.orderId),
          txId: `mw_dep_deduct_${order.orderId}`, allowOverdraft: true,
        }).catch(e => console.error('[dispute resolve] tokenBalance decrement:', e.message));
      }

      // The order was written by the transition above, resolution fields and
      // all — there is no second save, and therefore no window in which the
      // tokens have moved but the order does not yet say so.
      Object.assign(order, resolved.order);

      // Merchant statistics, through the one function that owns them. The two
      // `$inc`s this replaced moved `totalOrdersAll` and `totalOrdersCompleted`
      // and nothing else — so `successRate`, which is DERIVED from exactly
      // those two counters, was left describing the pair as they were before
      // the order it was meant to include. A merchant's success rate drifted
      // further from its own counters with every dispute resolved.
      if (order.merchantId) {
        await db.merchants.recordCompletedOrder(order.merchantId, {
          direction: order.type,
          amountRupees: order.tokenAmount,
          disputed: true,
        });
      }

      emitOrderUpdate(String(order.userId), 'order_completed', {
        orderId: order.orderId, _id: order.orderId, status: 'COMPLETED', server_ts: Date.now(),
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
            'PaymentOrder', order.orderId, `dispute_refund_${order.orderId}`,
          );
          // Cleared in the DATABASE, and AFTER the credit — so a failure
          // between them leaves an order that still says the escrow is held,
          // which the keyed credit makes safe to retry. Clearing it first would
          // leave money locked with nothing recording that it still is.
          await db.orders.setOrderFields(order.orderId, { escrowLocked: false });
        }
      }

      Object.assign(order, resolved.order);

      // Same owner for the failure side. The `$inc` this replaced also
      // decremented `activeOrderCount` — a field that does not exist on the
      // merchant record, so the decrement went nowhere and the counter it was
      // meant to maintain has always been whatever it started as. Concurrency
      // is measured from the ORDERS a merchant currently holds, which cannot
      // drift because there is nothing to keep in step.
      if (order.merchantId) {
        await db.merchants.recordCompletedOrder(order.merchantId, {
          direction: order.type,
          amountRupees: 0,
          disputed: true,
        });
      }

      await emitWalletUpdate(order.userId);
      emitOrderUpdate(String(order.userId), 'order_update', {
        orderId: order.orderId, _id: order.orderId, status: 'CANCELLED', server_ts: Date.now(),
      });
    }

    emitAdminUpdate('queue_order_update', {
      orderId: order.orderId, status: order.status, server_ts: Date.now(),
    });

    res.json({ success: true, message: `Dispute resolved: ${resolution}`, order });
  } catch (error) {
    console.error('POST /admin/payment-orders/:orderId/resolve error:', error);
    res.status(500).json({ success: false, message: 'Failed to resolve dispute' });
  }
});

export default router;
