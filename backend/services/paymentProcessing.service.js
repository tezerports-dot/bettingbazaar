// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)

import mongoose from 'mongoose';
import crypto   from 'crypto';
import { debitWinningsForWithdrawal, creditDeposit, creditWinnings, refundOrder, lockWithdrawal, releaseWithdrawal } from './walletAuthority.service.js';
import { selectBestMerchant } from './merchantScoring.service.js';
import { markUTRAsUsed, releaseUTR }   from '../middleware/utrValidation.js';
import { emitWalletUpdate, emitOrderUpdate, emitMerchantUpdate, emitAdminUpdate } from './realtimeEmitters.js';

// ─── Session helpers (graceful degradation on standalone MongoDB) ─────────────
async function safeSession() {
  try {
    const s = await mongoose.startSession();
    s.startTransaction();
    return s;
  } catch {
    console.warn('[paymentProcessing] standalone MongoDB — no transaction session');
    return null;
  }
}
async function commitOrEnd(s) { if (!s) return; try { await s.commitTransaction(); } finally { s.endSession(); } }
async function abortOrEnd(s)  { if (!s) return; try { await s.abortTransaction(); }  finally { s.endSession(); } }
function withSession(s)        { return s ? { session: s } : {}; }

// ─── Shared admin SSE payload ─────────────────────────────────────────────────
function adminOrderPayload(order, user) {
  return {
    _id:            order._id,
    orderId:        order.orderId,
    type:           order.type,
    status:         order.status,
    fiatAmount:     order.fiatAmount,
    tokenAmount:    order.tokenAmount,
    userName:       user?.username,
    userMobile:     user?.mobile,
    userId:         user?._id || order.userId,
    merchantProfit: order.merchantProfit || 0,
    rateUsed:       order.rateUsed,
    createdAt:      order.createdAt,
    server_ts:      Date.now(),
  };
}

// ─── Build merchantSnapshot from a Merchant doc ───────────────────────────────
function buildMerchantSnapshot(merchantDoc, expiresAt) {
  return {
    merchantId:    merchantDoc._id,
    merchantName:  merchantDoc.name || merchantDoc.username || '',
    upiId:         merchantDoc.bankDetails?.upiId             || '',
    qrCodeUrl:     merchantDoc.qrCodeUrl                      || '',
    bankName:      merchantDoc.bankDetails?.bankName           || '',
    accountNo:     merchantDoc.bankDetails?.accountNo          || '',
    ifsc:          merchantDoc.bankDetails?.ifsc               || '',
    accountHolder: merchantDoc.bankDetails?.accountHolderName  || '',
    snapshotAt:    new Date(),
    expiresAt,
  };
}

// ─── Attempt to assign order to best merchant; returns true if assigned ────────
async function tryAssignMerchant(order) {
  const Merchant = mongoose.model('Merchant');
  const merchant = await selectBestMerchant(order.type, order.tokenAmount);
  if (!merchant) return false;

  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15-min window
  order.merchantId       = merchant._id;
  order.status           = 'ASSIGNED';
  order.assignedAt       = new Date();
  order.expiresAt        = expiresAt;
  order.merchantSnapshot = buildMerchantSnapshot(merchant, expiresAt);

  await order.save();

  // Increment merchant activeOrderCount
  await Merchant.findByIdAndUpdate(merchant._id, { $inc: { activeOrderCount: 1 } });

  // Notify merchant via SSE (GOVERNANCE §11: new_order)
  emitMerchantUpdate(merchant._id.toString(), 'new_order', {
    ...order.toObject(),
    server_ts: Date.now(),
  });

  // Notify user: order_assigned (GOVERNANCE §11)
  emitOrderUpdate(order.userId.toString(), 'order_assigned', {
    orderId:          order.orderId,
    _id:              order._id,
    merchantSnapshot: order.merchantSnapshot,
    expiresAt:        order.expiresAt,
    status:           'ASSIGNED',
    server_ts:        Date.now(),
  });

  return true;
}

// ─── Start 5-minute retry loop when no merchant available ────────────────────
// Retries every 30 seconds for up to 5 minutes, then sets EXPIRED.
// Uses setTimeout chain — NOT a cron job (per spec Section 1).
function startPendingRetryLoop(orderId) {
  const MAX_RETRIES = 10; // 10 × 30s = 5 min
  let attempts = 0;

  async function attempt() {
    attempts++;
    try {
      const PaymentOrder = mongoose.model('PaymentOrder');
      const order = await PaymentOrder.findById(orderId);
      if (!order || order.status !== 'PENDING_QUEUE') return; // already assigned/cancelled

      const assigned = await tryAssignMerchant(order);
      if (assigned) {
        emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'ASSIGNED', server_ts: Date.now() });
        return;
      }

      if (attempts >= MAX_RETRIES) {
        // Expire the order
        order.status       = 'CANCELLED';
        order.cancelReason = 'EXPIRED';
        order.cancelledAt  = new Date();
        order.updatedAt    = new Date();
        await order.save();

        // Release escrow if WITHDRAWAL
        if (order.type === 'WITHDRAWAL' && order.escrowLocked) {
          await creditWinnings(
            order.userId, order.tokenAmount,
            `Expired withdrawal escrow release: ${order.orderId}`,
            'PaymentOrder', order._id, `expiry_refund_${order._id}`
          ).catch(e => console.error('[startPendingRetryLoop] escrow release failed:', e.message));
        }

        emitOrderUpdate(order.userId.toString(), 'order_expired', {
          orderId:   order.orderId,
          _id:       order._id,
          status:    'CANCELLED',
          reason:    'EXPIRED',
          server_ts: Date.now(),
        });
        emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'CANCELLED', reason: 'EXPIRED' });
        return;
      }

      // Schedule next attempt
      setTimeout(attempt, 30 * 1000);
    } catch (err) {
      console.error('[startPendingRetryLoop] attempt error:', err.message);
      if (attempts < MAX_RETRIES) setTimeout(attempt, 30 * 1000);
    }
  }

  setTimeout(attempt, 30 * 1000); // first retry after 30s
}

// ═════════════════════════════════════════════════════════════════════════════
// createDepositOrder
// ═════════════════════════════════════════════════════════════════════════════
export async function createDepositOrder(userId, tokenAmount) {
  const session = await safeSession();
  try {
    const User         = mongoose.model('User');
    const PaymentOrder = mongoose.model('PaymentOrder');
    const TokenRates   = mongoose.model('TokenRates');
    const SystemConfig = mongoose.model('SystemConfig');

    const cfg        = await SystemConfig.findOne({ key: 'main' }).lean();
    const minDeposit = cfg?.minDeposit || 100; // schema default: 100
    const maxDeposit = cfg?.maxDeposit || 50000; // schema default: 50000

    if (!tokenAmount || tokenAmount < minDeposit)
      throw Object.assign(new Error(`Minimum purchase is ${minDeposit} BB tokens`), { status: 400 });
    if (tokenAmount > maxDeposit)
      throw Object.assign(new Error(`Maximum purchase is ${maxDeposit} BB tokens`), { status: 400 });

    const user = await User.findById(userId, null, withSession(session));
    if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
    if (user.isBlocked)
      throw Object.assign(new Error('Your account has been suspended due to payment violations. Contact support.'), { status: 403, code: 'USER_BLOCKED' });
    if (user.kycStatus !== 'APPROVED')
      throw Object.assign(new Error('Please complete KYC verification to purchase tokens'), { status: 403 });

    const rates = await TokenRates.findOne({ key: 'main' }, null, withSession(session));
    if (!rates?.buyRate || !rates?.sellRate)
      throw Object.assign(new Error('Token rates not configured. Please contact admin.'), { status: 503 });

    const buyRate            = rates.buyRate;
    const fiatAmount         = tokenAmount * buyRate;
    const merchantProfit     = tokenAmount * (buyRate - rates.sellRate);
    const depositAllocation  = Math.floor(tokenAmount * 0.90);
    const reserveAllocation  = tokenAmount - depositAllocation;

    const order = new PaymentOrder({
      orderId:           `DEP_${crypto.randomBytes(12).toString('hex')}`,
      type:              'DEPOSIT',
      userId:            user._id,
      tokenAmount,
      fiatAmount,
      rateUsed:          buyRate,
      merchantProfit,
      depositAllocation,
      reserveAllocation,
      status:            'PENDING_QUEUE',
      createdAt:         new Date(),
    });

    await order.save(withSession(session));
    await commitOrEnd(session);

    emitAdminUpdate('new_order', adminOrderPayload(order, user));

    // Auto-assign merchant immediately
    const assigned = await tryAssignMerchant(order);
    if (!assigned) {
      startPendingRetryLoop(order._id.toString());
    } else {
      emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'ASSIGNED', server_ts: Date.now() });
    }

    return {
      order: {
        _id:               order._id,
        orderId:           order.orderId,
        tokenAmount:       order.tokenAmount,
        fiatAmount:        order.fiatAmount,
        depositAllocation: order.depositAllocation,
        reserveAllocation: order.reserveAllocation,
        rateUsed:          order.rateUsed,
        status:            order.status,
        merchantSnapshot:  order.merchantSnapshot,
        expiresAt:         order.expiresAt,
      },
      note: `You will pay ₹${fiatAmount.toLocaleString()} to receive ${tokenAmount} BB tokens (${depositAllocation} betting + ${reserveAllocation} reserve)`,
    };
  } catch (err) {
    await abortOrEnd(session);
    throw err;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// createWithdrawalOrder
// ═════════════════════════════════════════════════════════════════════════════
export async function createWithdrawalOrder(userId, tokenAmount) {
  const session = await safeSession();
  try {
    const User         = mongoose.model('User');
    const PaymentOrder = mongoose.model('PaymentOrder');
    const TokenRates   = mongoose.model('TokenRates');
    const SystemConfig = mongoose.model('SystemConfig');

    const cfg         = await SystemConfig.findOne({ key: 'main' }).lean();
    const minWithdraw = cfg?.minWithdrawal || 500; // schema default: 500
    const maxWithdraw = cfg?.maxWithdrawal || 50000; // schema default: 50000

    if (!tokenAmount || tokenAmount < minWithdraw)
      throw Object.assign(new Error(`Minimum withdrawal is ${minWithdraw} BB tokens`), { status: 400 });
    if (tokenAmount > maxWithdraw)
      throw Object.assign(new Error(`Maximum withdrawal is ${maxWithdraw} BB tokens`), { status: 400 });

    const user = await User.findById(userId, null, withSession(session));
    if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
    if (user.isBlocked)
      throw Object.assign(new Error('Your account has been suspended due to payment violations. Contact support.'), { status: 403, code: 'USER_BLOCKED' });
    if (user.kycStatus !== 'APPROVED')
      throw Object.assign(new Error('Please complete KYC verification before withdrawing'), { status: 403 });
    if (!user.bankDetails?.accountNumber || !user.bankDetails?.ifscCode)
      throw Object.assign(new Error('Please add your bank account details before withdrawing'), { status: 400 });

    // Pending withdrawal total guard (prevents overdraft across concurrent requests)
    const [pagg] = await mongoose.model('PaymentOrder').aggregate([
      { $match: { userId: user._id, type: 'WITHDRAWAL', status: { $in: ['PENDING_QUEUE', 'ASSIGNED', 'PROCESSING', 'PAID'] } } },
      { $group: { _id: null, total: { $sum: '$tokenAmount' } } },
    ]);
    const pendingTotal = pagg?.total || 0;
    if (pendingTotal + tokenAmount > (user.winningsBalance || 0))
      throw Object.assign(
        new Error(`Insufficient winnings balance. Available: ${user.winningsBalance || 0} tokens (${pendingTotal} locked in pending orders).`),
        { status: 400 }
      );

    if (user.winningsBalance < tokenAmount)
      throw Object.assign(
        new Error(`Insufficient winnings balance. Available: ${user.winningsBalance} tokens`),
        { status: 400, balance: { deposit: user.depositBalance, winnings: user.winningsBalance } }
      );

    const rates = await TokenRates.findOne({ key: 'main' }, null, withSession(session));
    if (!rates?.sellRate)
      throw Object.assign(new Error('Token rates not configured. Please contact admin.'), { status: 503 });

    const sellRate   = rates.sellRate;
    const fiatAmount = tokenAmount * sellRate;

    const order = new PaymentOrder({
      orderId:         `WD_${crypto.randomBytes(12).toString('hex')}`,
      type:            'WITHDRAWAL',
      userId:          user._id,
      tokenAmount,
      fiatAmount,
      rateUsed:        sellRate,
      status:          'PENDING_QUEUE',
      createdAt:       new Date(),
      escrowLocked:    true,
      escrowAmount:    tokenAmount,
      userKycSnapshot: {
        pan:  user.kycData?.panNumber  || user.kycData?.aadhaarNumber || '',
        name: user.kycData?.nameOnPAN  || user.kycData?.nameOnAadhaar || user.username || '',
      },
      userBankDetails: {
        accountNumber:     user.bankDetails?.accountNumber || '',
        ifscCode:          user.bankDetails?.ifscCode      || '',
        bankName:          user.bankDetails?.bankName      || '',
        accountHolderName: user.bankDetails?.accountHolderName || user.username || '',
      },
      userPhone:  user.mobile,
      // Store user UPI ID from profile for merchant to see (used in sell order UI)
      upiId:      user.bankDetails?.upiId || '',
    });

    // Escrow: lock tokens from winningsBalance into lockedBalance via wallet authority
    // GOVERNANCE §7: all balance mutations go through walletAuthority.service.js
    const debitResult = await debitWinningsForWithdrawal(String(user._id), tokenAmount, order._id.toString(), session);

    await order.save(withSession(session));
    await commitOrEnd(session);

    emitAdminUpdate('new_order', adminOrderPayload(order, user));
    await emitWalletUpdate(user._id);

    // Auto-assign merchant immediately
    const assigned = await tryAssignMerchant(order);
    if (!assigned) {
      startPendingRetryLoop(order._id.toString());
    } else {
      emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'ASSIGNED', server_ts: Date.now() });
    }

    return {
      order: {
        _id:              order._id,
        orderId:          order.orderId,
        tokenAmount:      order.tokenAmount,
        fiatAmount:       order.fiatAmount,
        rateUsed:         order.rateUsed,
        status:           order.status,
        merchantSnapshot: order.merchantSnapshot,
        expiresAt:        order.expiresAt,
        userBankDetails:  order.userBankDetails,
      },
      remainingBalance: {
        deposit:  user.depositBalance,
        winnings: debitResult.winningsAfter ?? (user.winningsBalance - tokenAmount),
        total:    user.depositBalance + (debitResult.winningsAfter ?? (user.winningsBalance - tokenAmount)),
      },
      note: `You will receive ₹${fiatAmount.toLocaleString()} from merchant`,
    };
  } catch (err) {
    await abortOrEnd(session);
    throw err;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// markOrderPaid  — user submits UTR + screenshot (DEPOSIT only)
// ═════════════════════════════════════════════════════════════════════════════
export async function markOrderPaid(userId, orderId, utrNumber, proofScreenshot) {
  const PaymentOrder = mongoose.model('PaymentOrder');
  const order = await PaymentOrder.findOne({ $or: [{ orderId }, { _id: orderId }] });
  if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

  if (order.userId.toString() !== userId.toString())
    throw Object.assign(new Error('Access denied'), { status: 403 });
  if (!['ASSIGNED', 'PROCESSING'].includes(order.status))
    throw Object.assign(new Error(`Cannot mark paid — order is in ${order.status} status`), { status: 400 });
  if (order.type !== 'DEPOSIT')
    throw Object.assign(new Error('Only DEPOSIT orders can be marked paid by user'), { status: 400 });

  const normalizedUTR = utrNumber.toUpperCase().replace(/\s+/g, '');
  if (normalizedUTR.length < 12)
    throw Object.assign(new Error('UTR must be at least 12 characters'), { status: 400 });

  try {
    await markUTRAsUsed(normalizedUTR, order._id, order.userId, order.fiatAmount);
  } catch (err) {
    if (err.code === 11000) {
      const { UTRRegistry } = await import('../models/utrRegistry.model.js');
      const existing = await UTRRegistry.findOne({ utr: normalizedUTR }).lean();
      throw Object.assign(
        new Error('This UTR was already used. Contact support.'),
        { status: 409, code: 'DUPLICATE_UTR', originalOrderId: existing?.orderId }
      );
    }
    throw err;
  }

  order.status          = 'PAID';
  order.utrNumber       = normalizedUTR;
  order.proofScreenshot = proofScreenshot.trim();
  order.paidAt          = new Date();
  order.updatedAt       = new Date();
  await order.save();

  if (order.merchantId) {
    emitMerchantUpdate(order.merchantId.toString(), 'order_paid', {
      orderId:         order.orderId,
      _id:             order._id,
      status:          'PAID',
      utrNumber:       normalizedUTR,
      proofScreenshot: order.proofScreenshot,
      fiatAmount:      order.fiatAmount,
      tokenAmount:     order.tokenAmount,
      paidAt:          order.paidAt,
      server_ts:       Date.now(),
    });
  }
  emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'PAID', server_ts: Date.now() });

  return order;
}

// ═════════════════════════════════════════════════════════════════════════════
// approveDeposit  — merchant confirms payment received (DEPOSIT)
//   90% → user.depositBalance, 10% → platform reserve (reserveBalance field)
// ═════════════════════════════════════════════════════════════════════════════
export async function approveDeposit(actorId, orderId, session) {
  const PaymentOrder = mongoose.model('PaymentOrder');
  const Transaction  = mongoose.model('Transaction');
  const Merchant     = mongoose.model('Merchant');

  const order = await PaymentOrder.findOne({ orderId }, null, withSession(session));
  if (!order || order.type !== 'DEPOSIT')
    throw Object.assign(new Error('Order not found'), { status: 404 });
  if (order.status !== 'PAID')
    throw Object.assign(new Error(`Cannot approve order in ${order.status} status`), { status: 400 });

  // Deduct from merchant token balance
  const updatedMerchant = await Merchant.findOneAndUpdate(
    { _id: order.merchantId, tokenBalance: { $gte: order.depositAllocation || order.tokenAmount } },
    { $inc: { tokenBalance: -(order.depositAllocation || order.tokenAmount) } },
    { ...withSession(session), new: true }
  );
  if (!updatedMerchant)
    throw Object.assign(new Error('Merchant has insufficient token balance'), { status: 400 });

  // 90% to user depositBalance
  await creditDeposit(order.userId, order.depositAllocation || order.tokenAmount, order._id.toString(), session);

  // 10% to platform reserve (reserveBalance on User)
  if (order.reserveAllocation > 0) {
    const User = mongoose.model('User');
    await User.findByIdAndUpdate(
      order.userId,
      { $inc: { reserveBalance: order.reserveAllocation } },
      withSession(session)
    );
  }

  order.status      = 'COMPLETED';
  order.completedAt = new Date();
  order.approvedBy  = actorId;
  order.approvedAt  = new Date();
  order.updatedAt   = new Date();
  await order.save(withSession(session));

  await releaseUTR(order._id);

  // Update merchant scoring stats
  await updateMerchantStatsOnComplete(order.merchantId, true);

  await Transaction.create([{
    userId:      order.userId,
    type:        'DEPOSIT',
    amount:      order.tokenAmount,
    balanceType: 'DEPOSIT',
    status:      'SUCCESS',
    referenceId: order._id.toString(),
    description: `Deposit completed: ${order.tokenAmount} tokens (${order.depositAllocation} betting + ${order.reserveAllocation} reserve)`,
    timestamp:   new Date(),
  }], withSession(session));

  await emitWalletUpdate(order.userId);
  emitOrderUpdate(order.userId.toString(), 'order_completed', {
    orderId:    order.orderId,
    _id:        order._id,
    status:     'COMPLETED',
    server_ts:  Date.now(),
  });
  emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'COMPLETED' });

  // Notify merchant of updated score (GOVERNANCE §11: merchant_score_update)
  const freshMerchant = await Merchant.findById(order.merchantId).lean();
  if (freshMerchant) {
    emitMerchantUpdate(order.merchantId.toString(), 'merchant_score_update', {
      successRate:  freshMerchant.successRate,
      avgResponse:  freshMerchant.avgResponseMinutes,
    });
  }

  return order;
}

// ─── Update merchant scoring stats after order completes/fails ───────────────
export async function updateMerchantStatsOnComplete(merchantId, success) {
  if (!merchantId) return;
  const Merchant = mongoose.model('Merchant');
  const inc = { totalOrdersAll: 1, activeOrderCount: -1 };
  if (success) inc.totalOrdersCompleted = 1;

  const m = await Merchant.findByIdAndUpdate(merchantId, { $inc: inc }, { new: true });
  if (!m) return;

  // Recalculate successRate from totals
  const totalAll       = m.totalOrdersAll       || 1;
  const totalCompleted = m.totalOrdersCompleted || 0;
  await Merchant.findByIdAndUpdate(merchantId, {
    $set: {
      successRate: totalCompleted / totalAll,
      disputeRate: (m.disputeRate || 0), // preserved; updated separately on dispute
    },
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// cancelOrder  — user or admin cancels a PENDING_QUEUE order
// ═════════════════════════════════════════════════════════════════════════════
export async function cancelOrder(actorId, isAdmin, orderId) {
  const PaymentOrder = mongoose.model('PaymentOrder');
  const order = await PaymentOrder.findOne({ $or: [{ orderId }, { _id: orderId }] });
  if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

  if (order.userId.toString() !== actorId.toString() && !isAdmin)
    throw Object.assign(new Error('Access denied'), { status: 403 });
  if (order.status !== 'PENDING_QUEUE')
    throw Object.assign(new Error('Order cannot be cancelled at this stage'), { status: 400 });

  if (order.type === 'WITHDRAWAL' && order.escrowLocked) {
    await creditWinnings(order.userId, order.tokenAmount,
      `Withdrawal refund ${order.orderId}`, 'PaymentOrder', order._id,
      `wd_refund_${order._id}`
    );
    order.escrowLocked = false;
  }

  order.status       = 'CANCELLED';
  order.cancelReason = 'USER_CANCELLED';
  order.cancelledAt  = new Date();
  order.updatedAt    = new Date();
  await order.save();
  await emitWalletUpdate(order.userId);
  return order;
}

// ═════════════════════════════════════════════════════════════════════════════
// expireOrders  — cron worker (called from cronJobs.js or setInterval)
// ═════════════════════════════════════════════════════════════════════════════
export async function expireOrders() {
  const PaymentOrder = mongoose.model('PaymentOrder');
  const now = new Date();
  const expired = await PaymentOrder.find({
    status:    { $in: ['ASSIGNED', 'PROCESSING'] },
    expiresAt: { $lt: now },
  });
  if (expired.length === 0) return 0;

  let count = 0;
  for (const order of expired) {
    try {
      order.status       = 'CANCELLED';
      order.cancelReason = 'EXPIRED';
      order.cancelledAt  = now;
      order.updatedAt    = now;
      await order.save();

      // Release escrow if WITHDRAWAL
      if (order.type === 'WITHDRAWAL' && order.escrowLocked) {
        await creditWinnings(
          order.userId, order.tokenAmount,
          `Expired withdrawal escrow release: ${order.orderId}`,
          'PaymentOrder', order._id, `expiry_refund_${order._id}`
        ).catch(e => console.error('[expireOrders] escrow release failed:', e.message));
      }

      // Update merchant scoring (failure)
      if (order.merchantId) {
        await updateMerchantStatsOnComplete(order.merchantId, false).catch(() => {});
      }

      emitOrderUpdate(order.userId.toString(), 'order_expired', {
        orderId:   order.orderId,
        _id:       order._id,
        status:    'CANCELLED',
        reason:    'EXPIRED',
        expiresAt: order.expiresAt,
        server_ts: Date.now(),
      });
      emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'CANCELLED', reason: 'EXPIRED' });
      count++;
    } catch (e) {
      console.error('[expireOrders] failed:', order.orderId, e.message);
    }
  }
  return count;
}

// Export tryAssignMerchant for re-assignment after rejection
export { tryAssignMerchant, buildMerchantSnapshot };
