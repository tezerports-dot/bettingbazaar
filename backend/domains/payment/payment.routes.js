// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** payment.routes.js — player-facing Payment domain routes (BBEPS Phase 003 §3.3).
 * Moved from backend/routes/payment.routes.js on 2026-07-01 (BBEPS Phase 004 migration). */
import express   from 'express';
import { db }    from '#db';
import { authenticate, requireApprovedKyc } from '../identity/auth.middleware.js';
import { tryVerifyJwt } from '../identity/jwt.util.js';
import { merchantAuth } from '../../middleware/merchantAuth.js';
import { withdrawalLimiter } from '../../middleware/security.js';
// Wallet operations are for channel members — same gate as betting.
import { requireChannelMembership } from '../../middleware/requireChannelMembership.js';
// Item 12: per-subnet backstop against IP rotation on withdrawal creation.
import { createSubnetLimiter, globalSurgeBreaker } from '../../middleware/ipDefense.js';
import { markOrderPaid, cancelOrder } from './paymentProcessing.service.js';
// The order state machine — every status change is a guarded transition.
import { completeOrder, disputeOrder } from './orderLifecycle.service.js';
// Phase 009: money movement enters ONLY via the Funding Platform authority.
import { requestDeposit, requestWithdrawal } from '../funding/fundingAuthority.service.js';
import { creditDeposit, creditReserve } from '../wallet/walletAuthority.service.js';
// One rule for how a confirmed deposit splits across the user's two pockets,
// and for what the merchant is debited against it.
import { depositCreditSplit } from './depositCredit.js';
import { debitMerchantTokens } from '../merchant/merchantWallet.service.js';
import { releaseUTR } from '../../middleware/utrValidation.js';
import { emitWalletUpdate, emitAdminUpdate, emitOrderUpdate } from '../notification/realtimeEmitters.js';

const router = express.Router();

function extractBearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function paymentActorAuth(req, res, next) {
  const decoded = tryVerifyJwt(extractBearer(req) || req.cookies?.auth_token || '');
  if (decoded?.isMerchant) return merchantAuth(req, res, next);
  return authenticate(req, res, next);
}

/**
 * What a merchant may see of an order.
 *
 * The player's phone number, bank details and UPI id are on the order because a
 * merchant needs them to PAY a withdrawal — they have no business in a deposit
 * response, where the money flows the other way. Stripped by construction
 * rather than by remembering not to send them.
 */
function sanitizeOrderForMerchant(order) {
  const plain = { ...(order || {}) };
  delete plain.userPhone;
  delete plain.merchantSnapshot;
  delete plain.userBankDetails;
  delete plain.upiId;
  return plain;
}

router.post('/deposit/create', authenticate, requireApprovedKyc, requireChannelMembership({ action: 'add funds' }), async (req, res) => {
  try {
    const result = await requestDeposit({ userId: req.user.userId, tokenAmount: Number(req.body.tokenAmount) });
    res.json({ success: true, message: 'Deposit request created. Waiting for merchant assignment.', ...result });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message, code: err.code }); }
});

router.post('/withdrawal/create', authenticate, requireApprovedKyc, requireChannelMembership({ action: 'withdraw' }), withdrawalLimiter, createSubnetLimiter('withdrawal'), globalSurgeBreaker('withdrawal'), async (req, res) => {
  try {
    const result = await requestWithdrawal({ userId: req.user.userId, tokenAmount: Number(req.body.tokenAmount) });
    res.json({ success: true, message: 'Withdrawal request created. Waiting for merchant assignment.', ...result });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message, code: err.code, cutoffPassed: err.cutoffPassed, balance: err.balance }); }
});

router.post('/order/:orderId/mark-paid', authenticate, async (req, res) => {
  try {
    const { utrNumber, proofFileKey, proofCdnUrl } = req.body;
    if (!utrNumber?.trim()) return res.status(400).json({ success: false, message: 'utrNumber is required' });
    if (!proofFileKey?.trim()) return res.status(400).json({ success: false, message: 'proofFileKey is required. Upload a payment screenshot file first.' });
    const order = await markOrderPaid(req.user.userId, req.params.orderId, utrNumber, proofFileKey, proofCdnUrl);
    res.json({ success: true, message: 'Payment marked. Awaiting merchant review.', order });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message, code: err.code, originalOrderId: err.originalOrderId }); }
});

/**
 * POST /api/payment/:orderId/confirm — the merchant (or an admin) asserts the
 * player's money arrived, and the tokens are dispensed.
 *
 * ── Ordering, and what a failure leaves behind ──────────────────────────────
 * The money moves BEFORE the status does. Every movement is idempotent on a
 * deterministic key, so a failure part-way through leaves a retryable position
 * rather than something to unwind: the order is still PAID, the next confirm
 * replays the movements as no-ops and completes it.
 *
 * The other order — status first, then money — is what this was, and it has a
 * worse failure: the order reads COMPLETED while the merchant was never debited
 * and the player never credited, and nothing in the system is looking for that.
 *
 * The TRANSITION is still the gate for the RESPONSE. Two confirms in flight (a
 * merchant clicking while an admin force-approves is the real case) both move
 * no money the second time, and exactly one is told it completed the order.
 *
 * The `session` this used to open is gone. `safeSession` caught a failure to
 * start a transaction and carried on WITHOUT one, so the atomicity it appeared
 * to provide was conditional on nobody looking.
 */
router.post('/deposit/:orderId/confirm', paymentActorAuth, async (req, res) => {
  const isMerchantActor = Boolean(req.merchantId);
  const isAdminActor = Boolean(req.user?.isAdmin);
  if (!isMerchantActor && !isAdminActor) {
    return res.status(403).json({ success: false, message: 'Only merchants or admins can confirm deposits' });
  }
  try {
    const order = await db.orders.getOrderRecord(req.params.orderId);
    if (!order || order.type !== 'DEPOSIT') {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (isMerchantActor && String(order.merchantId) !== String(req.merchantId)) {
      return res.status(403).json({ success: false, message: 'This order is not assigned to you' });
    }
    if (!['PAID', 'PROCESSING'].includes(order.status)) {
      // A read, not the gate — the transition below settles the race. This
      // exists so an already-completed order gets a clear answer instead of a
      // 409 the merchant panel renders as a failure.
      if (order.status === 'COMPLETED') {
        return res.json({
          success: true, message: 'Deposit already completed',
          order: isMerchantActor ? sanitizeOrderForMerchant(order) : order,
        });
      }
      return res.status(409).json({ success: false, message: `Cannot confirm in ${order.status} status` });
    }

    // The player's pockets are split; the merchant's side is not. This route
    // once debited `depositAllocation || tokenAmount` and credited
    // `depositAllocation + reserveAllocation`, so every deposit with a reserve
    // share credited more than it debited. `depositCredit.js` holds the one
    // rule and why it is one rule.
    const { depositCredit, reserveCredit, total } = depositCreditSplit(order);

    // ── The merchant's side, first ──────────────────────────────────────────
    // Refusing here is the ordinary case (a merchant confirming more than they
    // hold) and it must refuse BEFORE anything else moves. Keyed so a retry
    // debits once.
    const { merchant: debited } = await debitMerchantTokens({
      merchantId: order.merchantId, amount: total,
      reason: `Deposit ${order.orderId} confirmed — tokens dispensed to user`,
      refModel: 'PaymentOrder', refId: order.orderId,
      txId: `mw_dep_deduct_${order.orderId}`,
    });
    if (!debited) {
      return res.status(400).json({ success: false, message: 'Merchant insufficient token balance' });
    }

    // ── The player's side ───────────────────────────────────────────────────
    // Both keyed on the order, so a retry after a partial failure credits once.
    // `reserveBalance` goes through the wallet authority like everything else;
    // it was once a raw increment with no ledger trail behind it.
    if (depositCredit > 0) await creditDeposit(order.userId, depositCredit, order.orderId);
    if (reserveCredit > 0) await creditReserve(order.userId, reserveCredit, order.orderId);
    await releaseUTR(order.orderId);

    // ── The gate, and the record that the money moved ───────────────────────
    // `completeOrder` posts the DEPOSIT_COMPLETED accounting event in the SAME
    // transaction as the state change, so a completed order always has its
    // ledger entry.
    const confirmed = await completeOrder(order.orderId, {
      expectFrom: ['PAID', 'PROCESSING'],
      set: {
        completedAt: new Date(),
        approvedBy: req.merchantId || req.user.userId,
        approvedAt: new Date(),
      },
    });
    if (!confirmed.ok) {
      // The money moved and the order would not advance. That is a repair case,
      // not a rollback: the movements are keyed, so the next confirm replays
      // them as no-ops. It must be loud rather than silent.
      console.error(`[deposit-confirm] ${order.orderId} money moved but transition refused:`, confirmed.reason);
      return res.status(409).json({
        success: false,
        message: `Cannot confirm in ${confirmed.status ?? 'unknown'} status`,
      });
    }

    await emitWalletUpdate(order.userId);

    // The POST-transition order, not the one read at the top.
    const settled = confirmed.order ?? order;
    res.json({
      success: true,
      message: confirmed.idempotent ? 'Deposit already completed' : 'Deposit completed',
      order: isMerchantActor ? sanitizeOrderForMerchant(settled) : settled,
    });
  } catch (err) {
    console.error('POST /deposit/:orderId/confirm error:', err);
    res.status(500).json({ success: false, message: 'Failed to confirm deposit' });
  }
});

router.get('/orders', authenticate, async (req, res) => {
  try {
    const { status, type, limit = 20, skip = 0 } = req.query;
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const parsedSkip  = Math.max(parseInt(skip, 10) || 0, 0);
    // Page and total from ONE query. `find()` plus `countDocuments()` are two
    // reads of a table that accepts an order between them, so a player watching
    // their own history saw a footer that disagreed with the rows above it.
    const { orders, total } = await db.orders.findOrders({
      userId: req.user.userId,
      state: status || null,
      orderType: type || null,
      limit: parsedLimit,
      offset: parsedSkip,
    });
    res.json({ success: true, orders, pagination: { total, limit: parsedLimit, skip: parsedSkip } });
  } catch (err) {
    console.error('GET /payment/orders error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch orders' });
  }
});

/**
 * One order, and the ownership check that goes with it.
 *
 * Three handlers below repeated the same `$or` over an order id and a
 * conditionally-valid ObjectId, then compared `order.userId` after the fetch.
 * An order id is the id now — there is no second key to match on — and the
 * ownership test lives here so a handler cannot be added without one.
 *
 * Returns null when the order does not exist OR the caller may not see it: a
 * distinguishable 404-vs-403 tells someone probing ids which ones are real.
 */
async function ownedOrder(req) {
  const order = await db.orders.getOrderRecord(req.params.orderId);
  if (!order) return null;
  if (String(order.userId) !== String(req.user.userId) && !req.user.isAdmin) return null;
  return order;
}

router.get('/order/:orderId', authenticate, async (req, res) => {
  try {
    const order = await ownedOrder(req);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    res.json({ success: true, order });
  } catch (err) {
    console.error('GET /payment/order/:orderId error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch order' });
  }
});

// Fixed 1:1 internal conversion (Phase 006 flattening, 2026-07-08) — no
// buy/sell spread. Response shape kept for client compatibility.
router.get('/rates', async (req, res) => {
  res.json({ success: true, rates: { buyRate: 1, sellRate: 1, merchantProfitPerToken: 0 } });
});

router.post('/order/cancel', authenticate, async (req, res) => {
  try {
    await cancelOrder(req.user.userId, req.user.isAdmin, req.body.orderId);
    res.json({ success: true, message: 'Order cancelled' });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message }); }
});

// ─── GET /api/payment/order/:orderId/status — lightweight poll (Section 2B) ──
// Returns only the fields the frontend needs to poll during active payment flow.
router.get('/order/:orderId/status', authenticate, async (req, res) => {
  try {
    const order = await ownedOrder(req);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // The proof screenshot expires. The fallback is 48 hours from creation for
    // an order written before the column existed — an absent expiry must not
    // read as "never expires" on a payment screenshot.
    const proofExpiresAt = order.proofExpiresAt
      || new Date(new Date(order.createdAt).getTime() + 48 * 60 * 60 * 1000);
    const proofVisible = new Date(proofExpiresAt).getTime() > Date.now();

    res.json({
      success: true,
      status:           order.status,
      expiresAt:        order.expiresAt,
      merchantSnapshot: order.merchantSnapshot,
      utrNumber:        order.utrNumber,
      proofScreenshot:  proofVisible ? order.proofScreenshot : null,
    });
  } catch (err) {
    console.error('GET /payment/order/:orderId/status error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch order status' });
  }
});

// ─── POST /api/payment/order/:orderId/dispute — user raises dispute (Section 2B) ─
// User can dispute DEPOSIT order that is PAID but merchant isn't confirming.
router.post('/order/:orderId/dispute', authenticate, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ success: false, message: 'reason is required' });

    const order = await ownedOrder(req);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'PAID')
      return res.status(400).json({ success: false, message: 'Can only dispute PAID orders' });

    // Require at least 10 minutes since paidAt before dispute is allowed.
    // This check stays a pre-read: it is a policy about elapsed time, not about
    // the state, and the transition below is what settles the race.
    const paidAt   = order.paidAt ? new Date(order.paidAt).getTime() : 0;
    const tenMin   = 10 * 60 * 1000;
    if (Date.now() - paidAt < tenMin)
      return res.status(400).json({ success: false, message: 'Please wait at least 10 minutes before raising a dispute' });

    const disputed = await disputeOrder(order.orderId, {
      expectFrom: 'PAID',
      set: {
        disputeReason:   reason.trim(),
        disputeRaisedAt: new Date(),
        disputeRaisedBy: 'user',
      },
    });
    if (!disputed.ok) {
      // 409, not 400: understood and refused because the order moved on — a
      // merchant confirming while the user was typing is the ordinary case.
      return res.status(409).json({ success: false, message: `Cannot dispute an order that is ${disputed.status ?? 'missing'}` });
    }

    // Notify admin SSE (GOVERNANCE §11: order_disputed)
    emitAdminUpdate('order_disputed', {
      orderId:   order.orderId,
      raisedBy:  'user',
      reason:    reason.trim(),
      server_ts: Date.now(),
    });

    res.json({ success: true, message: 'Dispute raised. Admin will review shortly.', order: disputed.order ?? order });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/order/:orderId/status', authenticate, async (req, res) => {
  try {
    const { status, reason = 'User requested dispute' } = req.body;
    if (status !== 'DISPUTED') return res.status(400).json({ success: false, message: 'Only DISPUTED transition is supported here' });
    const order = await ownedOrder(req);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    const moved = await disputeOrder(order.orderId, {
      expectFrom: 'PAID',
      set: {
        disputeReason:   String(reason).trim().slice(0, 1000),
        disputeRaisedAt: new Date(),
        disputeRaisedBy: 'user',
      },
    });
    if (!moved.ok) {
      return res.status(409).json({ success: false, message: `Cannot transition ${moved.status ?? 'unknown'} → ${status}` });
    }
    emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: moved.status });
    res.json({ success: true, order: moved.order ?? order });
  } catch (err) { res.status(500).json({ success: false, message: 'Failed to update status' }); }
});

export default router;
