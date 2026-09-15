// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// Domain: Payment (BBEPS Phase 003 §3.3). Owns payment-order lifecycle: listing,
// force-approve/reject/cancel, and dispute resolution (money movement + order status).
// Does NOT own merchant assignment/selection — that's domains/merchant/merchant.assignment.routes.js.
// Split out of the old backend/routes/admin/queue.admin.routes.js on 2026-07-01 as part
// of the Merchant+Payment domain migration (BBEPS Phase 004). See backend/domains/README.md.

import { express, authenticate, hasPermission } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
import { creditDeposit, creditReserve, creditWinnings } from '../wallet/walletAuthority.service.js';
// The one owner of a confirmed deposit's money movement. The merchant confirm
// route calls the same function; that is what keeps the two from disagreeing.
import { moveDepositMoney } from './depositCredit.js';
import { releaseUTR } from '../../middleware/utrValidation.js';
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

    // ── APPROVE on a deposit: money BEFORE status ───────────────────────────
    // The merchant must be debited for what the player is credited, or an
    // approval mints tokens. This route used to credit `tokenAmount` in one
    // lump, never debit the merchant and never release the UTR, so the books
    // did not close and nothing said so. It now moves the money through the
    // same function the merchant confirm route uses.
    //
    // The order is deliberate: refusing (a merchant who cannot cover it) is the
    // ordinary case and must refuse before the order advances. Every movement
    // is keyed on the order id, so a crash between the money and the transition
    // leaves a retryable PAID order rather than a COMPLETED one that paid
    // nobody.
    let deposited = null;
    if (action === 'APPROVE' && order.type === 'DEPOSIT') {
      deposited = await moveDepositMoney(order, {
        debitMerchantTokens, creditDeposit, creditReserve, releaseUTR,
      });
      if (!deposited.ok) {
        return res.status(400).json({ success: false, message: 'Merchant insufficient token balance' });
      }
    }

    // ── The TRANSITION IS THE GATE for the RESPONSE ─────────────────────────
    // Two admins double-clicking both replay keyed no-op movements above, and
    // exactly one matches a row here and is told the action succeeded.
    //
    // `adminNote` is not a settable field — `setOrderFields` refuses it, and it
    // threw on EVERY call, so this route 500'd on every approve, reject and
    // cancel an admin has ever clicked. The reason belongs in `cancelReason`,
    // which the allowlist does carry.
    let moved;
    if (action === 'APPROVE') {
      moved = await completeOrder(order._id, {
        set: { completedAt: new Date(), approvedBy: req.user.userId, approvedAt: new Date() },
      });
    } else {
      moved = await cancelOrder(order._id, {
        set: {
          cancelledAt: new Date(),
          cancelReason: reason || `${action === 'REJECT' ? 'Rejected' : 'Cancelled'} by admin`,
          rejectedBy: req.user.userId,
        },
      });
    }

    if (!moved.ok) {
      if (deposited?.ok) {
        // The money moved and the order would not advance. A repair case, not a
        // rollback: the movements are keyed, so the next approve replays them as
        // no-ops. Loud rather than silent.
        console.error(`[admin-action] ${order.orderId} money moved but transition refused:`, moved.reason);
      }
      // An illegal move is a 409, not a 500: the request was understood and
      // refused because the order is not in a state this action is valid from.
      return res.status(409).json({
        success: false,
        message: `Cannot ${action} an order that is ${moved.status ?? 'missing'}`,
        reason: moved.reason,
      });
    }

    // ── Returning a rejected withdrawal ─────────────────────────────────────
    // The player's winnings were debited when the withdrawal was admitted, so
    // cancelling without refunding is money taken and not returned.
    //
    // `creditWinnings` requires a deterministic txId as its SIXTH argument and
    // throws without one; this passed three, so the throw landed AFTER the
    // cancel had committed — the order read CANCELLED and the player never got
    // their money back. The key is derived from the order, so a replayed
    // delivery refunds exactly once.
    //
    // `idempotent` means a previous delivery already made this move, and the
    // refund with it. Re-running would be a no-op on the same key; not running
    // it is clearer about what actually happened.
    if (!moved.idempotent && action !== 'APPROVE' && order.type === 'WITHDRAWAL') {
      await creditWinnings(
        order.userId, order.tokenAmount,
        `Cancelled withdrawal refund: ${order.orderId}`,
        'PaymentOrder', order.orderId, `wd_refund_${order.orderId}`,
      );
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
    // ── `resolutionNotes` and `updatedAt` are not columns ───────────────────
    // Both were refused by `setOrderFields`, which runs AFTER the transition
    // has committed — so this route marked the order COMPLETED or CANCELLED,
    // threw before a single rupee moved, recorded no decision, and returned a
    // 500. The player's disputed deposit was closed and never credited, and the
    // order left the DISPUTED queue, so nothing was left to show it had gone
    // wrong. The admin panel's Payment Control Centre calls this on every
    // release and refund; it has never once worked.
    //
    // The identical bug was found and fixed in
    // disputeResolution.admin.routes.js. This file is the copy that did not get
    // the fix — which is why `check:settable` now refuses the whole class.
    //
    // The verdict goes in `dispute_decision` and the admin's words in
    // `dispute_resolution`, matching the sibling route exactly: one vocabulary,
    // so a dispute reads the same however it was resolved.
    const resolved = await (resolution === 'release' ? completeOrder : cancelOrder)(order._id, {
      expectFrom: 'DISPUTED',
      set: {
        disputeResolvedAt: now,
        disputeResolvedBy: req.user.userId,
        disputeDecision:   resolution === 'release' ? 'RELEASE_TO_USER' : 'CANCEL_ORDER',
        disputeResolution: reason.trim(),
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
