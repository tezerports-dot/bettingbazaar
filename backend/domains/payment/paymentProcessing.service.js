// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/payment/paymentProcessing.service.js — deposits and withdrawals.
 *
 * ── Withdrawal admission is ONE decision, under the wallet's row lock ───────
 * This path is where money LEAVES the platform. It used to admit a withdrawal
 * by reading the player's winnings, summing their in-flight withdrawals, and
 * comparing — three reads, then a debit, with nothing holding them together.
 * Two requests arriving together both passed.
 *
 * Worse, the pending-order sum DOUBLE-COUNTED. The escrow debit moves winnings
 * into `lockedBalance`, so an in-flight withdrawal is already out of the
 * winnings figure the check compared against: a player with ₹1,000 who asked
 * for ₹400 was left holding winnings ₹600 and locked ₹400, and their next ₹400
 * request was refused by `400 + 400 > 600` — against money they genuinely had.
 * The guard both let overdrafts through under concurrency and refused
 * legitimate withdrawals the rest of the time.
 *
 * `debitWinningsForWithdrawal` decides. It moves winnings → locked under
 * `SELECT … FOR UPDATE` on the wallet row, in the same transaction as its
 * ledger entry, and refuses what the row cannot fund. There is nothing left
 * here to get wrong, because there is no check here.
 *
 * ── The order is created in one statement ───────────────────────────────────
 * It used to be a `new PaymentOrder(...)` with a pre-save hook computing the
 * deposit split invisibly, then a `save()`, then further writes. The split is
 * explicit now (`db.depositPolicy.splitForDeposit`) and the order arrives
 * complete — allocations, escrow flag, bank details and all — so it can never
 * be picked up by the assignment sweep in a half-built state.
 *
 * NOTE: this file calls the Merchant domain's `selectBestMerchant()` directly.
 * That is pre-existing cross-domain coupling, flagged per BBEPS Phase 003 §3.7.
 */
import crypto from 'crypto';
import { db } from '#db';
import { debitWinningsForWithdrawal, refundWithdrawal, getBalances } from '../wallet/walletAuthority.service.js';
import { selectBestMerchant } from '../merchant/merchantScoring.service.js';
import { merchantTypeOf } from '../merchant/merchantCurrency.js';
// Risk Platform (Phase 010): the single validation authority for funding orders.
import { assessFundingOrder, getRiskRules, computePayoutFeeMinor } from '../risk/riskValidation.service.js';
import { markUTRAsUsed } from '../../middleware/utrValidation.js';
// The order state machine. Every status change goes through here so an illegal
// move is refused by the database rather than by whichever check ran first.
import {
  assignOrder as assignOrderState, markOrderPaid as markOrderPaidState,
  cancelOrder as cancelOrderState,
} from './orderLifecycle.service.js';
import { emitWalletUpdate, emitOrderUpdate, emitMerchantUpdate, emitAdminUpdate } from '../notification/realtimeEmitters.js';
import cdnService from '../../services/cdn.service.js';
import { getSystemConfig } from '#db/repositories/config.js';

// ─── Shared admin SSE payload ─────────────────────────────────────────────────
function adminOrderPayload(order, user) {
  return {
    _id:            order.orderId,
    orderId:        order.orderId,
    type:           order.type,
    status:         order.status,
    fiatAmount:     order.fiatAmount,
    tokenAmount:    order.tokenAmount,
    userName:       user?.username,
    userMobile:     user?.mobile,
    userId:         user?.userId || order.userId,
    merchantProfit: order.merchantProfit || 0,
    rateUsed:       order.rateUsed,
    createdAt:      order.createdAt,
    server_ts:      Date.now(),
  };
}

// ─── Build merchantSnapshot from a merchant row ───────────────────────────────
function merchantDisplayRef(merchant) {
  return `Merchant #${merchant.publicRef}`;
}

function buildMerchantSnapshot(merchant, expiresAt) {
  return {
    merchantId:    merchant.merchantId,
    merchantName:  merchantDisplayRef(merchant),
    // A merchant settles on exactly one rail, so exactly one credential set is
    // populated: UPI/bank for an INR merchant, the TRC-20 address for a USDT
    // merchant. The user panel renders whichever is present.
    merchantType:  merchantTypeOf(merchant),
    upiId:         merchant.bankDetails?.upiId             || '',
    qrCodeUrl:     merchant.qrCodeUrl                      || '',
    bankName:      merchant.bankDetails?.bankName          || '',
    accountNo:     merchant.bankDetails?.accountNo         || '',
    ifsc:          merchant.bankDetails?.ifsc              || '',
    accountHolder: merchant.bankDetails?.accountHolderName || '',
    usdtAddress:   merchant.usdtWalletAddress              || '',
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
    const cfg = await getSystemConfig();
    const m = cfg?.orderExpiryMinutes;
    if (Number.isFinite(m) && m >= 1 && m <= 1440) return m * 60 * 1000;
  } catch { /* fall through to default */ }
  return 15 * 60 * 1000;
}

// ─── Attempt to assign order to best merchant; returns true if assigned ────────
async function tryAssignMerchant(order) {
  // Pass the order's rail: `selectBestMerchant` matches it against the
  // merchant's accepted currencies, so a USDT order can only reach a USDT
  // merchant and an INR order only an INR merchant. The argument was once
  // omitted and every order fell back to the 'INR' default, which would have
  // routed a USDT order to an INR merchant (2026-07-27).
  const merchant = await selectBestMerchant(order.type, order.tokenAmount, order.currency);
  if (!merchant) return false;

  const expiresAt = new Date(Date.now() + await getOrderExpiryMs()); // admin-configurable window
  const snapshot  = buildMerchantSnapshot(merchant, expiresAt);

  // The transition is the gate. Two assignment passes racing the same queued
  // order — the synchronous attempt at creation and the retry loop, which do
  // overlap — both used to pass a `status === 'PENDING_QUEUE'` read and both
  // used to save, so the second silently overwrote the first merchant's
  // assignment. Exactly one caller now matches a row.
  const moved = await assignOrderState(order.orderId, {
    set: {
      merchantId:       merchant.merchantId,
      assignedAt:       new Date(),
      expiresAt,
      merchantSnapshot: snapshot,
    },
  });
  if (!moved.ok || moved.idempotent) return false;

  // Keep the caller's in-memory copy consistent with what was written, so the
  // emitters below describe the row that exists rather than a hoped-for one.
  Object.assign(order, {
    merchantId: merchant.merchantId,
    status: 'ASSIGNED',
    assignedAt: moved.order.assignedAt,
    expiresAt,
    merchantSnapshot: snapshot,
  });

  // No activeOrderCount increment. That counter is DERIVED from the orders
  // themselves (`db.merchants.getActiveOrderCounts`), so there is nothing to
  // bump and nothing to leave stale when an assignment is refused — which is
  // precisely how a merchant ended up holding a count for an order they did
  // not have.

  // Notify merchant via SSE (GOVERNANCE §11: new_order)
  emitMerchantUpdate(String(merchant.merchantId), 'new_order', {
    ...order,
    server_ts: Date.now(),
  });

  // Notify user: order_assigned (GOVERNANCE §11)
  emitOrderUpdate(String(order.userId), 'order_assigned', {
    orderId:          order.orderId,
    _id:              order.orderId,
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
      const order = await db.orders.getOrderRecord(orderId);
      if (!order || order.status !== 'PENDING_QUEUE') return; // already assigned/cancelled

      if (await tryAssignMerchant(order)) {
        emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'ASSIGNED', server_ts: Date.now() });
        return;
      }

      if (attempts >= MAX_RETRIES) {
        // Expire the order. The transition gates the refund: this loop and the
        // expireOrders cron can both reach the same order, and only the caller
        // that actually moved it may release the escrow.
        const expired = await cancelOrderState(order.orderId, {
          expectFrom: 'PENDING_QUEUE',
          set: { cancelReason: 'EXPIRED', cancelledAt: new Date() },
        });
        if (!expired.ok || expired.idempotent) return;
        order.status = 'CANCELLED';

        // Release escrow if WITHDRAWAL
        if (order.type === 'WITHDRAWAL' && order.escrowLocked) {
          await refundWithdrawal(order.userId, order.tokenAmount, order.orderId)
            .catch(e => console.error('[startPendingRetryLoop] escrow release failed:', e.message));
        }

        emitOrderUpdate(String(order.userId), 'order_expired', {
          orderId:   order.orderId,
          _id:       order.orderId,
          status:    'CANCELLED',
          reason:    'EXPIRED',
          server_ts: Date.now(),
        });
        emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'CANCELLED', reason: 'EXPIRED' });
        return;
      }

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
  const cfg        = await getSystemConfig();
  const minDeposit = cfg?.minDeposit || 100;
  const maxDeposit = cfg?.maxDeposit || 50000;

  // Risk Platform gate (Phase 010): positive/numeric/multiples-of-10,
  // min/max, velocity — the single validation authority.
  await assessFundingOrder({ userId, tokenAmount, type: 'DEPOSIT', min: minDeposit, max: maxDeposit });

  const user = await db.users.getUser(userId);
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  if (user.isBlocked) {
    throw Object.assign(
      new Error('Your account has been suspended due to payment violations. Contact support.'),
      { status: 403, code: 'USER_BLOCKED' },
    );
  }
  if (user.kycStatus !== 'APPROVED') {
    throw Object.assign(new Error('Please complete KYC verification to purchase tokens'), { status: 403 });
  }

  // Fixed 1:1 internal conversion (Phase 006 flattening, 2026-07-08): 1 BB
  // token = ₹1, no buy/sell spread. Merchant earnings come from the
  // cycle-completion Merchant Performance Bonus, never from a rate spread.
  const fiatAmount = tokenAmount;

  // ── The split, computed HERE ────────────────────────────────────────────
  // This was a pre-save hook on the order model: invisible, and a second
  // writer to a value with a designated owner. The service that computes the
  // note below used to derive it from its own stale local variables while the
  // hook silently overwrote the persisted ones — so the order was right and
  // the message describing it was wrong. One computation, one source.
  const split = await db.depositPolicy.splitForDeposit(tokenAmount, user.currency || 'INR');

  // Created COMPLETE, in one statement. It used to be a save followed by
  // further writes, and between them the order existed at PENDING_QUEUE with a
  // zero allocation — visible to the assignment sweep in that state, and stuck
  // there for good if the process died in between.
  const order = await db.orders.createOrderRecord({
    orderId:           `DEP_${crypto.randomBytes(12).toString('hex')}`,
    userId:            user.userId,
    type:              'DEPOSIT',
    tokenAmountRupees: tokenAmount,
    fiatAmountRupees:  fiatAmount,
    rateUsed:          1,
    merchantProfit:    0,
    depositAllocation: split.depositAllocation,
    reserveAllocation: split.reserveAllocation,
    depositPolicySnapshot: split.snapshot,
  });

  emitAdminUpdate('new_order', adminOrderPayload(order, user));

  // Auto-assign merchant immediately
  if (await tryAssignMerchant(order)) {
    emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'ASSIGNED', server_ts: Date.now() });
  } else {
    startPendingRetryLoop(order.orderId);
  }

  return {
    order: {
      _id:               order.orderId,
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
    // Built from the STORED figures, so the message and the order agree.
    note: `You will pay ₹${fiatAmount.toLocaleString()} to receive ${tokenAmount} BB tokens (${order.depositAllocation} betting + ${order.reserveAllocation} reserve)`,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// createWithdrawalOrder
// ═════════════════════════════════════════════════════════════════════════════
export async function createWithdrawalOrder(userId, tokenAmount) {
  const cfg         = await getSystemConfig();
  const minWithdraw = cfg?.minWithdrawal || 500;
  const maxWithdraw = cfg?.maxWithdrawal || 50000;

  await assessFundingOrder({ userId, tokenAmount, type: 'WITHDRAWAL', min: minWithdraw, max: maxWithdraw });

  const user = await db.users.getUser(userId);
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  if (user.isBlocked) {
    throw Object.assign(
      new Error('Your account has been suspended due to payment violations. Contact support.'),
      { status: 403, code: 'USER_BLOCKED' },
    );
  }
  if (user.kycStatus !== 'APPROVED') {
    throw Object.assign(new Error('Please complete KYC verification before withdrawing'), { status: 403 });
  }
  if (!user.bankDetails?.accountNumber || !user.bankDetails?.ifscCode) {
    throw Object.assign(new Error('Please add your bank account details before withdrawing'), { status: 400 });
  }

  // Phase 010: a configurable payout fee (SystemConfig.payoutFeePercent —
  // Business Policy owns the number, Risk owns the arithmetic) may be deducted
  // from the fiat paid out. Default 0%.
  const riskRules      = await getRiskRules();
  const payoutFeeMinor = computePayoutFeeMinor(tokenAmount, riskRules.payoutFeePercent);
  const payoutFee      = payoutFeeMinor / 100;
  const fiatAmount     = tokenAmount - payoutFee;

  const orderId = `WD_${crypto.randomBytes(12).toString('hex')}`;

  // ── ADMISSION ───────────────────────────────────────────────────────────
  // The escrow debit IS the gate, and it is the whole gate: winnings → locked
  // under `SELECT … FOR UPDATE` on the wallet row, in one transaction with its
  // ledger entry, refusing what the row cannot fund. Idempotent on `wd_<id>`.
  //
  // It runs BEFORE the order row exists. A failed debit therefore leaves
  // nothing behind to undo — the alternative, writing the order first, means a
  // refused debit needs a compensating delete that can itself fail, and a
  // crash between the two leaves an escrow-flagged order holding money that
  // was never taken.
  //
  // The three checks that used to precede it are gone. See the module header:
  // they raced each other AND double-counted the escrow, so they admitted
  // overdrafts under concurrency and refused legitimate withdrawals otherwise.
  let debitResult;
  try {
    debitResult = await debitWinningsForWithdrawal(String(user.userId), tokenAmount, orderId);
  } catch (err) {
    if (err.code === 'INSUFFICIENT_WITHDRAWABLE') {
      // The figures come off the refusal, from the rows the debit locked —
      // never from a record read separately, which is how a player was once
      // told an available balance no wallet ever held.
      const pending = await db.orders.pendingWithdrawalTotal(user.userId);
      throw Object.assign(
        new Error(
          `Insufficient winnings balance. Available: ${err.availableWinnings} tokens`
          + (pending > 0 ? ` (${pending} already committed to withdrawals in progress).` : '.'),
        ),
        {
          status: 400,
          balance: { winnings: err.availableWinnings, pending },
        },
      );
    }
    throw err;
  }

  const order = await db.orders.createOrderRecord({
    orderId,
    userId:            user.userId,
    type:              'WITHDRAWAL',
    tokenAmountRupees: tokenAmount,
    fiatAmountRupees:  fiatAmount,
    payoutFee,
    rateUsed:          1,
    escrowLocked:      true,
    escrowStatus:      'LOCKED',
    escrowAmount:      tokenAmount,
    // A merchant verifies a payout against these. `userKycSnapshot` was removed
    // 2026-08-25: it was stripped from every response before it reached anyone,
    // and its `aadhaar` field was never a real path on the model.
    userBankDetails: {
      accountNumber:     user.bankDetails?.accountNumber || '',
      ifscCode:          user.bankDetails?.ifscCode      || '',
      bankName:          user.bankDetails?.bankName      || '',
      accountHolderName: user.bankDetails?.accountHolderName || user.username || '',
      upiId:             user.bankDetails?.upiId || '',
    },
    userPhone: user.mobile,
  });

  emitAdminUpdate('new_order', adminOrderPayload(order, user));
  await emitWalletUpdate(user.userId);

  if (await tryAssignMerchant(order)) {
    emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'ASSIGNED', server_ts: Date.now() });
  } else {
    // Sell orders become an open merchant pool item immediately. They do not
    // consume the deposit retry loop because any eligible merchant may accept
    // them later as their sell capacity opens up.
    emitAdminUpdate('queue_order_update', {
      orderId: order.orderId, status: 'PENDING_QUEUE', pool: 'SELL_OPEN_POOL', server_ts: Date.now(),
    });
  }

  return {
    order: {
      _id:              order.orderId,
      orderId:          order.orderId,
      tokenAmount:      order.tokenAmount,
      fiatAmount:       order.fiatAmount,
      rateUsed:         order.rateUsed,
      status:           order.status,
      merchantSnapshot: order.merchantSnapshot,
      expiresAt:        order.expiresAt,
      userBankDetails:  order.userBankDetails,
    },
    // From the movement that actually happened, not from a record read before
    // it. `debitResult.balances` is what the wallet holds now.
    remainingBalance: {
      deposit:  debitResult.balances?.depositBalance ?? 0,
      winnings: debitResult.balances?.winningsBalance ?? 0,
      total:    (debitResult.balances?.depositBalance ?? 0) + (debitResult.balances?.winningsBalance ?? 0),
    },
    note: `You will receive ₹${fiatAmount.toLocaleString()} from merchant`,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// markOrderPaid  — user submits UTR + screenshot (DEPOSIT only)
// ═════════════════════════════════════════════════════════════════════════════
export async function markOrderPaid(userId, orderId, utrNumber, proofFileKey, proofCdnUrl = null) {
  const order = await db.orders.getOrderRecord(orderId);
  if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

  if (String(order.userId) !== String(userId))
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

  // The claim decides in ONE statement. It used to be a check followed by an
  // insert, so two submissions of the same reference arriving together both
  // passed the check and one then died on the index — a 500 to a player who
  // had done nothing wrong. The refusal now names which rule stopped it and
  // carries the order that holds the reference, so support has an answer
  // without a second lookup.
  const claimed = await markUTRAsUsed(normalizedUTR, order.orderId, order.userId, order.fiatAmount);
  if (!claimed.ok) {
    throw Object.assign(
      new Error(claimed.reason === 'FRAUD_FLAGGED'
        ? 'This payment reference is under review. Contact support.'
        : 'This UTR was already used. Contact support.'),
      {
        status: 409,
        code: claimed.reason,
        originalOrderId: claimed.entry?.orderId ?? null,
      },
    );
  }

  // The UTR was consumed above and is not returnable, so the transition being
  // refused here means the order moved under us between the status read and
  // now — a 409, not a 400: the request was understood and is no longer valid.
  const paid = await markOrderPaidState(order.orderId, {
    expectFrom: ['ASSIGNED', 'PROCESSING'],
    set: {
      utrNumber:       normalizedUTR,
      proofScreenshot: verifiedProof.cdnUrl,
      paidAt:          new Date(),
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
    emitMerchantUpdate(String(order.merchantId), 'order_paid', {
      orderId:         order.orderId,
      _id:             order.orderId,
      status:          'PAID',
      utrNumber:       normalizedUTR,
      proofScreenshot: order.proofScreenshot,
      fiatAmount:      order.fiatAmount,
      tokenAmount:     order.tokenAmount,
      paidAt:          order.paidAt,
      server_ts:       Date.now(),
    });
  }
  emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'PAID', server_ts: Date.now() });

  return order;
}

/**
 * Record an order against a merchant's scoring stats.
 *
 * ── Two statements became one ───────────────────────────────────────────────
 * This incremented the counters, read them back, computed `successRate` from
 * what it read, and wrote that in a SECOND update. Two orders completing
 * together both read the same totals, and both wrote a rate that described
 * neither — a merchant's success rate drifting away from their own counters
 * with nothing to say which was right.
 *
 * `recordCompletedOrder` derives the rate from the counters the same statement
 * is moving, so the rate and the count it describes are always the same pair.
 *
 * The `activeOrderCount: -1` is gone with no replacement. That figure is
 * DERIVED from the orders themselves, so there is no counter to decrement and
 * none to leave wrong when this is called twice or not at all.
 */
export async function updateMerchantStatsOnComplete(merchantId, success, detail = {}) {
  if (!merchantId) return;
  await db.merchants.recordCompletedOrder(merchantId, {
    direction: detail.direction ?? 'DEPOSIT',
    amountRupees: detail.amountRupees ?? 0,
    earningsRupees: detail.earningsRupees ?? 0,
    // `success` false means the order did not complete. It still counts toward
    // total_orders_all, which is what makes the success rate fall.
    disputed: !success,
    responseMinutes: detail.responseMinutes ?? null,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// cancelOrder  — user or admin cancels a PENDING_QUEUE order
// ═════════════════════════════════════════════════════════════════════════════
export async function cancelOrder(actorId, isAdmin, orderId) {
  const order = await db.orders.getOrderRecord(orderId);
  if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

  if (String(order.userId) !== String(actorId) && !isAdmin)
    throw Object.assign(new Error('Access denied'), { status: 403 });

  // ORDER INVERTED, deliberately. This refunded the escrow FIRST and set the
  // status afterwards, guarded only by a stale status read. A user
  // double-tapping cancel put two refunds in flight, and only
  // `refundWithdrawal`'s own idempotency key stopped the second credit — which
  // means the protection lived in a different domain from the decision. The
  // transition decides now, and only the winner refunds.
  const cancelled = await cancelOrderState(order.orderId, {
    expectFrom: 'PENDING_QUEUE',
    set: {
      cancelReason: 'USER_CANCELLED',
      cancelledAt:  new Date(),
      ...(order.type === 'WITHDRAWAL' && order.escrowLocked
        ? { escrowLocked: false, escrowStatus: 'REFUNDED' }
        : {}),
    },
  });
  if (!cancelled.ok) {
    throw Object.assign(
      new Error('Order cannot be cancelled at this stage'),
      { status: 409, code: cancelled.reason },
    );
  }
  if (!cancelled.idempotent && order.type === 'WITHDRAWAL' && order.escrowLocked) {
    await refundWithdrawal(order.userId, order.tokenAmount, order.orderId);
  }
  await emitWalletUpdate(order.userId);
  return cancelled.order ?? order;
}

// ═════════════════════════════════════════════════════════════════════════════
// expireOrders  — cron worker (called from cronJobs.js or setInterval)
// ═════════════════════════════════════════════════════════════════════════════
export async function expireOrders() {
  // The due set comes from the DATABASE's clock, not the app server's. Three
  // instances with drifting clocks expiring the same orders is how an order
  // gets refunded a minute before its own deadline.
  const expired = await db.orders.findExpiredOrders({ limit: 500 });
  if (expired.length === 0) return 0;

  let count = 0;
  for (const order of expired) {
    try {
      // Two instances running this cron both read the same expired batch. The
      // transition is what makes the refund happen once: the loser gets
      // `idempotent` and skips the release rather than racing it.
      // PENDING_QUEUE is in this list, and was not before. The retry loop that
      // expires an unassigned order is a `setTimeout` chain living in one
      // process — so a restart between an order's creation and its deadline
      // orphaned it permanently, and for a WITHDRAWAL that means the player's
      // money sits in escrow forever with nothing scheduled to release it.
      const moved = await cancelOrderState(order.orderId, {
        expectFrom: ['PENDING_QUEUE', 'ASSIGNED', 'PROCESSING'],
        set: {
          cancelReason: 'EXPIRED',
          cancelledAt:  new Date(),
          ...(order.type === 'WITHDRAWAL' && order.escrowLocked
            ? { escrowLocked: false, escrowStatus: 'REFUNDED' }
            : {}),
        },
      });
      if (!moved.ok || moved.idempotent) continue;

      // Release escrow if WITHDRAWAL
      if (order.type === 'WITHDRAWAL' && order.escrowLocked) {
        await refundWithdrawal(order.userId, order.tokenAmount, order.orderId)
          .catch(e => console.error('[expireOrders] escrow release failed:', e.message));
      }

      // Scoring: the merchant did not complete it.
      if (order.merchantId) {
        await updateMerchantStatsOnComplete(order.merchantId, false, {
          direction: order.type, amountRupees: order.tokenAmount,
        }).catch(() => {});
      }

      emitOrderUpdate(String(order.userId), 'order_expired', {
        orderId:   order.orderId,
        _id:       order.orderId,
        status:    'CANCELLED',
        reason:    'EXPIRED',
        expiresAt: order.expiresAt,
        server_ts: Date.now(),
      });
      emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'CANCELLED', reason: 'EXPIRED' });
      count++;
    } catch (e) {
      console.error('[expireOrders] failed:', order.orderId, e.message);
    }
  }
  return count;
}

// Export tryAssignMerchant for re-assignment after rejection
export { tryAssignMerchant, buildMerchantSnapshot };
