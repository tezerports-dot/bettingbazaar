// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** payment.routes.js — player-facing Payment domain routes (BBEPS Phase 003 §3.3).
 * Moved from backend/routes/payment.routes.js on 2026-07-01 (BBEPS Phase 004 migration). */
import express   from 'express';
import mongoose  from 'mongoose';
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

async function safeSession() {
  try { const s = await mongoose.startSession(); s.startTransaction(); return s; } catch { return null; }
}
async function commitOrEnd(s) { if (!s) return; try { await s.commitTransaction(); } finally { s.endSession(); } }
async function abortOrEnd(s)  { if (!s) return; try { await s.abortTransaction(); }  finally { s.endSession(); } }
function withSession(s) { return s ? { session: s } : {}; }
function sanitizeOrderForMerchant(order) {
  const plain = typeof order?.toObject === 'function' ? order.toObject() : { ...(order || {}) };
  delete plain.userKycSnapshot;
  delete plain.userPhone;
  delete plain.merchantSnapshot;
  delete plain.userBankDetails;
  delete plain.upiId;
  return plain;
}

router.post('/deposit/create', authenticate, requireApprovedKyc, requireChannelMembership({ action: 'add funds' }), async (req, res) => {
  try {
    const result = await requestDeposit({ userId: req.user._id, tokenAmount: Number(req.body.tokenAmount) });
    res.json({ success: true, message: 'Deposit request created. Waiting for merchant assignment.', ...result });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message, code: err.code }); }
});

router.post('/withdrawal/create', authenticate, requireApprovedKyc, requireChannelMembership({ action: 'withdraw' }), withdrawalLimiter, createSubnetLimiter('withdrawal'), globalSurgeBreaker('withdrawal'), async (req, res) => {
  try {
    const result = await requestWithdrawal({ userId: req.user._id, tokenAmount: Number(req.body.tokenAmount) });
    res.json({ success: true, message: 'Withdrawal request created. Waiting for merchant assignment.', ...result });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message, code: err.code, cutoffPassed: err.cutoffPassed, balance: err.balance }); }
});

router.post('/order/:orderId/mark-paid', authenticate, async (req, res) => {
  try {
    const { utrNumber, proofFileKey, proofCdnUrl } = req.body;
    if (!utrNumber?.trim()) return res.status(400).json({ success: false, message: 'utrNumber is required' });
    if (!proofFileKey?.trim()) return res.status(400).json({ success: false, message: 'proofFileKey is required. Upload a payment screenshot file first.' });
    const order = await markOrderPaid(req.user._id, req.params.orderId, utrNumber, proofFileKey, proofCdnUrl);
    res.json({ success: true, message: 'Payment marked. Awaiting merchant review.', order });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message, code: err.code, originalOrderId: err.originalOrderId }); }
});

router.post('/deposit/:orderId/confirm', paymentActorAuth, async (req, res) => {
  const isMerchantActor = Boolean(req.merchantId);
  const isAdminActor = Boolean(req.user?.isAdmin);
  if (!isMerchantActor && !isAdminActor) return res.status(403).json({ success: false, message: 'Only merchants or admins can confirm deposits' });
  const session = await safeSession();
  try {
    const PaymentOrder = mongoose.model('PaymentOrder');
    const order = await PaymentOrder.findOne({ orderId: req.params.orderId }, null, withSession(session));
    if (!order || order.type !== 'DEPOSIT') { await abortOrEnd(session); return res.status(404).json({ success: false, message: 'Order not found' }); }
    if (isMerchantActor && order.merchantId?.toString() !== req.merchantId.toString()) { await abortOrEnd(session); return res.status(403).json({ success: false, message: 'This order is not assigned to you' }); }

    // THE TRANSITION IS THE GATE, and it runs before the money — inside the
    // session, so an abort below unwinds it with everything else.
    //
    // This used to debit the merchant, credit the user and only then set the
    // status, guarded by the `order.status` read above. Two confirms in flight
    // (a merchant clicking while an admin force-approves is the real case) both
    // passed that read; only the canonical txIds on the two wallet calls stopped
    // the money moving twice. Now exactly one caller matches a row.
    const confirmed = await completeOrder(order._id, {
      expectFrom: ['PAID', 'PROCESSING'],
      set: {
        completedAt: new Date(), approvedBy: req.merchantId || req.user._id,
        approvedAt: new Date(), updatedAt: new Date(),
      },
      session,
    });
    if (!confirmed.ok) {
      await abortOrEnd(session);
      return res.status(409).json({ success: false, message: `Cannot confirm in ${confirmed.status ?? 'unknown'} status` });
    }
    if (confirmed.idempotent) {
      // Already completed by a previous delivery. The money moved with it.
      await abortOrEnd(session);
      return res.json({ success: true, message: 'Deposit already completed', order: isMerchantActor ? sanitizeOrderForMerchant(order) : order });
    }
    // The user's pockets are split; the merchant's side is not. This route used
    // to debit `depositAllocation || tokenAmount` and then credit
    // `depositAllocation + reserveAllocation` — so every deposit with a reserve
    // share credited more than it debited, and the same canonical txId was used
    // for two different amounts across routes. domains/payment/depositCredit.js
    // has the rule and why it is one rule.
    const { depositCredit, reserveCredit, total } = depositCreditSplit(order);
    // GOVERNANCE §1: via merchantWallet.service.js (sole tokenBalance writer);
    // canonical txId shared with every other deposit-deduction path.
    const { merchant: updatedMerchant } = await debitMerchantTokens({
      merchantId: order.merchantId, amount: total,
      reason: `Deposit ${order.orderId} confirmed — tokens dispensed to user`,
      refModel: 'PaymentOrder', refId: order._id.toString(),
      txId: `mw_dep_deduct_${order._id}`, session,
    });
    if (!updatedMerchant) { await abortOrEnd(session); return res.status(400).json({ success: false, message: 'Merchant insufficient token balance' }); }
    if (depositCredit > 0) await creditDeposit(order.userId, depositCredit, order._id.toString(), session);
    // GOVERNANCE §7: reserveBalance is written ONLY via walletAuthority now
    // (was a raw $inc with no ledger trail). Idempotent + ledgered.
    if (reserveCredit > 0) await creditReserve(order.userId, reserveCredit, order._id.toString(), session);
    await releaseUTR(order._id);
    await mongoose.model('Transaction').create([{ userId: order.userId, type: 'DEPOSIT', amount: order.tokenAmount, balanceType: 'DEPOSIT', status: 'SUCCESS', referenceId: order._id.toString(), description: `Deposit completed: ${order.tokenAmount} tokens`, timestamp: new Date() }], withSession(session));
    await commitOrEnd(session);
    await emitWalletUpdate(order.userId);
    // The POST-transition document, not the stale one read at the top.
    const settled = confirmed.order ?? order;
    res.json({ success: true, message: 'Deposit completed', order: isMerchantActor ? sanitizeOrderForMerchant(settled) : settled });
  } catch (err) { await abortOrEnd(session); res.status(500).json({ success: false, message: 'Failed to confirm deposit' }); }
});

router.get('/orders', authenticate, async (req, res) => {
  try {
    const { status, type, limit = 20, skip = 0 } = req.query;
    const parsedLimit = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const parsedSkip  = Math.max(parseInt(skip) || 0, 0);
    const PaymentOrder = mongoose.model('PaymentOrder');
    const query = { userId: req.user._id };
    if (status) query.status = status;
    if (type)   query.type   = type;
    const [orders, total] = await Promise.all([
      PaymentOrder.find(query).sort({ createdAt: -1 }).limit(parsedLimit).skip(parsedSkip),
      PaymentOrder.countDocuments(query),
    ]);
    res.json({ success: true, orders, pagination: { total, limit: parsedLimit, skip: parsedSkip } });
  } catch { res.status(500).json({ success: false, message: 'Failed to fetch orders' }); }
});

router.get('/order/:orderId', authenticate, async (req, res) => {
  try {
    const PaymentOrder = mongoose.model('PaymentOrder');
    const order = await PaymentOrder.findOne({ $or: [{ orderId: req.params.orderId }, { _id: req.params.orderId.match(/^[0-9a-fA-F]{24}$/) ? req.params.orderId : null }] }).lean();
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.userId.toString() !== req.user._id.toString() && !req.user.isAdmin) return res.status(403).json({ success: false, message: 'Access denied' });
    res.json({ success: true, order });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Fixed 1:1 internal conversion (Phase 006 flattening, 2026-07-08) — no
// buy/sell spread. Response shape kept for client compatibility.
router.get('/rates', async (req, res) => {
  res.json({ success: true, rates: { buyRate: 1, sellRate: 1, merchantProfitPerToken: 0 } });
});

router.post('/order/cancel', authenticate, async (req, res) => {
  try {
    await cancelOrder(req.user._id, req.user.isAdmin, req.body.orderId);
    res.json({ success: true, message: 'Order cancelled' });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message }); }
});

// ─── GET /api/payment/order/:orderId/status — lightweight poll (Section 2B) ──
// Returns only the fields the frontend needs to poll during active payment flow.
router.get('/order/:orderId/status', authenticate, async (req, res) => {
  try {
    const PaymentOrder = mongoose.model('PaymentOrder');
    const order = await PaymentOrder.findOne({
      $or: [{ orderId: req.params.orderId }, { _id: req.params.orderId.match(/^[0-9a-fA-F]{24}$/) ? req.params.orderId : null }],
    }).lean();
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.userId.toString() !== req.user._id.toString() && !req.user.isAdmin)
      return res.status(403).json({ success: false, message: 'Access denied' });
    const proofExpiresAt = order.proofExpiresAt || new Date(new Date(order.createdAt).getTime() + 48 * 60 * 60 * 1000);
    const proofVisible = new Date(proofExpiresAt).getTime() > Date.now();
    res.json({
      success: true,
      status:           order.status,
      expiresAt:        order.expiresAt,
      merchantSnapshot: order.merchantSnapshot,
      utrNumber:        order.utrNumber,
      proofScreenshot:  proofVisible ? order.proofScreenshot : null,
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── POST /api/payment/order/:orderId/dispute — user raises dispute (Section 2B) ─
// User can dispute DEPOSIT order that is PAID but merchant isn't confirming.
router.post('/order/:orderId/dispute', authenticate, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ success: false, message: 'reason is required' });

    const PaymentOrder = mongoose.model('PaymentOrder');
    const order = await PaymentOrder.findOne({
      $or: [{ orderId: req.params.orderId }, { _id: req.params.orderId.match(/^[0-9a-fA-F]{24}$/) ? req.params.orderId : null }],
    });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.userId.toString() !== req.user._id.toString())
      return res.status(403).json({ success: false, message: 'Access denied' });
    if (order.status !== 'PAID')
      return res.status(400).json({ success: false, message: 'Can only dispute PAID orders' });

    // Require at least 10 minutes since paidAt before dispute is allowed.
    // This check stays a pre-read: it is a policy about elapsed time, not about
    // the state, and the transition below is what settles the race.
    const paidAt   = order.paidAt ? new Date(order.paidAt).getTime() : 0;
    const tenMin   = 10 * 60 * 1000;
    if (Date.now() - paidAt < tenMin)
      return res.status(400).json({ success: false, message: 'Please wait at least 10 minutes before raising a dispute' });

    const disputed = await disputeOrder(order._id, {
      expectFrom: 'PAID',
      set: {
        disputeReason:   reason.trim(),
        disputeRaisedAt: new Date(),
        disputeRaisedBy: 'user',
        updatedAt:       new Date(),
      },
    });
    if (!disputed.ok) {
      // 409, not 400: understood and refused because the order moved on — a
      // merchant confirming while the user was typing is the ordinary case.
      return res.status(409).json({ success: false, message: `Cannot dispute an order that is ${disputed.status ?? 'missing'}` });
    }

    // Notify admin SSE (GOVERNANCE §11: order_disputed)
    emitAdminUpdate('order_disputed', {
      orderId:   order._id,
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
    const PaymentOrder = mongoose.model('PaymentOrder');
    const order = await PaymentOrder.findOne({
      $or: [{ orderId: req.params.orderId }, { _id: req.params.orderId.match(/^[0-9a-fA-F]{24}$/) ? req.params.orderId : null }],
      userId: req.user._id,
    });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    const moved = await disputeOrder(order._id, {
      expectFrom: 'PAID',
      set: {
        disputeReason:   String(reason).trim().slice(0, 1000),
        disputeRaisedAt: new Date(),
        disputeRaisedBy: 'user',
        updatedAt:       new Date(),
      },
    });
    if (!moved.ok) {
      return res.status(409).json({ success: false, message: `Cannot transition ${moved.status ?? 'unknown'} → ${status}` });
    }
    emitAdminUpdate('queue_order_update', { orderId: order._id, status: moved.status });
    res.json({ success: true, order: moved.order ?? order });
  } catch (err) { res.status(500).json({ success: false, message: 'Failed to update status' }); }
});

export default router;
