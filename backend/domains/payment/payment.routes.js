// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** payment.routes.js — player-facing Payment domain routes (BBEPS Phase 003 §3.3).
 * Moved from backend/routes/payment.routes.js on 2026-07-01 (BBEPS Phase 004 migration). */
import express   from 'express';
import { db }    from '#db';
import { authenticate, requireApprovedKyc, requireLinkedKyc } from '../identity/auth.middleware.js';
import { tryVerifyJwt } from '../identity/jwt.util.js';
import { merchantAuth } from '../../middleware/merchantAuth.js';
import {
  withdrawalLimiter,
  // Creating a USDT purchase reaches the merchant queue and holds a price.
  usdtDepositLimiter,
  // Both of these routes shipped with no limit at all. A retry creates a NEW
  // order and, on a sell, locks tokens in escrow; the grace claim extends an
  // order's own deadline. Neither is a login route, so no auth tier covered
  // them, and the global backstop is 1000 requests per 15 minutes.
  orderRetryLimiter, utrGraceLimiter,
} from '../../middleware/security.js';
// Wallet operations are for channel members — same gate as betting.
import { requireChannelMembership } from '../../middleware/requireChannelMembership.js';
// Item 12: per-subnet backstop against IP rotation on withdrawal creation.
import { createSubnetLimiter, globalSurgeBreaker } from '../../middleware/ipDefense.js';
import { markOrderPaid, cancelOrder, claimUtrGrace, retryOrder } from './paymentProcessing.service.js';
// The only shape of an order a player receives. A player sees where to pay and
// nothing about who they are paying.
import { toPlayerOrderView, toPlayerOrderViews } from './playerOrderView.js';
// The ONE system-config payload. The USDT rail's amounts and networks are money
// rules, so the panel is told them rather than holding its own copy.
import { systemConfigPayload } from '../configuration/systemConfigPayload.js';
import { getSystemConfig } from '#db/repositories/config.js';
// The mirror of it. `deposit/:orderId/confirm` answers a merchant or an admin,
// so this file needs both projections.
import { toMerchantOrderView } from '../merchant/merchantOrderView.js';
// The order state machine — every status change is a guarded transition.
import { completeOrder, disputeOrder } from './orderLifecycle.service.js';
// Phase 009: money movement enters ONLY via the Funding Platform authority.
import { requestDeposit, requestWithdrawal } from '../funding/fundingAuthority.service.js';
import { creditDeposit, creditReserve } from '../wallet/walletAuthority.service.js';
// One rule for how a confirmed deposit splits across the user's two pockets,
// and for what the merchant is debited against it.
import { moveDepositMoney } from './depositCredit.js';
import { debitMerchantTokens } from '../merchant/merchantWallet.service.js';
import { releaseUTR } from '../../middleware/utrValidation.js';
// The one owner of order access: it verifies the tamper tag AND decides who
// may act on the order, so a route cannot be added without both.
import { orderAccessGuard } from '../../middleware/order-crypto-access.js';
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
 * The ONE shape a player receives. See `playerOrderView.js` for what was being
 * sent before it existed — the merchant's UPI handle, their QR, and their bank
 * account number, IFSC and account-holder name, on every deposit.
 */
function forPlayer(order) {
  return toPlayerOrderView(order);
}

/*
 * ── The last denylist on this route, removed ────────────────────────────────
 * A `sanitize...ForMerchant` helper stood here and `delete`d four field names
 * from a copy of the order. That is the shape of the leak `merchantOrderView.js`
 * was built to end: a denylist admits the next column added to `order_states`
 * by default, and the mistake is always "too much". `deposit/:orderId/confirm`
 * answers a merchant, so it answers through `toMerchantOrderView` like every
 * other merchant-facing responder on the platform.
 */

// Money IN needs only LINKED identity, not an approved one (owner decision
// 2026-09-08). Verification runs in batches and can take a day; holding a
// player at the door for it loses the player without protecting anyone, and the
// deposit lands in their own wallet either way.
//
// `requireApprovedKyc` stays on the withdrawal below. That is the whole of the
// stricter rule and it is where it belongs: money leaving is the irreversible
// direction.
router.post('/deposit/create', authenticate, requireLinkedKyc, requireChannelMembership({ action: 'add funds' }), async (req, res) => {
  try {
    const result = await requestDeposit({ userId: req.user.userId, tokenAmount: Number(req.body.tokenAmount) });
    res.json({ success: true, message: 'Deposit request created. Waiting for merchant assignment.', ...result });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message, code: err.code }); }
});

/**
 * POST /api/payment/usdt/deposit/create — buy above the INR ceiling.
 *
 * ── Why this is a separate route from `/deposit/create` ────────────────────
 * It is a different rail with different rules — two fixed amounts, and a chain
 * the player must choose — and the two are not interchangeable. One route
 * branching on a body field would make "which rail am I on" a question every
 * reader of the handler has to answer, and the failure mode is a request that
 * silently lands on the wrong one.
 *
 * The SERVER still decides what each rail serves: `assertBuyIsLegal` refuses a
 * ₹5,000 purchase here and a ₹50,000 one on the INR route, whatever a client
 * asks for.
 *
 * `requireLinkedKyc`, matching the INR deposit exactly — money IN needs linked
 * identity, and holding a player at the door while verification runs in batches
 * loses the player without protecting anyone. The stricter rule belongs on
 * withdrawal, where the money leaves.
 */
router.post('/usdt/deposit/create',
  authenticate,
  requireLinkedKyc,
  requireChannelMembership({ action: 'add funds' }),
  usdtDepositLimiter,
  async (req, res) => {
    try {
      const result = await requestDeposit({
        userId: req.user.userId,
        tokenAmount: Number(req.body.tokenAmount),
        usdtChain: req.body.usdtChain,
        provider: 'USDT',
      });
      res.json({ success: true, message: 'USDT purchase created. Waiting for a merchant.', ...result });
    } catch (err) {
      res.status(err.status || 500).json({ success: false, message: err.message, code: err.code });
    }
  });

/**
 * GET /api/payment/usdt/rail — the two amounts and the networks.
 *
 * From the SERVER, because both are money rules: a panel with its own copy
 * would offer an amount the gate refuses, or a network no merchant holds.
 */
router.get('/usdt/rail', authenticate, async (req, res) => {
  const cfg = systemConfigPayload(await getSystemConfig());
  res.json({
    success: true,
    denominations: cfg.usdtBuyDenominations,
    chains: cfg.usdtChains,
  });
});

// APPROVED, not merely linked. Every withdrawal here draws from the WINNINGS
// balance — `debitWinningsForWithdrawal` is the only debit path — so "approved
// KYC to withdraw winnings" and "approved KYC to withdraw" are the same rule on
// this platform, and this line is it.
router.post('/withdrawal/create', authenticate, requireApprovedKyc, requireChannelMembership({ action: 'withdraw' }), withdrawalLimiter, createSubnetLimiter('withdrawal'), globalSurgeBreaker('withdrawal'), async (req, res) => {
  try {
    const result = await requestWithdrawal({ userId: req.user.userId, tokenAmount: Number(req.body.tokenAmount) });
    res.json({ success: true, message: 'Withdrawal request created. Waiting for merchant assignment.', ...result });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message, code: err.code, cutoffPassed: err.cutoffPassed, balance: err.balance }); }
});

/**
 * POST /api/payment/order/:orderId/retry — try again, at the front of the queue.
 *
 * An order that never found a merchant owes nothing: no assignment means no
 * transaction happened and nobody is liable. The player still wants their
 * tokens though, and sending them to the back of the queue that just failed
 * them is how somebody waits twice and gets nothing twice — so the new order
 * outranks a first attempt.
 *
 * A NEW order, not a revival: CANCELLED is terminal, and reviving it would mean
 * letting any cancelled order in the system come back to life.
 *
 * It runs the ordinary creation path, so every guard a first attempt passes a
 * retry passes too — including, on a sell, the escrow debit under the wallet's
 * row lock. The database refuses a second retry of the same order.
 */
router.post('/order/:orderId/retry', authenticate, orderRetryLimiter, orderAccessGuard, async (req, res) => {
  try {
    const result = await retryOrder(req.user.userId, req.params.orderId);
    res.json({ success: true, ...result });
  } catch (err) {
    // A duplicate retry is refused by a unique index, which surfaces as a
    // driver error rather than one of ours. Said plainly, because the player's
    // second tap is an ordinary thing to do and the answer is "you already did".
    const duplicate = err?.code === '23505';
    res.status(duplicate ? 409 : (err.status || 500)).json({
      success: false,
      code: duplicate ? 'ALREADY_RETRIED' : err.code,
      message: duplicate
        ? 'You have already retried this order — look for the newer one in your list.'
        : err.message,
    });
  }
});

/**
 * POST /api/payment/order/:orderId/utr-grace — "I have paid, give me a minute".
 *
 * The order's timer IS the UTR deadline, so a player who taps this with seconds
 * left would otherwise watch the order expire while they go and find a
 * twelve-character bank reference — cancelling a payment they have already
 * made. This claims `utrSubmitSeconds` from now (admin-editable, default 60),
 * and only ever moves the deadline outward.
 *
 * Claimable ONCE, decided in the UPDATE's WHERE clause. Repeatable, it is not a
 * courtesy but an unbounded extension, and the merchant's capacity is what it
 * spends.
 */
router.post('/order/:orderId/utr-grace', authenticate, utrGraceLimiter, orderAccessGuard, async (req, res) => {
  try {
    const order = await claimUtrGrace(req.user.userId, req.params.orderId);
    res.json({ success: true, expiresAt: order.expiresAt, graceTakenAt: order.utrGraceAt });
  } catch (err) {
    res.status(err.status || 500).json({
      success: false, message: err.message, code: err.code,
      // On a second claim the player is told the deadline they actually have,
      // so the screen can correct itself rather than showing a countdown that
      // disagrees with the server.
      ...(err.expiresAt ? { expiresAt: err.expiresAt } : {}),
    });
  }
});

router.post('/order/:orderId/mark-paid', authenticate, orderAccessGuard, async (req, res) => {
  try {
    // The UTR alone. A screenshot proved nothing — it is trivially forged and no
    // approval read it, while the merchant matches the UTR against their own
    // bank statement, which is the only part of this submission the platform
    // can verify.
    const { utrNumber } = req.body;
    if (!utrNumber?.trim()) return res.status(400).json({ success: false, message: 'utrNumber is required' });
    const order = await markOrderPaid(req.user.userId, req.params.orderId, utrNumber);
    res.json({ success: true, message: 'Payment marked. Awaiting merchant review.', order: forPlayer(order) });
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
router.post('/deposit/:orderId/confirm', paymentActorAuth, orderAccessGuard, async (req, res) => {
  const isMerchantActor = Boolean(req.merchantId);
  const isAdminActor = Boolean(req.user?.isAdmin);
  if (!isMerchantActor && !isAdminActor) {
    return res.status(403).json({ success: false, message: 'Only merchants or admins can confirm deposits' });
  }
  try {
    // The guard already refused anyone who is not this order's player, its
    // assigned merchant, or an admin — and it verified the tamper tag. What is
    // left is this route's own rule: it confirms DEPOSITS.
    const order = req.p2pOrder;
    if (order.type !== 'DEPOSIT') {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (!['PAID', 'PROCESSING'].includes(order.status)) {
      // A read, not the gate — the transition below settles the race. This
      // exists so an already-completed order gets a clear answer instead of a
      // 409 the merchant panel renders as a failure.
      if (order.status === 'COMPLETED') {
        return res.json({
          success: true, message: 'Deposit already completed',
          order: isMerchantActor ? toMerchantOrderView(order) : order,
        });
      }
      return res.status(409).json({ success: false, message: `Cannot confirm in ${order.status} status` });
    }

    // The player's pockets are split; the merchant's side is not. `depositCredit.js`
    // owns both the split and the movement — the admin queue override calls the
    // same function, which is the only reason the two can no longer disagree.
    const moved = await moveDepositMoney(order, {
      debitMerchantTokens, creditDeposit, creditReserve, releaseUTR,
    });
    if (!moved.ok) {
      return res.status(400).json({ success: false, message: 'Merchant insufficient token balance' });
    }

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
      order: isMerchantActor ? toMerchantOrderView(settled) : settled,
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
    res.json({
      success: true,
      orders: toPlayerOrderViews(orders),
      pagination: { total, limit: parsedLimit, skip: parsedSkip },
    });
  } catch (err) {
    console.error('GET /payment/orders error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch orders' });
  }
});

/*
 * `ownedOrder` lived here and is now `orderAccessGuard`, mounted as middleware
 * on every `:orderId` route below.
 *
 * The two were doing the same job in two places. The guard also verifies the
 * order's tamper tag, which nothing did: `order_hmac` was written on every
 * order at creation, ORDER_HMAC_SECRET was a required boot variable, and no
 * request path ever read the tag back. The signature was kept and never
 * checked.
 *
 * Handlers below read `req.p2pOrder`, which the guard sets once it has decided.
 * A route added without the guard has no order to read, so it fails loudly
 * rather than silently skipping the check.
 */

router.get('/order/:orderId', authenticate, orderAccessGuard, async (req, res) => {
  try {
    const order = req.p2pOrder;

    // ── The ATM link, for the order's owner and nobody else ────────────────
    // On the cash rail this link IS the payment: the player opens it, pays,
    // and the machine dispenses to the merchant standing there. So it has to
    // reach them — and only them.
    //
    // `orderAccessGuard` has already established that this caller owns the
    // order, which is why the link can be resolved here rather than behind a
    // second ownership check that could disagree with the first.
    //
    // The merchant is NOT named. A player sees where to pay, never who they
    // are paying — the same rule the merchant side obeys in reverse.
    let cashLink = null;
    if (order?.cashLinkId) {
      const link = await db.cashLinks.getLinkForOrder(order.orderId);
      if (link) cashLink = { paymentLink: link.paymentLink, expiresAt: link.expiresAt };
    }

    res.json({ success: true, order: forPlayer(order), cashLink });
  } catch (err) {
    console.error('GET /payment/order/:orderId error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch order' });
  }
});

/**
 * GET /api/payment/order/:orderId/batch — the other parts of one request.
 *
 * A cash withdrawal too large for one denomination becomes several ORDINARY
 * withdrawals, because that is what an ATM dispenses. They are not a parent and
 * its legs — each is a complete withdrawal with its own merchant, its own
 * escrow and its own state — but the player made ONE request, so they need to
 * be told which orders came out of it. Otherwise four unexplained withdrawals
 * appear at the same second and nothing says why.
 *
 * That is all this is: a label lookup for display. Nothing derives state from
 * `withdrawal_batch_ref`, no money reads it, no assignment consults it. If
 * something ever branches on it, it has become the parent relation again
 * wearing a different name.
 *
 * Behind `orderAccessGuard`, so it is the owner asking, and it returns the
 * siblings that belong to THIS caller — a batch ref is not a capability.
 * An ordinary withdrawal answers with an empty list rather than a 404: "this
 * was not split" is a true answer, and a screen forced to tell that apart from
 * "not found" will get it wrong.
 */
router.get('/order/:orderId/batch', authenticate, orderAccessGuard, async (req, res) => {
  try {
    const order = req.p2pOrder;
    const siblings = order?.withdrawalBatchRef
      ? await db.orders.withdrawalBatch(order.withdrawalBatchRef)
      : [];
    res.json({
      success: true,
      batchRef: order?.withdrawalBatchRef ?? null,
      // PARTS, not `orders`: a deliberately narrow display list — id, position,
      // amount, state — and not order-shaped, so nothing here has to be kept in
      // step with the player's order projection.
      parts: siblings
        // Ownership re-checked per row. The guard proved this caller owns the
        // order they named; it did not prove they own everything sharing a
        // label with it, and a label is not an authorisation.
        .filter((o) => String(o.userId) === String(req.user.userId))
        .map((o, index) => ({
          orderId:   o.orderId,
          partIndex: index + 1,
          amount:    o.fiatAmount,
          status:    o.status,
          expiresAt: o.expiresAt,
          // Whether the player can take this one back. Same rule as any other
          // withdrawal, because it IS any other withdrawal.
          cancellable: o.status === 'PENDING_QUEUE',
        })),
    });
  } catch (err) {
    console.error('GET /payment/order/:orderId/batch error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch the other parts of this withdrawal' });
  }
});

/*
 * REMOVED — GET /api/payment/rates.
 *
 * It returned { buyRate: 1, sellRate: 1, merchantProfitPerToken: 0 } as
 * literals: no database read, nothing an operator could change. That made it a
 * THIRD declaration of the 1:1 conversion, beside the config spec's and the
 * system-config payload's tokenBuyRate/tokenSellRate — and the one place where
 * editing the rate would silently have no effect. Its comment said the shape
 * was "kept for client compatibility"; no client was reading it. §1.
 */

router.post('/order/cancel', authenticate, async (req, res) => {
  try {
    await cancelOrder(req.user.userId, req.user.isAdmin, req.body.orderId);
    res.json({ success: true, message: 'Order cancelled' });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message }); }
});

// ─── GET /api/payment/order/:orderId/status — lightweight poll (Section 2B) ──
// Returns only the fields the frontend needs to poll during active payment flow.
router.get('/order/:orderId/status', authenticate, orderAccessGuard, async (req, res) => {
  try {
    const order = req.p2pOrder;

    // The proof screenshot expires. The fallback is 48 hours from creation for
    // an order written before the column existed — an absent expiry must not
    // read as "never expires" on a payment screenshot.
    const proofExpiresAt = order.proofExpiresAt
      || new Date(new Date(order.createdAt).getTime() + 48 * 60 * 60 * 1000);
    const proofVisible = new Date(proofExpiresAt).getTime() > Date.now();

    // The poll used to send `merchantSnapshot` WHOLE — the merchant's handle,
    // their QR and their bank account, every few seconds, on the one response
    // that fires most often. Through the projection like everything else: `payTo`
    // is the payment link and an opaque reference, and nothing about who the
    // merchant is.
    const view = forPlayer(order);
    res.json({
      success: true,
      status:          view.status,
      expiresAt:       view.expiresAt,
      payTo:           view.payTo ?? null,
      utrNumber:       view.utrNumber,
      proofScreenshot: proofVisible ? order.proofScreenshot : null,
    });
  } catch (err) {
    console.error('GET /payment/order/:orderId/status error:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch order status' });
  }
});

// ─── POST /api/payment/order/:orderId/dispute — user raises dispute (Section 2B) ─
// User can dispute DEPOSIT order that is PAID but merchant isn't confirming.
router.post('/order/:orderId/dispute', authenticate, orderAccessGuard, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) return res.status(400).json({ success: false, message: 'reason is required' });

    const order = req.p2pOrder;
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

    res.json({
      success: true,
      message: 'Dispute raised. Admin will review shortly.',
      order: forPlayer(disputed.order ?? order),
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/order/:orderId/status', authenticate, orderAccessGuard, async (req, res) => {
  try {
    const { status, reason = 'User requested dispute' } = req.body;
    if (status !== 'DISPUTED') return res.status(400).json({ success: false, message: 'Only DISPUTED transition is supported here' });
    const order = req.p2pOrder;
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
    res.json({ success: true, order: forPlayer(moved.order ?? order) });
  } catch (err) { res.status(500).json({ success: false, message: 'Failed to update status' }); }
});

export default router;
