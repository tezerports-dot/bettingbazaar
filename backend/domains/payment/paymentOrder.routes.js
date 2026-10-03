// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// Domain: Payment (BBEPS Phase 003 §3.3). Owns payment-order lifecycle: listing,
// force-approve/reject/cancel, and dispute resolution (money movement + order status).
// Does NOT own merchant assignment/selection — that's domains/merchant/merchant.assignment.routes.js.
// Split out of the old backend/routes/admin/queue.admin.routes.js on 2026-07-01 as part
// of the Merchant+Payment domain migration (BBEPS Phase 004). See backend/domains/README.md.

import { express, authenticate, hasPermission, queueManagerOrPermission } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
import { creditDeposit, creditReserve } from '../wallet/walletAuthority.service.js';
// The one owner of how an admin decision ends a withdrawal's money, and of a
// cancelled buy's merchant hold. Both routes below end orders both ways.
import { endWithdrawal } from './withdrawalHold.service.js';
import { recordDisputeLoser } from '../disputes/disputeOutcome.service.js';
// The one owner of a confirmed deposit's money movement. The merchant confirm
// route calls the same function; that is what keeps the two from disagreeing.
import { moveDepositMoney } from './depositCredit.js';
import { releaseUTR } from '../../middleware/utrValidation.js';
// The order state machine. Every status change goes through here so an illegal
// move is refused by the database rather than by whichever check ran first.
import { completeOrder, cancelOrder, canTransition } from './orderLifecycle.service.js';
import { emitAdminUpdate, emitOrderUpdate, emitWalletUpdate } from '../notification/realtimeEmitters.js';

const router = express.Router();

// ─── GET /api/admin/payment-queue ─────────────────────────────────────────────────
// The QUEUE MANAGER's own list — the Queue Manager screen is its only caller —
// so it carries the queue gate every other queue route carries. It was given
// canViewTransactions when every staff route was re-gated by area (F-047), and
// a queue manager holds no areas: their one screen answered 403 and read
// "load error". Measured by opening the panel AS a queue manager
// (browser profile `queue-manager`), not by any route test.
router.get('/payment-queue', authenticate, queueManagerOrPermission('canManageMerchants'), async (req, res) => {
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
    // The team's pool must part with what the player is credited, or an
    // approval mints tokens. This route used to credit `tokenAmount` in one
    // lump, never debit the merchant and never release the UTR, so the books
    // did not close and nothing said so. It now moves the money through the
    // same function the merchant confirm route uses.
    //
    // The order is deliberate: refusing (a pool that cannot cover it) must
    // happen before the order advances. Every movement
    // is keyed on the order id, so a crash between the money and the transition
    // leaves a retryable PAID order rather than a COMPLETED one that paid
    // nobody.
    // An APPROVE the order cannot take is refused BEFORE any money moves: a
    // REJECTED buy approved here paid the player out and then answered 409
    // (security review, 2026-10-03). The read answers the common case; the
    // spend asks the same question again under the order's lock.
    if (action === 'APPROVE' && !canTransition(order.status, 'COMPLETED')) {
      return res.status(409).json({ success: false, message: `Cannot APPROVE an order that is ${order.status}` });
    }
    let deposited = null;
    if (action === 'APPROVE' && order.type === 'DEPOSIT') {
      deposited = await moveDepositMoney(order, {
        creditDeposit, creditReserve, releaseUTR, requireState: order.status,
      });
      if (!deposited.ok && deposited.reason === 'order_state') {
        return res.status(409).json({ success: false, message: 'The order changed while this was being approved. Nothing was credited; refresh and decide again.' });
      }
      if (!deposited.ok) {
        return res.status(409).json({ success: false, message: 'The team\'s token pool cannot cover this buy. Nothing was credited; the order stays as it is.' });
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
    // A decision taken on a DISPUTED order is a dispute OUTCOME (2c+): it is
    // pinned to the state it was read in, so whoever it suspends below is the
    // party this decision actually went against, not one another admin's
    // decision already settled.
    const wasDispute = order.status === 'DISPUTED';
    const pin = wasDispute ? { expectFrom: 'DISPUTED' } : {};
    let moved;
    if (action === 'APPROVE') {
      moved = await completeOrder(order._id, {
        ...pin,
        set: { completedAt: new Date(), approvedBy: req.user.userId, approvedAt: new Date() },
      });
    } else {
      moved = await cancelOrder(order._id, {
        ...pin,
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
        message: moved.reason === 'pool_paid'
          ? 'The team\'s tokens for this buy were already paid to the player, so it can only be completed.' : `Cannot ${action} an order that is ${moved.status ?? 'missing'}`,
        reason: moved.reason,
      });
    }

    // ── A withdrawal's money, through its one owner ──────────────────────
    // Admission moved the player's winnings into `locked`. This credited
    // winnings on a reject and left the lock standing — the wallet read the
    // amount twice — and an APPROVE moved nothing at all: the stake stayed
    // locked for good and the merchant who paid the player was never credited.
    // A HELD withdrawal also kept its settlement RESERVED forever (F-027).
    //
    // Run on a replay too (`idempotent`): every step is keyed, so a second
    // click repairs a first that failed part-way instead of reporting success
    // over money that never moved.
    if (order.type === 'WITHDRAWAL') {
      const ended = await endWithdrawal(order.orderId, action === 'APPROVE' ? 'RELEASE' : 'REFUND', {
        reason: reason || `${action} by admin`, by: req.user.userId,
      });
      if (!ended.ok) {
        return res.status(409).json({
          success: false,
          message: `The order is ${moved.status ?? 'updated'}, but its money could not be ${action === 'APPROVE' ? 'released to the merchant' : 'returned to the player'} (${ended.reason}). Nothing was paid twice — check the order before retrying.`,
        });
      }
    } else if (action !== 'APPROVE') {
      // A buy that will not be served gives its team's held tokens back to the
      // pool, here, rather than leaving them for the stranded-hold report.
      await db.teamPools.releaseBuyHold(order.orderId, { actor: `admin:${req.user.userId}`, reason: reason || `${action} by admin` });
    }

    // Whoever lost the dispute is suspended — the same consequence the two
    // resolve routes apply (§32 S3). Keyed by the order, so a replay is a no-op.
    if (wasDispute) {
      await recordDisputeLoser(order, {
        completed: action === 'APPROVE',
        decision: action === 'APPROVE' ? 'RELEASE_TO_USER' : 'CANCEL_ORDER',
        by: req.user.userId,
      });
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
        message: resolved.reason === 'pool_paid'
          ? 'The team\'s tokens for this buy were already paid to the player, so it can only be completed.' : `Can only resolve DISPUTED orders. Current: ${resolved.status ?? 'missing'}`,
      });
    }
    // A withdrawal's money step is keyed end to end, so replaying it on a
    // second click repairs a first that failed part-way and moves nothing when
    // the first succeeded. Only the SAME decision reaches here: the opposite one
    // was refused by the transition above.
    const endWithdrawalAs = (decision) => endWithdrawal(order.orderId, decision, {
      reason: reason.trim(), by: req.user.userId,
    });
    // Whoever lost the dispute is suspended (2c+) — the same consequence the
    // Dispute Manager applies, through the same owner (§32 S3). The order as
    // read is DISPUTED (checked above); the record is keyed by the order.
    const asDecided = { ...order };
    const outcome = {
      completed: resolution === 'release',
      decision: resolution === 'release' ? 'RELEASE_TO_USER' : 'CANCEL_ORDER',
      by: req.user.userId,
    };
    if (resolved.idempotent) {
      if (order.type === 'WITHDRAWAL') await endWithdrawalAs(resolution === 'release' ? 'RELEASE' : 'REFUND');
      await recordDisputeLoser(asDecided, outcome);
      return res.json({ success: true, message: 'Dispute already resolved', order: resolved.order ?? order });
    }

    if (resolution === 'release') {
      // Release: complete the order — credit tokens to user (DEPOSIT) or mark complete (WITHDRAWAL)
      if (order.type === 'DEPOSIT') {
        // ── Through the ONE owner, exactly as the two confirm routes do ────
        // This used to be `creditDeposit(userId, order.tokenAmount, …)` — the
        // WHOLE amount into the betting pocket — plus a hand-rolled merchant
        // debit below. A subset of `moveDepositMoney`, and it differed from it
        // in three ways that all reached a real person:
        //
        //   the SPLIT     `deposit_policies` decides how a deposit divides
        //                 between the betting balance and the reserve (§2), and
        //                 this path did not ask it. The same ₹1,000 landed as
        //                 ₹900 + ₹100 when confirmed normally and ₹1,000 + ₹0
        //                 when released through a dispute — measured, on a live
        //                 server, before this change.
        //   the UTR       never released, so the reference stayed held against
        //                 an order that had finished.
        //   the STREAK    `clearPlayerPaymentFailures` never ran. That is the
        //                 one point where the money is KNOWN to have arrived,
        //                 and a dispute resolved in the player's favour is
        //                 exactly that. So a player who was right, and whom an
        //                 admin agreed with, kept a payment-failure strike —
        //                 and three of those stop them opening a new order for
        //                 an hour, on both rails (§2).
        //
        // A DISPUTED buy keeps its pool hold, so this spends it. If the hold is
        // somehow gone and the pool cannot cover it, `moveDepositMoney` reports
        // it and the log below makes it a case a person sees.
        // Completed by the transition above, so it is paid out from COMPLETED.
        const moved = await moveDepositMoney(order, {
          creditDeposit, creditReserve, releaseUTR, requireState: 'COMPLETED',
        });
        if (!moved.ok) {
          // `moveDepositMoney` has already reported it. Loud here too: the
          // order is resolved and the player is not credited, which is a repair
          // case a person has to see.
          console.error(`[dispute resolve] ${order.orderId} released but money did not move:`, moved.reason);
        }
      } else {
        // WITHDRAWAL release: the merchant paid the player, so the stake leaves
        // the player and the merchant is credited. This only cleared the escrow
        // flag — "completing is all that is left" — and moved nothing: the stake
        // stayed locked for good, the merchant was never credited, and a HELD
        // settlement stayed RESERVED on an order the sweep can no longer reach
        // (it takes PAID orders only). Through the one owner now (F-027).
        const ended = await endWithdrawalAs('RELEASE');
        if (!ended.ok) {
          console.error(`[dispute resolve] ${order.orderId} released but money did not move:`, ended.reason);
        }
        await emitWalletUpdate(order.userId);
      }

      // The merchant debit was HERE, as a second call carrying the same
      // canonical txId. `moveDepositMoney` above owns it now — it debits the
      // merchant and credits the player as one decision, which is the whole
      // point of there being one owner. Two calls with one key worked only
      // because the key made the second a no-op; that is idempotency covering
      // for a duplicate, not an absence of one.

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
      // Refund: cancel order, return what is held
      if (order.type === 'DEPOSIT') {
        // No tokens were credited to the player yet, so none come back — but
        // the merchant's tokens held for this buy do. This route released
        // nothing, leaving them for the stranded-hold sweep.
        await db.teamPools.releaseBuyHold(order.orderId, { actor: `admin:${req.user.userId}`, reason: reason.trim() });
      } else {
        // WITHDRAWAL: the stake goes back OUT OF THE LOCK. This credited
        // winnings and left the lock standing, so the wallet read the amount
        // twice; on a HELD withdrawal it also left the settlement RESERVED.
        const ended = await endWithdrawalAs('REFUND');
        if (!ended.ok) {
          console.error(`[dispute resolve] ${order.orderId} refunded but money did not move:`, ended.reason);
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

    // After the money: the suspension narrates a decision that has committed
    // and its money that has moved (§21), and must not stand in front of them.
    await recordDisputeLoser(asDecided, outcome);

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
