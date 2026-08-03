// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)

import { express, mongoose, authenticate, isAdmin, isAdminOrSubAdmin, hasPermission, getModels } from '../../routes/admin/_adminShared.js';
import { creditDeposit, creditWinnings } from '../wallet/walletAuthority.service.js';

const router = express.Router();


router.get('/dispute-orders', authenticate, hasPermission('canResolveDisputes'), async (req, res) => {
  try {
    const { PaymentOrder } = getModels();
    const { status = 'DISPUTED', page = 1, limit = 50 } = req.query;
    
    // Support viewing recently resolved disputes too
    const query = status === 'ALL'
      ? { $or: [{ status: 'DISPUTED' }, { disputeReason: { $exists: true, $ne: '' } }] }
      : { status };
    
    const [orders, total] = await Promise.all([
      PaymentOrder.find(query)
        .sort({ disputedAt: -1, createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .populate('userId', 'username mobile kycStatus')
        .populate('merchantId', 'username mobile')
        .lean(),
      PaymentOrder.countDocuments(query),
    ]);

    // Map to the shape DisputeManager.tsx expects
    const disputes = orders.map(o => ({
      _id:               o._id,
      orderId:           o.orderId,
      type:              o.type,
      amount:            o.fiatAmount,
      fiatAmount:        o.fiatAmount,
      tokenAmount:       o.tokenAmount,
      status:            o.status,
      createdAt:         o.createdAt,
      disputedAt:        o.disputedAt,
      resolvedAt:        o.resolvedAt,
      disputeReason:     o.disputeReason,
      disputeResolution: o.disputeResolution,
      disputeDecision:   o.disputeDecision,
      proofScreenshot:   o.proofScreenshot,
      utrNumber:         o.utrNumber,
      userId:            o.userId,
      merchantId:        o.merchantId,
      resolvedBy:        o.resolvedBy,
    }));

    res.json({ success: true, disputes, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('GET /dispute-orders error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch disputes' });
  }
});

// ── GET /api/admin/dispute-orders/:orderId — single dispute detail ────────────
router.get('/dispute-orders/:orderId', authenticate, hasPermission('canResolveDisputes'), async (req, res) => {
  try {
    const { PaymentOrder } = getModels();
    const order = await PaymentOrder.findById(req.params.orderId)
      .populate('userId', 'username mobile kycStatus walletBalance depositBalance')
      .populate('merchantId', 'username mobile')
      .lean();
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    res.json({ success: true, dispute: order });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch dispute' });
  }
});


router.get('/dispute-orders/:orderId/chat', authenticate, hasPermission('canResolveDisputes'), async (req, res) => {
  try {
    const ChatMessage = mongoose.model('ChatMessage');
    const messages = await ChatMessage.find({ orderId: req.params.orderId })
      .sort({ createdAt: 1 })
      .lean();
    res.json({ success: true, messages });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch chat' });
  }
});


router.post('/dispute-orders/:orderId/chat', authenticate, hasPermission('canResolveDisputes'), async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ success: false, message: 'Message required' });
    
    const ChatMessage = mongoose.model('ChatMessage');
    const msg = await ChatMessage.create({
      orderId:    req.params.orderId,
      senderId:   req.user._id,
      senderType: 'ADMIN',
      message:    message.trim(),
      isSystem:   false,
    });

    // Notify both parties in real time
    const { PaymentOrder } = getModels();
    const order = await PaymentOrder.findById(req.params.orderId).lean();
    if (order) {
      global.io?.to(`user-${order.userId}`).emit('support_reply', { orderId: order._id, message: message.trim() });
      global.io?.to(`merchant-${order.merchantId}`).emit('order_update', { orderId: order._id, type: 'ADMIN_MESSAGE' });
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
router.post('/dispute-orders/:orderId/resolve', authenticate, isAdmin, async (req, res) => {
  try {
    const { decision, resolution, penaltyUser, penaltyMerchant } = req.body;
    
    const validDecisions = ['RELEASE_TO_USER', 'RELEASE_TO_MERCHANT', 'CANCEL_ORDER'];
    if (!validDecisions.includes(decision)) {
      return res.status(400).json({ success: false, message: 'Invalid decision' });
    }
    if (!resolution?.trim()) {
      return res.status(400).json({ success: false, message: 'Resolution notes required' });
    }

    const { PaymentOrder, User } = getModels();
    const ChatMessage = mongoose.model('ChatMessage');
    const order = await PaymentOrder.findById(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!['DISPUTED', 'PROCESSING', 'PAID', 'ASSIGNED'].includes(order.status)) {
      return res.status(400).json({ success: false, message: `Cannot resolve order in status: ${order.status}` });
    }

    const adminName = req.user?.username || req.user?.mobile || 'Admin';
    let systemMessage = '';
    let newStatus = 'CANCELLED';

    // ── Apply token movement based on decision + order type ──────────────────
    if (order.type === 'DEPOSIT') {
      if (decision === 'RELEASE_TO_USER') {
        await creditDeposit(order.userId, order.tokenAmount,
          `Dispute resolved — deposit credited: ${order.orderId}`);
        newStatus = 'COMPLETED';
        systemMessage = `✅ Admin Decision: DEPOSIT APPROVED\n` +
          `${order.tokenAmount} tokens credited to user deposit balance.\n` +
          `Resolution: ${resolution}`;
      } else {
        // RELEASE_TO_MERCHANT or CANCEL — user did not pay; no token movement
        newStatus = 'CANCELLED';
        systemMessage = `❌ Admin Decision: DEPOSIT REJECTED\n` +
          `No payment confirmed. Order cancelled. No token movement.\n` +
          `Resolution: ${resolution}`;
      }
    } else {
      // ── WITHDRAWAL ─────────────────────────────────────────────────────────
      // Two worlds, and conflating them moves money twice or not at all.
      //
      // HELD — the merchant asserted payment but the hold window has not passed,
      // so NOTHING has settled: the player's stake is still locked and the
      // merchant's tokens do not exist. Resolution is therefore a decision about
      // which way to settle something still frozen, and both directions are one
      // idempotent call into the hold service. This is the case the hold exists
      // to create, and it is the only one where nobody can lose.
      //
      // Not HELD — already settled (or the hold is disabled), so the player's
      // stake is consumed and the merchant holds the tokens. Ruling for the
      // player is a genuine clawback, which this route cannot perform against a
      // merchant who has already spent them; it credits the player and flags the
      // merchant balance for manual recovery rather than pretending otherwise.
      const { settleHold, reverseHold } = await import('../payment/withdrawalHold.service.js');
      const wasHeld = order.merchantCreditStatus === 'HELD';

      if (decision === 'RELEASE_TO_MERCHANT') {
        if (wasHeld) {
          // Settles BOTH sides. The previous code set COMPLETED and moved no
          // tokens at all, so an admin ruling for the merchant left the player's
          // stake locked forever and the merchant never paid.
          await settleHold(order._id);
          newStatus = 'COMPLETED';
          systemMessage = `✅ Admin Decision: WITHDRAWAL COMPLETED\n` +
            `Payment confirmed. ${order.tokenAmount} tokens released to the merchant.\n` +
            `Resolution: ${resolution}`;
        } else {
          newStatus = 'COMPLETED';
          systemMessage = `✅ Admin Decision: WITHDRAWAL COMPLETED\n` +
            `Merchant confirmed payment was sent. Already settled — no further token movement.\n` +
            `Resolution: ${resolution}`;
        }
      } else if (wasHeld) {
        // RELEASE_TO_USER / CANCEL inside the window — return the still-locked
        // stake through the wallet authority's inverse of the original debit.
        await reverseHold(order._id, {
          reason: `Dispute resolved by ${adminName}: ${resolution}`,
          by: req.user._id,
        });
        newStatus = 'CANCELLED';
        systemMessage = `🔄 Admin Decision: WITHDRAWAL REVERSED\n` +
          `Payment was not received. ${order.tokenAmount} tokens returned to your balance.\n` +
          `Resolution: ${resolution}`;
      } else {
        // Already settled — the merchant holds these tokens. Credit the player
        // and say plainly that recovering them from the merchant is a separate
        // manual action, rather than silently leaving the platform short.
        //
        // txId added: this ran with no idempotency key, so resolving the same
        // dispute twice credited the player twice.
        await creditWinnings(
          order.userId, order.tokenAmount,
          `Dispute resolved — withdrawal refunded: ${order.orderId}`,
          'PaymentOrder', order._id, `dispute_wd_refund_${order._id}`,
        );
        newStatus = 'CANCELLED';
        systemMessage = `🔄 Admin Decision: WITHDRAWAL REFUNDED\n` +
          `${order.tokenAmount} tokens returned to user winnings balance.\n` +
          `Resolution: ${resolution}`;
        console.warn(`[dispute] Withdrawal ${order.orderId} refunded AFTER settlement — ` +
          `merchant ${order.merchantId} was already credited ${order.tokenAmount}; manual recovery required.`);
      }
    }

    // ── Handle optional penalties ─────────────────────────────────────────────
    if (penaltyUser > 0) {
      // Future: deduct penalty from user balance via walletAuthority
      systemMessage += `\n⚠️ User penalty noted: ${penaltyUser} tokens (manual action required)`;
    }
    if (penaltyMerchant > 0) {
      systemMessage += `\n⚠️ Merchant penalty noted: ${penaltyMerchant} tokens (manual action required)`;
    }

    // ── Update order ─────────────────────────────────────────────────────────
    order.status            = newStatus;
    order.disputeDecision   = decision;
    order.disputeResolution = resolution;
    order.resolvedAt        = new Date();
    order.resolvedBy        = req.user._id;
    if (newStatus === 'COMPLETED') order.completedAt = new Date();
    if (newStatus === 'CANCELLED') order.cancelledAt = new Date();
    await order.save();

    
    await ChatMessage.create({
      orderId: order._id, senderId: req.user._id, senderType: 'ADMIN',
      message: `⚖️ DISPUTE RESOLVED by ${adminName}\n${systemMessage}`,
      isSystem: true,
    });

    // ── Notify both parties ───────────────────────────────────────────────────
    const payload = { orderId: order._id, status: newStatus, decision, resolution };
    global.io?.to(`user-${order.userId}`).emit('order_update', payload);
    global.io?.to(`user-${order.userId}`).emit('support_reply', {
      orderId: order._id,
      message: `Your dispute has been resolved. Decision: ${decision.replace(/_/g, ' ')}`,
    });
    if (order.merchantId) {
      global.io?.to(`merchant-${order.merchantId}`).emit('order_update', payload);
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
    const { PaymentOrder } = getModels();
    const ChatMessage = mongoose.model('ChatMessage');
    
    const order = await PaymentOrder.findById(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    
    order.disputeEscalated = true;
    order.disputeEscalatedAt = new Date();
    order.disputeEscalationNotes = notes || 'Escalated to senior admin';
    await order.save();

    await ChatMessage.create({
      orderId: order._id, senderId: req.user._id, senderType: 'ADMIN',
      message: `🔺 Dispute ESCALATED to senior admin.\nNotes: ${notes || 'No additional notes'}`,
      isSystem: true,
    });

    res.json({ success: true, message: 'Dispute escalated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to escalate dispute' });
  }
});

export default router;
