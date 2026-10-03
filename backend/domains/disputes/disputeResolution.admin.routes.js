// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)

import { express, authenticate, isAdmin, hasPermission } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
import { creditDeposit, creditReserve } from '../wallet/walletAuthority.service.js';
import { moveDepositMoney } from '../payment/depositCredit.js';
// The one owner of how an admin decision ends a withdrawal's money (F-027),
// and of a cancelled buy's merchant hold.
import { endWithdrawal } from '../payment/withdrawalHold.service.js';
import { recordDisputeLoser, faultPreview } from './disputeOutcome.service.js';
import { releaseUTR } from '../../middleware/utrValidation.js';
import { emitMerchantUpdate } from '../notification/realtimeEmitters.js';
// The order state machine. Resolving a dispute is a guarded transition, and it
// runs BEFORE any money moves so that it is what decides the race.
import { completeOrder, cancelOrder } from '../payment/orderLifecycle.service.js';
// Order chat — the record a dispute is decided from. Every write here used to
// name a model registered nowhere, so nothing was ever recorded.
import { listMessages, postMessage, postSystemMessage } from '#db/repositories/chat.js';

const router = express.Router();


/**
 * GET /api/admin/orders/stalled-withdrawals — payouts nobody has taken.
 *
 * A withdrawal that cannot find a team member WAITS rather than failing: the
 * player's tokens are locked behind it, and a member may come online.
 *
 * The price is a token lock with no deadline, which is exactly why this queue
 * exists. An order with no deadline and no owner is an order nobody is
 * answerable for; a payout past the assignment window appears here so somebody
 * is. The player can also cancel it themselves and take the tokens back — the
 * two together are what make waiting a decision instead of a leak.
 *
 * `olderThanMinutes` accepts 0, which is how an admin asks "everything waiting
 * right now" during an incident. `??`, never `||`, for exactly that reason.
 */
router.get('/orders/stalled-withdrawals', authenticate, hasPermission('canResolveDisputes'), async (req, res) => {
  try {
    const asked = parseInt(req.query.olderThanMinutes, 10);
    const olderThanMinutes = Number.isFinite(asked) && asked >= 0 ? asked : 25;
    const orders = await db.orders.stalledWithdrawals({ olderThanMinutes });
    res.json({
      success: true,
      olderThanMinutes,
      orders: orders.map((o) => ({
        orderId:    o.orderId,
        userId:     o.userId,
        amount:     o.fiatAmount,
        tokenAmount: o.tokenAmount,
        createdAt:  o.createdAt,
      })),
    });
  } catch (error) {
    console.error('List stalled withdrawals error:', error);
    res.status(500).json({ success: false, message: 'Failed to list stalled withdrawals' });
  }
});

router.get('/dispute-orders', authenticate, hasPermission('canResolveDisputes'), async (req, res) => {
  try {
    const { status = 'DISPUTED', page = 1, limit = 50 } = req.query;

    // The page and its total come from ONE statement, and both parties from a
    // join. The version this replaced ran the find and the count concurrently
    // — so on a queue people are actively working, the total could describe a
    // different instant than the rows — and called `.populate()` twice on plain
    // rows, which is a TypeError.
    const queue = await db.orders.disputeQueue({ status, page, limit });

    // Mapped to the shape DisputeManager.tsx expects.
    const disputes = queue.disputes.map((o) => {
      // Who each of the screen's two decisions would suspend, from the rule's
      // one owner, so the screen keeps no copy of it. On a buy, "to the user"
      // completes the order; on a sell it refunds the player.
      const preview = o.status === 'DISPUTED' ? faultPreview(o, o.disputedFrom) : { ifCompleted: null, ifNotCompleted: null };
      const buy = o.type === 'DEPOSIT';
      return {
      _id:               o.orderId,
      orderId:           o.orderId,
      type:              o.type,
      amount:            o.fiatAmount,
      fiatAmount:        o.fiatAmount,
      tokenAmount:       o.tokenAmount,
      status:            o.status,
      createdAt:         o.createdAt,
      disputedAt:        o.disputeRaisedAt,
      // Both consumers render "Raised by <who> · <when>"; the mapper dropped
      // them, so that line silently never appeared.
      disputeRaisedAt:   o.disputeRaisedAt,
      disputeRaisedBy:   o.disputeRaisedBy,
      resolvedAt:        o.disputeResolvedAt,
      disputeReason:     o.disputeReason,
      disputeResolution: o.disputeResolution,
      disputeDecision:   o.disputeDecision,
      proofScreenshot:   o.proofScreenshot,
      utrNumber:         o.utrNumber,
      userId:            o.user,
      merchantId:        o.merchant,
      resolvedBy:        o.disputeResolvedBy,
      suspendsIfToUser:     buy ? preview.ifCompleted : preview.ifNotCompleted,
      suspendsIfToMerchant: buy ? preview.ifNotCompleted : preview.ifCompleted,
      };
    });

    res.json({
      success: true, disputes,
      total: queue.total, page: queue.page, limit: queue.limit, pages: queue.pages,
    });
  } catch (err) {
    console.error('GET /dispute-orders error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch disputes' });
  }
});

// ── GET /api/admin/dispute-orders/:orderId — single dispute detail ────────────
router.get('/dispute-orders/:orderId', authenticate, hasPermission('canResolveDisputes'), async (req, res) => {
  try {
    // The join names the merchant. `.populate()` on the plain object the
    // repository returns is a TypeError, so this endpoint threw on every call.
    const order = await db.orders.getOrderWithParties(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    res.json({ success: true, dispute: order });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch dispute' });
  }
});


router.get('/dispute-orders/:orderId/chat', authenticate, hasPermission('canResolveDisputes'), async (req, res) => {
  try {
    const messages = await listMessages(req.params.orderId);
    res.json({ success: true, messages });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch chat' });
  }
});


router.post('/dispute-orders/:orderId/chat', authenticate, hasPermission('canResolveDisputes'), async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ success: false, message: 'Message required' });
    
    const msg = await postMessage({
      orderId:    req.params.orderId,
      senderId:   req.user.userId,
      senderType: 'ADMIN',
      message:    message.trim(),
      isSystem:   false,
    });

    // Tell the player in real time. The merchant is NOT told, and that is a
    // recorded gap rather than a choice (PROJECT_STATUS §3.9): this emitted to
    // a socket room no merchant client ever joined, and the merchant panel has
    // no order chat to show the message in. Routing it to the merchant's SSE
    // `order_update` as it stood would have merged `type: 'ADMIN_MESSAGE'`
    // over the order's own type in the merchant's list.
    const order = await db.orders.getOrderRecord(req.params.orderId);
    if (order) {
      global.io?.to(`user-${order.userId}`).emit('support_reply', { orderId: order._id, message: message.trim() });
    }

    res.json({ success: true, message: msg });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to send message' });
  }
});

// ── POST /api/admin/dispute-orders/:orderId/resolve ──────────────────────────
// The core resolution endpoint.
// decision: RELEASE_TO_USER | RELEASE_TO_MERCHANT | CANCEL_ORDER
//

//   DEPOSIT dispute:
//     RELEASE_TO_USER     → credit tokens to user (payment confirmed by admin)
//     RELEASE_TO_MERCHANT → cancel order, no token movement (user did not pay)
//     CANCEL_ORDER        → cancel, no token movement
//
//   WITHDRAWAL dispute:
//     RELEASE_TO_USER     → refund locked tokens back to user (merchant did not release)
//     RELEASE_TO_MERCHANT → complete withdrawal (merchant confirms payment was made)
//     CANCEL_ORDER        → refund tokens to user (safe default)
router.post('/dispute-orders/:orderId/resolve', authenticate, hasPermission('canResolveDisputes'), async (req, res) => {
  try {
    const { decision, resolution } = req.body;
    
    const validDecisions = ['RELEASE_TO_USER', 'RELEASE_TO_MERCHANT', 'CANCEL_ORDER'];
    if (!validDecisions.includes(decision)) {
      return res.status(400).json({ success: false, message: 'Invalid decision' });
    }
    if (!resolution?.trim()) {
      return res.status(400).json({ success: false, message: 'Resolution notes required' });
    }

    const order = await db.orders.getOrderRecord(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!['DISPUTED', 'PROCESSING', 'PAID', 'ASSIGNED'].includes(order.status)) {
      return res.status(400).json({ success: false, message: `Cannot resolve order in status: ${order.status}` });
    }

    // Never the mobile: this name goes into the order's timeline, which the
    // player reads, and nobody learns another person's number (owner, 2026-10-03).
    const adminName = req.user?.username || 'Admin';
    let systemMessage = '';
    // The order as it stood when the decision was taken: whoever lost a
    // DISPUTE is suspended (2c+), and only a DISPUTED order was one.
    const asDecided = { ...order };

    // ── THE TRANSITION IS THE GATE, and it runs before the money ─────────────
    //
    // Every branch below moves value — creditDeposit, settleHold, reverseHold,
    // creditWinnings — and all of it used to run BEFORE `order.status` was
    // assigned, guarded only by the status read above. Two admins resolving the
    // same dispute both passed that read and both moved money; what stopped the
    // duplicate was the idempotency key on each individual wallet call, which
    // means the protection lived in a different domain from the decision, and
    // the two directions (release vs refund) were not protected against each
    // other at all — one admin releasing while another refunded ran BOTH.
    //
    // The outcome is a pure function of the order type and the decision, so it
    // can be settled first and then gate everything that follows.
    const releasesToUser     = order.type === 'DEPOSIT'    && decision === 'RELEASE_TO_USER';
    const releasesToMerchant = order.type === 'WITHDRAWAL' && decision === 'RELEASE_TO_MERCHANT';
    const newStatus = (releasesToUser || releasesToMerchant) ? 'COMPLETED' : 'CANCELLED';

    const moved = await (newStatus === 'COMPLETED' ? completeOrder : cancelOrder)(order._id, {
      set: {
        disputeDecision:   decision,
        disputeResolution: resolution,
        // The settable columns are dispute_resolved_at / dispute_resolved_by.
        // This wrote `resolvedAt` / `resolvedBy`, which setOrderFields refuses as
        // unknown — so the detail write threw AFTER the status had already moved,
        // leaving the order COMPLETED/CANCELLED with no decision recorded and no
        // money moved, and the admin a 500. Every dispute resolution failed.
        disputeResolvedAt: new Date(),
        disputeResolvedBy: req.user.userId,
        ...(newStatus === 'COMPLETED' ? { completedAt: new Date() } : { cancelledAt: new Date() }),
      },
    });
    if (!moved.ok) {
      // 409, not 400: understood and refused because the order is no longer in
      // a state this resolution applies to.
      return res.status(409).json({
        success: false,
        message: moved.reason === 'pool_paid'
          ? 'The team\'s tokens for this buy were already paid to the player, so it can only be completed.' : `Cannot resolve order in status: ${moved.status ?? 'missing'}`,
      });
    }
    // A withdrawal's money step is keyed end to end: replaying it repairs a
    // first click that failed part-way and moves nothing when it succeeded.
    const withdrawalDecision = releasesToMerchant ? 'RELEASE' : 'REFUND';
    const outcome = { completed: newStatus === 'COMPLETED', decision, by: req.user.userId };
    if (moved.idempotent) {
      if (order.type === 'WITHDRAWAL') {
        await endWithdrawal(order.orderId, withdrawalDecision, { reason: resolution, by: req.user.userId });
      }
      // Keyed by the order: repairs a first decision whose suspension did not
      // land, and records nothing twice.
      await recordDisputeLoser(asDecided, outcome);
      return res.json({ success: true, message: 'Dispute already resolved', order: moved.order ?? order });
    }

    // ── Apply token movement based on decision + order type ──────────────────
    if (order.type === 'DEPOSIT') {
      if (decision === 'RELEASE_TO_USER') {
        // ── Through `moveDepositMoney`, the one owner of a deposit credit ──
        // This was `creditDeposit(userId, order.tokenAmount, <a sentence>)`,
        // and it was wrong in four ways at once. Every one of them reached
        // money, and this is the route the Disputes screen actually calls.
        //
        //  1. TOKENS WERE MINTED. Nothing debited the merchant side: the player
        //     was credited and the tokens came from nowhere, so a released
        //     dispute broke the conservation the whole settlement design rests
        //     on. `moveDepositMoney` spends the team pool's hold.
        //
        //  2. THE IDEMPOTENCY KEY WAS A SENTENCE. The third argument is the
        //     ORDER ID — `creditDeposit` builds `dep_complete_<orderId>` from
        //     it. Passing "Dispute resolved — deposit credited: DEP_…" makes a
        //     DIFFERENT key from the one the normal confirm uses, so the gate
        //     could not see that the deposit had already been credited: an
        //     order confirmed normally and then released here was paid TWICE.
        //     `moveDepositMoney` warns about exactly this in as many words —
        //     "a sentence here would make a second key for the same deposit and
        //     open the idempotency gate."
        //
        //  3. NO SPLIT. `deposit_policies` decides how a deposit divides
        //     between the betting balance and the reserve (§2); the whole
        //     amount went to the betting pocket.
        //
        //  4. NO UTR RELEASE, AND NO STREAK CLEAR. A dispute resolved in the
        //     player's favour IS the money arriving, which is the one point
        //     where `clearPlayerPaymentFailures` is meant to run — so a player
        //     who was right, and whom an admin agreed with, kept a
        //     payment-failure strike toward an hour-long buying lockout.
        //
        // A DISPUTED buy keeps its pool hold, so this spends it. If the hold
        // is somehow gone and the pool cannot cover it, `moveDepositMoney`
        // reports it and the log below makes it a case a person sees.
        // Completed by the transition above, so it is paid out from COMPLETED.
        const moved = await moveDepositMoney(order, {
          creditDeposit, creditReserve, releaseUTR, requireState: 'COMPLETED',
        });
        if (!moved.ok) {
          console.error(`[dispute resolve] ${order.orderId} released but money did not move:`, moved.reason);
        }
        systemMessage = `✅ Admin Decision: DEPOSIT APPROVED\n` +
          `${order.tokenAmount} tokens credited to user deposit balance.\n` +
          `Resolution: ${resolution}`;
      } else {
        // RELEASE_TO_MERCHANT or CANCEL — the player did not pay, so nothing
        // reaches them; the team's tokens held for this buy go back to its pool.
        await db.teamPools.releaseBuyHold(order.orderId, { actor: `admin:${req.user.userId}`, reason: resolution });
        systemMessage = `❌ Admin Decision: DEPOSIT REJECTED\n` +
          `No payment confirmed. Order cancelled. No token movement.\n` +
          `Resolution: ${resolution}`;
      }
    } else {
      // ── WITHDRAWAL — through the one owner ─────────────────────────────────
      // This branch read "not HELD" as "already settled", and it is not: a
      // withdrawal disputed before its merchant confirmed is not HELD and its
      // stake is still LOCKED. A refund there credited winnings beside the lock
      // (the wallet read double) and a release moved nothing at all. On a HELD
      // withdrawal the refund went through `reverseHold`, which wrote the order
      // back to DISPUTED after this route had cancelled it — a resolved dispute
      // back in the queue. `endWithdrawal` knows all three positions (F-027).
      const ended = await endWithdrawal(order.orderId, withdrawalDecision, {
        reason: `Dispute resolved by ${adminName}: ${resolution}`, by: req.user.userId,
      });
      if (!ended.ok) {
        console.error(`[dispute resolve] ${order.orderId} resolved but money did not move:`, ended.reason);
      }
      if (withdrawalDecision === 'RELEASE') {
        systemMessage = `✅ Admin Decision: WITHDRAWAL COMPLETED\n` +
          `Payment confirmed. ${order.tokenAmount} tokens released to the team.\n` +
          `Resolution: ${resolution}`;
      } else if (ended.afterSettlement) {
        systemMessage = `🔄 Admin Decision: WITHDRAWAL REFUNDED\n` +
          `${order.tokenAmount} tokens returned to user winnings balance.\n` +
          `Resolution: ${resolution}`;
        console.warn(`[dispute] Withdrawal ${order.orderId} refunded AFTER settlement — ` +
          `team ${order.teamId}'s pool had already been credited ${order.tokenAmount}.`);
      } else {
        systemMessage = `🔄 Admin Decision: WITHDRAWAL REVERSED\n` +
          `Payment was not received. ${order.tokenAmount} tokens returned to your balance.\n` +
          `Resolution: ${resolution}`;
      }
    }

    // ── Whoever was wrong is suspended (2c+) ──────────────────────────────────
    // This was an optional "penalty" the panel sent under a name the route
    // never read, which then moved nothing and said "manual action required".
    // The owner's rule replaces it: the party the decision went against is
    // suspended until staff lift it, and a third lost dispute opens high-risk
    // review that only an admin can close.
    const fault = await recordDisputeLoser(asDecided, outcome);
    if (fault.ok && !fault.already) {
      systemMessage += `\n⛔ ${fault.party === 'PLAYER' ? 'The player' : 'The team member'} lost this dispute and is suspended`
        + (fault.highRisk ? ` (lost disputes: ${fault.lostCount} — high-risk admin review)` : '') + '.';
    }

    // The order was written by the transition above, decision fields and all —
    // there is no second save, and therefore no window in which the money has
    // moved but the order does not yet say so.
    Object.assign(order, moved.order);

    
    // A notice, not the resolution: the money and the transition are already
    // committed above, and a failure to narrate them must not undo them.
    await postSystemMessage(
      order._id,
      `⚖️ DISPUTE RESOLVED by ${adminName}\n${systemMessage}`,
      { senderId: req.user.userId, senderType: 'ADMIN' },
    );

    // ── Notify both parties ───────────────────────────────────────────────────
    const payload = { orderId: order._id, status: newStatus, decision, resolution };
    global.io?.to(`user-${order.userId}`).emit('order_update', payload);
    global.io?.to(`user-${order.userId}`).emit('support_reply', {
      orderId: order._id,
      message: `Your dispute has been resolved. Decision: ${decision.replace(/_/g, ' ')}`,
    });
    // The merchant's live feed is SSE; this went to a socket room no merchant
    // client ever joined, so a resolved dispute stayed DISPUTED on the
    // merchant's screen until they reloaded (§32 S17). The order's id and its
    // new state are all their list needs — the decision text is the admin's.
    if (order.merchantId) {
      emitMerchantUpdate(order.merchantId, 'order_update', {
        orderId: order._id, status: newStatus, server_ts: Date.now(),
      });
    }
    global.sseManager?.broadcastToAdmins('queue_order_update', payload);

    res.json({ success: true, message: 'Dispute resolved successfully', order });
  } catch (err) {
    console.error('POST /dispute-orders/:orderId/resolve error:', err);
    res.status(500).json({ success: false, message: 'Failed to resolve dispute' });
  }
});

// ── POST /api/admin/dispute-orders/:orderId/escalate ─────────────────────────
router.post('/dispute-orders/:orderId/escalate', authenticate, hasPermission('canResolveDisputes'), async (req, res) => {
  try {
    const { notes } = req.body;
    const order = await db.orders.getOrderRecord(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    
    // ── This assigned three fields to a plain object and called `.save()` ───
    // `getOrderRecord` returns a mapped row, not a document — `.save` is not a
    // function on it, so this threw a TypeError on EVERY call and the catch
    // below returned a 500 having written nothing. The Dispute Manager's
    // escalate button has never once escalated a dispute.
    //
    // No state transition: an escalation is a flag on a DISPUTED order, not a
    // move to a new state, so `setOrderFields` is the whole write and it is one
    // statement — the three fields cannot land apart.
    const escalated = await db.orders.setOrderFields(order.orderId, {
      disputeEscalated: true,
      disputeEscalatedAt: new Date(),
      disputeEscalationNotes: notes?.trim() || 'Escalated to senior admin',
    });

    await postSystemMessage(
      order.orderId,
      `🔺 Dispute ESCALATED to senior admin.\nNotes: ${notes || 'No additional notes'}`,
      { senderId: req.user.userId, senderType: 'ADMIN' },
    );

    await db.audit.recordDetailed({
      performedBy: req.user.userId,
      performedByRole: req.user.isAdmin ? 'admin' : 'subadmin',
      action: 'DISPUTE_ESCALATED', category: 'PAYMENT',
      targetType: 'PaymentOrder', targetId: String(order.orderId),
      details: { notes: notes?.trim() || null },
    });

    res.json({ success: true, message: 'Dispute escalated successfully', order: escalated });
  } catch (err) {
    // The catch was silent — no console.error — so a route that threw on every
    // call left nothing in the log either.
    console.error('POST /dispute-orders/:orderId/escalate error:', err);
    res.status(500).json({ success: false, message: 'Failed to escalate dispute' });
  }
});

export default router;
