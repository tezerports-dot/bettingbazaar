// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** payment.routes.js — player-facing Payment domain routes (BBEPS Phase 003 §3.3).
 * Moved from backend/routes/payment.routes.js on 2026-07-01 (BBEPS Phase 004 migration). */
import express   from 'express';
import mongoose  from 'mongoose';
import { authenticate } from '../identity/auth.middleware.js';
import { withdrawalLimiter } from '../../middleware/security.js';
import { createDepositOrder, createWithdrawalOrder, markOrderPaid, cancelOrder } from './paymentProcessing.service.js';
import { creditDeposit } from '../wallet/walletAuthority.service.js';
import { releaseUTR } from '../../middleware/utrValidation.js';
import { emitWalletUpdate, emitAdminUpdate, emitOrderUpdate } from '../notification/realtimeEmitters.js';

const router = express.Router();

async function safeSession() {
  try { const s = await mongoose.startSession(); s.startTransaction(); return s; } catch { return null; }
}
async function commitOrEnd(s) { if (!s) return; try { await s.commitTransaction(); } finally { s.endSession(); } }
async function abortOrEnd(s)  { if (!s) return; try { await s.abortTransaction(); }  finally { s.endSession(); } }
function withSession(s) { return s ? { session: s } : {}; }

router.post('/deposit/create', authenticate, async (req, res) => {
  try {
    const result = await createDepositOrder(req.user._id, Number(req.body.tokenAmount));
    res.json({ success: true, message: 'Deposit request created. Waiting for merchant assignment.', ...result });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message, code: err.code }); }
});

router.post('/withdrawal/create', authenticate, withdrawalLimiter, async (req, res) => {
  try {
    const result = await createWithdrawalOrder(req.user._id, Number(req.body.tokenAmount));
    res.json({ success: true, message: 'Withdrawal request created. Waiting for merchant assignment.', ...result });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message, code: err.code, cutoffPassed: err.cutoffPassed, balance: err.balance }); }
});

router.post('/order/:orderId/mark-paid', authenticate, async (req, res) => {
  try {
    const { utrNumber, proofScreenshot } = req.body;
    if (!utrNumber?.trim()) return res.status(400).json({ success: false, message: 'utrNumber is required' });
    if (!proofScreenshot?.trim()) return res.status(400).json({ success: false, message: 'proofScreenshot (CDN URL) is required' });
    const order = await markOrderPaid(req.user._id, req.params.orderId, utrNumber, proofScreenshot);
    res.json({ success: true, message: 'Payment marked. Awaiting merchant review.', order });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message, code: err.code, originalOrderId: err.originalOrderId }); }
});

router.post('/deposit/:orderId/confirm', authenticate, async (req, res) => {
  if (!req.user.isMerchant && !req.user.isAdmin) return res.status(403).json({ success: false, message: 'Only merchants can confirm deposits' });
  const session = await safeSession();
  try {
    const PaymentOrder = mongoose.model('PaymentOrder');
    const order = await PaymentOrder.findOne({ orderId: req.params.orderId }, null, withSession(session));
    if (!order || order.type !== 'DEPOSIT') { await abortOrEnd(session); return res.status(404).json({ success: false, message: 'Order not found' }); }
    if (!['PAID','PROCESSING'].includes(order.status)) { await abortOrEnd(session); return res.status(400).json({ success: false, message: `Cannot confirm in ${order.status} status` }); }
    const depositTokens = order.depositAllocation || order.tokenAmount;
    const updatedMerchant = await mongoose.model('Merchant').findOneAndUpdate({ _id: order.merchantId, tokenBalance: { $gte: depositTokens } }, { $inc: { tokenBalance: -depositTokens } }, { ...withSession(session), new: true });
    if (!updatedMerchant) { await abortOrEnd(session); return res.status(400).json({ success: false, message: 'Merchant insufficient token balance' }); }
    await creditDeposit(order.userId, depositTokens, order._id.toString(), session);
    if ((order.reserveAllocation || 0) > 0) await mongoose.model('User').findByIdAndUpdate(order.userId, { $inc: { reserveBalance: order.reserveAllocation } }, withSession(session));
    order.status = 'COMPLETED'; order.completedAt = new Date(); order.approvedBy = req.merchantId || req.user._id; order.approvedAt = new Date(); order.updatedAt = new Date();
    await order.save(withSession(session));
    await releaseUTR(order._id);
    await mongoose.model('Transaction').create([{ userId: order.userId, type: 'DEPOSIT', amount: order.tokenAmount, balanceType: 'DEPOSIT', status: 'SUCCESS', referenceId: order._id.toString(), description: `Deposit completed: ${order.tokenAmount} tokens`, timestamp: new Date() }], withSession(session));
    await commitOrEnd(session);
    await emitWalletUpdate(order.userId);
    res.json({ success: true, message: 'Deposit completed', order });
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

router.get('/rates', async (req, res) => {
  try {
    const rates = await mongoose.model('TokenRates').findOne({ key: 'main' });
    if (!rates) return res.json({ success: true, rates: null });
    res.json({ success: true, rates: { buyRate: rates.buyRate, sellRate: rates.sellRate, merchantProfitPerToken: rates.buyRate - rates.sellRate } });
  } catch { res.status(500).json({ success: false, message: 'Failed to fetch rates' }); }
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
    res.json({
      success: true,
      status:           order.status,
      expiresAt:        order.expiresAt,
      merchantSnapshot: order.merchantSnapshot,
      utrNumber:        order.utrNumber,
      proofScreenshot:  order.proofScreenshot,
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

    // Require at least 10 minutes since paidAt before dispute is allowed
    const paidAt   = order.paidAt ? new Date(order.paidAt).getTime() : 0;
    const tenMin   = 10 * 60 * 1000;
    if (Date.now() - paidAt < tenMin)
      return res.status(400).json({ success: false, message: 'Please wait at least 10 minutes before raising a dispute' });

    order.status          = 'DISPUTED';
    order.disputeReason   = reason.trim();
    order.disputeRaisedAt = new Date();
    order.disputeRaisedBy = 'user';
    order.updatedAt       = new Date();
    await order.save();

    // Notify admin SSE (GOVERNANCE §11: order_disputed)
    emitAdminUpdate('order_disputed', {
      orderId:   order._id,
      raisedBy:  'user',
      reason:    reason.trim(),
      server_ts: Date.now(),
    });

    res.json({ success: true, message: 'Dispute raised. Admin will review shortly.', order });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/order/:orderId/status', authenticate, async (req, res) => {
  try {
    const { status } = req.body;
    const PaymentOrder = mongoose.model('PaymentOrder');
    const order = await PaymentOrder.findOne({ $or: [{ orderId: req.params.orderId }, { _id: req.params.orderId }] });
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    const VALID = { PAID: ['DISPUTED'] };
    if (!(VALID[order.status] || []).includes(status)) return res.status(400).json({ success: false, message: `Cannot transition ${order.status} → ${status}` });
    order.status = status; order.updatedAt = new Date();
    await order.save();
    emitAdminUpdate('queue_order_update', { orderId: order._id, status: order.status });
    res.json({ success: true, order });
  } catch (err) { res.status(500).json({ success: false, message: 'Failed to update status' }); }
});

export default router;
