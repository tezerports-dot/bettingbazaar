// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Payment (BBEPS Phase 003 §3.3). Moved from backend/services/paymentProcessing.service.js
// on 2026-07-01 (BBEPS Phase 004 migration).
// NOTE: this file calls into the Merchant domain's selectBestMerchant() algorithm
// directly (see import below). That's pre-existing cross-domain coupling, not
// something this migration introduced or resolved — flagged here per BBEPS Phase 003
// §3.7 "Domain Dependency Rules" as a candidate for a future migration (route the
// call through a proper Merchant-domain public interface instead of a direct import).

import mongoose from 'mongoose';
import crypto   from 'crypto';
import { debitWinningsForWithdrawal, refundWithdrawal, getBalances } from '../wallet/walletAuthority.service.js';
import { selectBestMerchant } from '../merchant/merchantScoring.service.js';
import { merchantTypeOf } from '../merchant/merchantCurrency.js';
// Risk Platform (Phase 010): the single validation authority for funding orders.
import { assessFundingOrder, getRiskRules, computePayoutFeeMinor } from '../risk/riskValidation.service.js';
import { markUTRAsUsed }   from '../../middleware/utrValidation.js';
// The order state machine. Every status change goes through here so an illegal
// move is refused by the database rather than by whichever check ran first.
import {
  assignOrder as assignOrderState, markOrderPaid as markOrderPaidState,
  cancelOrder as cancelOrderState,
} from './orderLifecycle.service.js';
import { emitWalletUpdate, emitOrderUpdate, emitMerchantUpdate, emitAdminUpdate } from '../notification/realtimeEmitters.js';
import cdnService from '../../services/cdn.service.js';

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
function merchantDisplayRef(merchantDoc) {
  return `Merchant #${merchantDoc.publicRef}`;
}

function buildMerchantSnapshot(merchantDoc, expiresAt) {
  return {
    merchantId:    merchantDoc._id,
    merchantName:  merchantDisplayRef(merchantDoc),
    // A merchant settles on exactly one rail, so exactly one credential set is
    // populated: UPI/bank for an INR merchant, the TRC-20 address for a USDT
    // merchant. The user panel renders whichever is present.
    merchantType:  merchantTypeOf(merchantDoc),
    upiId:         merchantDoc.bankDetails?.upiId             || '',
    qrCodeUrl:     merchantDoc.qrCodeUrl                      || '',
    bankName:      merchantDoc.bankDetails?.bankName           || '',
    accountNo:     merchantDoc.bankDetails?.accountNo          || '',
    ifsc:          merchantDoc.bankDetails?.ifsc               || '',
    accountHolder: merchantDoc.bankDetails?.accountHolderName  || '',
    usdtAddress:   merchantDoc.usdtWalletAddress               || '',
    snapshotAt:    new Date(),
    expiresAt,
  };
}

// ─── Payment order window (Business Config Audit, 2026-07-11) ─────────────────
// Minutes a user has to pay the assigned merchant before the order auto-expires
// and refunds. Owned by SystemConfig.orderExpiryMinutes (was hardcoded 15).
// Falls back to 15 min if unset/invalid, so behavior is unchanged until an admin
// edits it. Returns milliseconds for direct Date arithmetic.
async function getOrderExpiryMs() {
  try {
    const SystemConfig = mongoose.model('SystemConfig');
    const cfg = await SystemConfig.findOne({ key: 'main' }).select('orderExpiryMinutes').lean();
    const m = cfg?.orderExpiryMinutes;
    if (Number.isFinite(m) && m >= 1 && m <= 1440) return m * 60 * 1000;
  } catch { /* fall through to default */ }
  return 15 * 60 * 1000;
}

// ─── Attempt to assign order to best merchant; returns true if assigned ────────
async function tryAssignMerchant(order) {
  const Merchant = mongoose.model('Merchant');
  // Pass the order's rail: selectBestMerchant matches it against
  // Merchant.acceptedCurrencies, so a USDT order can only reach a USDT merchant
  // and an INR order only an INR merchant. Previously the argument was omitted
  // and every order fell back to the 'INR' default, which would have routed a
  // USDT order to an INR merchant (2026-07-27).
  const merchant = await selectBestMerchant(order.type, order.tokenAmount, order.currency);
  if (!merchant) return false;

  const expiresAt = new Date(Date.now() + await getOrderExpiryMs()); // admin-configurable window
  const snapshot  = buildMerchantSnapshot(merchant, expiresAt);

  // The transition is the gate. Two assignment passes racing the same queued
  // order — the synchronous attempt at creation and the retry loop, which do
  // overlap — both used to pass the `status === 'PENDING_QUEUE'` read above and
  // both used to save, so the second silently overwrote the first merchant's
  // assignment and left that merchant holding an activeOrderCount for an order
  // they no longer had. Exactly one caller now matches a row.
  const moved = await assignOrderState(order._id, {
    set: {
      merchantId:       merchant._id,
      assignedAt:       new Date(),
      expiresAt,
      merchantSnapshot: snapshot,
    },
  });
  if (!moved.ok || moved.idempotent) return false;

  // Keep the caller's in-memory document consistent with what was written, so
  // the emitters below describe the row that exists rather than a hoped-for one.
  order.merchantId       = merchant._id;
  order.status           = 'ASSIGNED';
  order.assignedAt       = moved.order.assignedAt;
  order.expiresAt        = expiresAt;
  order.merchantSnapshot = snapshot;

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

// ─── Short merchant-search retry loop when no merchant available ─────────────
// Owner directive (2026-07-14): retry at most TWICE (30s apart); if no merchant
// is found after those 2 attempts, FAIL the order (CANCELLED/EXPIRED) instead of
// keeping the user waiting for minutes. Uses a setTimeout chain — NOT a cron job.
// NOTE: an initial assignment was already attempted synchronously at order
// creation; this loop is the fallback, capped at 2 tries (~60s) then fail.
function startPendingRetryLoop(orderId) {
  const MAX_RETRIES = 2; // 2 × 30s ≈ 1 min, then fail (was 10 = 5 min)
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
        // Expire the order. The transition gates the refund: this loop and the
        // expireOrders cron can both reach the same order, and only the caller
        // that actually moved it may release the escrow.
        const expired = await cancelOrderState(order._id, {
          expectFrom: 'PENDING_QUEUE',
          set: { cancelReason: 'EXPIRED', cancelledAt: new Date(), updatedAt: new Date() },
        });
        if (!expired.ok || expired.idempotent) return;
        order.status = 'CANCELLED';

        // Release escrow if WITHDRAWAL
        if (order.type === 'WITHDRAWAL' && order.escrowLocked) {
          await refundWithdrawal(
            order.userId, order.tokenAmount, order._id.toString()
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
    const SystemConfig = mongoose.model('SystemConfig');

    const cfg        = await SystemConfig.findOne({ key: 'main' }).lean();
    const minDeposit = cfg?.minDeposit || 100; // schema default: 100
    const maxDeposit = cfg?.maxDeposit || 50000; // schema default: 50000

    // Risk Platform gate (Phase 010): positive/numeric/multiples-of-10,
    // min/max, velocity — the single validation authority.
    await assessFundingOrder({ userId, tokenAmount, type: 'DEPOSIT', min: minDeposit, max: maxDeposit });

    const user = await User.findById(userId, null, withSession(session));
    if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
    if (user.isBlocked)
      throw Object.assign(new Error('Your account has been suspended due to payment violations. Contact support.'), { status: 403, code: 'USER_BLOCKED' });
    if (user.kycStatus !== 'APPROVED')
      throw Object.assign(new Error('Please complete KYC verification to purchase tokens'), { status: 403 });

    // Fixed 1:1 internal conversion (Phase 006 flattening, 2026-07-08):
    // 1 BB token = ₹1, no buy/sell spread. Merchant earnings come from the
    // future cycle-completion-triggered Merchant Performance Bonus, never
    // from a rate spread — see docs/governance/04-GOVERNANCE.md.
    const fiatAmount         = tokenAmount;
    const merchantProfit     = 0; // spread retired; schema default is also 0
    // depositAllocation / reserveAllocation are NOT computed here — the
    // PaymentOrder pre-save hook (paymentOrder.model.js) is the single
    // computation site, deriving them from the active DepositPolicy. This
    // function used to independently compute them with a hardcoded 0.90,
    // which the hook then silently overwrote on save — the persisted order
    // was already correct, but the `note` text below was built from the
    // stale, pre-overwrite local variables, so it could describe a split
    // the admin had already changed away from. Fixed by reading the
    // authoritative values off `order` AFTER save.

    const order = new PaymentOrder({
      orderId:           `DEP_${crypto.randomBytes(12).toString('hex')}`,
      type:              'DEPOSIT',
      userId:            user._id,
      tokenAmount,
      fiatAmount,
      rateUsed:          1, // fixed 1:1 conversion
      merchantProfit,
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
      note: `You will pay ₹${fiatAmount.toLocaleString()} to receive ${tokenAmount} BB tokens (${order.depositAllocation} betting + ${order.reserveAllocation} reserve)`,
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
    const SystemConfig = mongoose.model('SystemConfig');

    const cfg         = await SystemConfig.findOne({ key: 'main' }).lean();
    const minWithdraw = cfg?.minWithdrawal || 500; // schema default: 500
    const maxWithdraw = cfg?.maxWithdrawal || 50000; // schema default: 50000

    // Risk Platform gate (Phase 010): positive/numeric/multiples-of-10,
    // min/max, velocity — the single validation authority.
    await assessFundingOrder({ userId, tokenAmount, type: 'WITHDRAWAL', min: minWithdraw, max: maxWithdraw });

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

    // FROM THE STORE THE DEBIT MOVES. `debitWinningsForWithdrawal` below moves
    // the `wallets` row; these guards used to read the Mongo User document, so
    // a withdrawal could be ADMITTED against winnings the wallet does not hold,
    // or refused while quoting a balance that is not the one being checked.
    // Same defect as the bet route's affordability check, on the path where the
    // money leaves the platform.
    const wallet = await getBalances(String(user._id));
    const winningsAvailable = wallet.winningsBalance || 0;

    if (pendingTotal + tokenAmount > winningsAvailable)
      throw Object.assign(
        new Error(`Insufficient winnings balance. Available: ${winningsAvailable} tokens (${pendingTotal} locked in pending orders).`),
        { status: 400 }
      );

    if (winningsAvailable < tokenAmount)
      throw Object.assign(
        new Error(`Insufficient winnings balance. Available: ${winningsAvailable} tokens`),
        { status: 400, balance: { deposit: wallet.depositBalance, winnings: winningsAvailable } }
      );

    // Fixed 1:1 internal conversion (Phase 006 flattening, 2026-07-08):
    // 1 BB token = ₹1 on withdrawal. Phase 010: a configurable payout fee
    // (SystemConfig.payoutFeePercent — Business Policy owns the number,
    // Risk owns the arithmetic, R&S records it in PAYOUT_FEES) may be
    // deducted from the fiat paid out. Default 0% — behavior unchanged
    // until an admin sets a fee.
    const riskRules      = await getRiskRules();
    const payoutFeeMinor = computePayoutFeeMinor(tokenAmount, riskRules.payoutFeePercent);
    const payoutFee      = payoutFeeMinor / 100; // rupees, for the order document
    const fiatAmount     = tokenAmount - payoutFee;

    const order = new PaymentOrder({
      orderId:         `WD_${crypto.randomBytes(12).toString('hex')}`,
      type:            'WITHDRAWAL',
      userId:          user._id,
      tokenAmount,
      fiatAmount,
      payoutFee,
      rateUsed:        1, // fixed 1:1 conversion
      status:          'PENDING_QUEUE',
      createdAt:       new Date(),
      escrowLocked:    true,
      escrowAmount:    tokenAmount,
      // userKycSnapshot removed 2026-08-25. It was write-only three times over:
      // sanitizeOrderForMerchant and sanitizeMerchantOrder both delete it before
      // any response, its `aadhaar` field was never a path on the PaymentOrder
      // schema so Mongoose dropped it silently, and `pan`/`nameOnAadhaar` are no
      // longer collected at all. A merchant verifies a payout against
      // userBankDetails, which is real and is sent.
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
    if (assigned) {
      emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'ASSIGNED', server_ts: Date.now() });
    } else {
      // Sell orders become an open merchant pool item immediately. They do not
      // consume the deposit retry loop because any eligible merchant may accept
      // them later as their sell capacity opens up.
      emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'PENDING_QUEUE', pool: 'SELL_OPEN_POOL', server_ts: Date.now() });
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
        deposit:  wallet.depositBalance,
        winnings: debitResult.winningsAfter ?? (winningsAvailable - tokenAmount),
        total:    wallet.depositBalance + (debitResult.winningsAfter ?? (winningsAvailable - tokenAmount)),
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
export async function markOrderPaid(userId, orderId, utrNumber, proofFileKey, proofCdnUrl = null) {
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

  const verifiedProof = await cdnService.verifyUploadedObject({
    fileKey: proofFileKey.trim(),
    cdnUrl: proofCdnUrl || undefined,
    expectedUserId: userId.toString(),
    expectedOrderId: order.orderId,
    expectedCategory: 'payment-proof',
  });

  try {
    await markUTRAsUsed(normalizedUTR, order._id, order.userId, order.fiatAmount);
  } catch (err) {
    if (err.code === 11000) {
      // FIX (2026-07-09): was '../models/' (resolves to nonexistent
      // domains/models/) — crashed the duplicate-UTR path. Correct: ../../models/.
      const { UTRRegistry } = await import('../../models/utrRegistry.model.js');
      const existing = await UTRRegistry.findOne({ utr: normalizedUTR }).lean();
      throw Object.assign(
        new Error('This UTR was already used. Contact support.'),
        { status: 409, code: 'DUPLICATE_UTR', originalOrderId: existing?.orderId }
      );
    }
    throw err;
  }

  // The UTR was consumed above and is not returnable, so the transition being
  // refused here means the order moved under us between the status read and
  // now — a 409, not a 400: the request was understood and is no longer valid.
  const paid = await markOrderPaidState(order._id, {
    expectFrom: ['ASSIGNED', 'PROCESSING'],
    set: {
      utrNumber:       normalizedUTR,
      proofScreenshot: verifiedProof.cdnUrl,
      paidAt:          new Date(),
      updatedAt:       new Date(),
    },
  });
  if (!paid.ok) {
    throw Object.assign(
      new Error(`Cannot mark paid — order is in ${paid.status ?? 'unknown'} status`),
      { status: 409, code: paid.reason },
    );
  }
  // The POST-transition document. Returning the stale `order` would report a
  // PAID order still showing its previous status and no UTR.
  const paidOrder = paid.order ?? order;
  order.status          = 'PAID';
  order.utrNumber       = normalizedUTR;
  order.proofScreenshot = verifiedProof.cdnUrl;
  order.paidAt          = paidOrder.paidAt;

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

  // ORDER INVERTED, deliberately. This refunded the escrow FIRST and set the
  // status afterwards, guarded only by the `order.status` read above — stale by
  // the time it mattered. A user double-tapping cancel put two refunds in
  // flight, and only refundWithdrawal's own idempotency key stopped the second
  // credit, which means the protection lived in a different domain from the
  // decision. The transition decides now, and only the winner refunds.
  const cancelled = await cancelOrderState(order._id, {
    expectFrom: 'PENDING_QUEUE',
    set: {
      cancelReason:  'USER_CANCELLED',
      cancelledAt:   new Date(),
      updatedAt:     new Date(),
      ...(order.type === 'WITHDRAWAL' && order.escrowLocked ? { escrowLocked: false } : {}),
    },
  });
  if (!cancelled.ok) {
    throw Object.assign(
      new Error('Order cannot be cancelled at this stage'),
      { status: 409, code: cancelled.reason },
    );
  }
  if (!cancelled.idempotent && order.type === 'WITHDRAWAL' && order.escrowLocked) {
    await refundWithdrawal(order.userId, order.tokenAmount, order._id.toString());
  }
  await emitWalletUpdate(order.userId);
  return cancelled.order ?? order;
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
      // Two instances running this cron both read the same expired batch. The
      // transition is what makes the refund happen once: the loser gets
      // `idempotent` and skips the release rather than racing it.
      const expired = await cancelOrderState(order._id, {
        expectFrom: ['ASSIGNED', 'PROCESSING'],
        set: { cancelReason: 'EXPIRED', cancelledAt: now, updatedAt: now },
      });
      if (!expired.ok || expired.idempotent) continue;
      order.status = 'CANCELLED';

      // Release escrow if WITHDRAWAL
      if (order.type === 'WITHDRAWAL' && order.escrowLocked) {
        await refundWithdrawal(
          order.userId, order.tokenAmount, order._id.toString()
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
