// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Merchant (BBEPS Phase 003 §3.3). Owns merchant assignment/reassignment,
// the queue manager merchant pool, and pending-order-for-assignment listing.
// Payment-order lifecycle (approve/reject/cancel/resolve-dispute) moved to
// domains/payment/paymentOrder.routes.js — that's Payment domain territory, not
// Merchant. Split out of the old backend/routes/admin/queue.admin.routes.js on
// 2026-07-01 as part of the Merchant+Payment domain migration (BBEPS Phase 004).
// See backend/domains/README.md.

import { express, mongoose, authenticate, isAdmin, isAdminOrSubAdmin, getModels, isAdminOrSubAdminOrQueueManager } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
import { creditDeposit, creditWinnings } from '../wallet/walletAuthority.service.js';
// The order state machine — the expected state is in the update's filter, so
// two admins assigning the same order produce one winner, not a silent overwrite.
import { assignOrder, reassignOrder } from '../payment/orderLifecycle.service.js';
import { emitAdminUpdate, emitMerchantUpdate, emitOrderUpdate, emitWalletUpdate } from '../notification/realtimeEmitters.js';
// Inventory eligibility is a MONEY read, so it follows the money. The Mongo
// document is a live mirror and stale by at most a reconcile pass; the gates
// below decide whether an order may be handed to a merchant, and a stale answer
// there misroutes it. getMerchantTokenBalance returns the Mongo value while
// Mongo owns the path, so converting a gate is monotonic — strictly more
// correct under either store, never a behaviour change on the current one.
import { getMerchantTokenBalance } from '#db/repositories/merchantWallets.js';
import { getAvailablePaiseFor } from '#db/repositories/merchantWallets.core.js';
import { rupeesToPaise, paiseToRupees } from '../../shared/money.js';
import { getSystemConfig } from '#db/repositories/config.js';

const router = express.Router();

// ─── Helper: build merchantSnapshot from a Merchant doc ──────────────────────
// PRIVACY FIX 2026-07-05: merchantName was merchantDoc.name||merchantDoc.username,
// which in this data is literally the merchant's own mobile number -- every user
// assigned an order could see the merchant's real phone number. Replaced with a
// persisted, non-identifying public reference from Merchant.publicRef.
function merchantDisplayRef(merchantDoc) {
  return `Merchant #${merchantDoc.publicRef}`;
}

function buildSnapshot(merchantDoc, expiresAt) {
  return {
    merchantId:    merchantDoc._id,
    merchantName:  merchantDisplayRef(merchantDoc),
    upiId:         merchantDoc.bankDetails?.upiId              || '',
    bankName:      merchantDoc.bankDetails?.bankName           || '',
    accountNo:     merchantDoc.bankDetails?.accountNo          || '',
    ifsc:          merchantDoc.bankDetails?.ifsc               || '',
    accountHolder: merchantDoc.bankDetails?.accountHolderName  || '',
    snapshotAt:    new Date(),
    expiresAt,
  };
}

// NOTE: GET /payment-queue is intentionally not registered in the Merchant
// domain. The canonical queue listing lives in the Payment domain
// (domains/payment/paymentOrder.routes.js), where it enforces the granular
// canViewTransactions permission. Keeping this route here shadowed the Payment
// route because merchant.assignment.routes.js is mounted first.

// ─── POST /api/admin/payment-orders/:id/assign ───────────────────────────────────
// Dedicated assign endpoint. Creates merchantSnapshot + 10-min timer.
// Spec Section 8 / 16.1 / Finding 5
router.post('/payment-orders/:id/assign', authenticate, isAdmin, async (req, res) => {
  try {
    const { id }         = req.params;
    const { merchantId } = req.body;
    if (!merchantId) return res.status(400).json({ success: false, message: 'merchantId is required' });

    const { PaymentOrder } = getModels();
    const Merchant     = mongoose.model('Merchant');

    const order    = await db.orders.getOrderRecord(id);
    if (!order)    return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'PENDING_QUEUE') {
      return res.status(400).json({ success: false, message: `Order is ${order.status}, cannot assign` });
    }

    const merchant = await db.merchants.getMerchant(merchantId);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    // ── Queue Manager Pool guard: manual assignment is confined to the
    // curated pool (see domains/configuration/systemConfig.model.js queueManagerPool). This keeps
    // manual/forced assignment from competing with merchantScoring.service.js's
    // full ACTIVE merchant set for automatic assignment. ─────────────────────
    const poolConfig_pa   = await getSystemConfig();
    const pool_pa         = (poolConfig_pa?.queueManagerPool || []).map(String);
    if (pool_pa.length === 0) {
      return res.status(400).json({ success: false, message: 'No merchant pool configured. Set one via PUT /api/admin/queue/merchant-pool (any number, 1+) before assigning manually.' });
    }
    if (!pool_pa.includes(String(merchant._id))) {
      return res.status(400).json({ success: false, message: 'This merchant is not in the queue manager pool. Manual assignment is restricted to pooled merchants.' });
    }

    // ── Finding 5: Inventory check before assignment ───────────────────────
    // Read from whichever store owns the merchant wallet, not from the mirror.
    const balance_pa = await getMerchantTokenBalance(merchant._id);
    if (balance_pa < order.tokenAmount) {
      return res.status(400).json({
        success: false,
        message: `Merchant has insufficient inventory (${balance_pa} < ${order.tokenAmount}). Top up merchant inventory first.`,
        merchantBalance: balance_pa,
        required:        order.tokenAmount,
      });
    }

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min (Section 8)

    // ── Snapshot: freeze payment details at assignment time (Section 8.3) ─
    const assigned = await assignOrder(order._id, {
      set: {
        merchantId:       merchant._id,
        merchantSnapshot: buildSnapshot(merchant, expiresAt),
        assignedAt:       new Date(),
        assignedBy:       req.user.userId,
        expiresAt,
      },
    });
    if (!assigned.ok || assigned.idempotent) {
      // The automatic assigner reaches the same queued orders this route does.
      return res.status(409).json({
        success: false,
        message: `Order is ${assigned.status ?? 'missing'}, cannot assign`,
      });
    }
    Object.assign(order, assigned.order);

    // ── SSE notifications (Finding 3) ─────────────────────────────────────
    emitMerchantUpdate(merchant._id.toString(), 'new_order', {
      orderId:     order._id,
      orderStrId:  order.orderId,
      type:        order.type,
      tokenAmount: order.tokenAmount,
      fiatAmount:  order.fiatAmount,
      expiresAt,
      server_ts:   Date.now(),
    });
    emitOrderUpdate(order.userId.toString(), 'order_assigned', {
      orderId:          order.orderId,
      _id:              order._id,
      status:           'ASSIGNED',
      merchantSnapshot: order.merchantSnapshot,   // user reads payment details from snapshot
      expiresAt,
      server_ts:        Date.now(),
    });
    emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'ASSIGNED' });

    res.json({ success: true, message: 'Order assigned with merchant snapshot', order });
  } catch (error) {
    console.error('POST /p2p-orders/:id/assign error:', error);
    res.status(500).json({ success: false, message: 'Failed to assign order' });
  }
});

// ─── POST /api/admin/payment-orders/:id/reassign ─────────────────────────────────
// Reassign to a different merchant. New snapshot, reset timer.
// Spec Section 11.3 / 16.1
router.post('/payment-orders/:id/reassign', authenticate, isAdminOrSubAdminOrQueueManager, async (req, res) => {
  try {
    const { id }         = req.params;
    const { merchantId } = req.body;
    if (!merchantId) return res.status(400).json({ success: false, message: 'merchantId is required' });

    const { PaymentOrder } = getModels();
    const Merchant     = mongoose.model('Merchant');

    const order    = await db.orders.getOrderRecord(id);
    if (!order)    return res.status(404).json({ success: false, message: 'Order not found' });
    if (!['ASSIGNED', 'PROCESSING'].includes(order.status)) {
      return res.status(400).json({ success: false, message: `Order is ${order.status}, cannot reassign` });
    }

    const merchant = await db.merchants.getMerchant(merchantId);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });
    if (merchant.status !== 'ACTIVE') {
      return res.status(400).json({ success: false, message: 'Merchant is not ACTIVE' });
    }

    // ── Queue Manager Pool guard (same rule as /payment-orders/:id/assign) ──
    const poolConfig_pr   = await getSystemConfig();
    const pool_pr         = (poolConfig_pr?.queueManagerPool || []).map(String);
    if (pool_pr.length === 0) {
      return res.status(400).json({ success: false, message: 'No merchant pool configured. Set one via PUT /api/admin/queue/merchant-pool (any number, 1+) before reassigning manually.' });
    }
    if (!pool_pr.includes(String(merchant._id))) {
      return res.status(400).json({ success: false, message: 'This merchant is not in the queue manager pool. Manual reassignment is restricted to pooled merchants.' });
    }

    // ── Finding 5: Inventory check ─────────────────────────────────────────
    const balance_pr = await getMerchantTokenBalance(merchant._id);
    if (balance_pr < order.tokenAmount) {
      return res.status(400).json({
        success: false,
        message: `Merchant has insufficient inventory (${balance_pr} < ${order.tokenAmount}).`,
        merchantBalance: balance_pr,
        required:        order.tokenAmount,
      });
    }

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // An assignee change, not a lifecycle move — see reassignOrder's comment.
    const moved = await reassignOrder(order._id, {
      set: {
        merchantId:       merchant._id,
        merchantSnapshot: buildSnapshot(merchant, expiresAt),   // overwrite old snapshot
        assignedAt:       new Date(),
        assignedBy:       req.user.userId,
        expiresAt,
      },
    });
    if (!moved.ok) {
      return res.status(409).json({ success: false, message: `Order is ${moved.status ?? 'missing'}, cannot reassign` });
    }
    Object.assign(order, moved.order);

    emitMerchantUpdate(merchant._id.toString(), 'new_order', {
      orderId: order._id, orderStrId: order.orderId,
      type: order.type, tokenAmount: order.tokenAmount, fiatAmount: order.fiatAmount,
      expiresAt, server_ts: Date.now(),
    });
    emitOrderUpdate(order.userId.toString(), 'order_assigned', {
      orderId: order.orderId, _id: order._id, status: 'ASSIGNED',
      merchantSnapshot: order.merchantSnapshot, expiresAt, server_ts: Date.now(),
    });
    emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'ASSIGNED' });

    res.json({ success: true, message: 'Order reassigned with new merchant snapshot', order });
  } catch (error) {
    console.error('POST /p2p-orders/:id/reassign error:', error);
    res.status(500).json({ success: false, message: 'Failed to reassign order' });
  }
});


// NOTE: POST /payment-queue/:orderId/assign was REMOVED here (BBEPS Phase 0
// Risk A / SD-002 "Delete Before Rewrite"). It was a byte-for-byte functional
// duplicate of /payment-orders/:id/assign below, with WEAKER validation (no
// PENDING_QUEUE status guard, no merchantApprovalStatus check) and zero
// verified callers in admin-panel or merchant-panel (confirmed via exhaustive
// grep before removal). Keeping it would have meant three parallel manual-
// assign code paths with inconsistent validation — exactly the kind of drift
// BBEPS Phase 0 exists to eliminate. Use /payment-orders/:id/assign or
// /queue/assign/:orderId instead — both are exercised by the live frontend
// and both now enforce the queue manager merchant pool.
// ─── GET /api/admin/queue/available-merchants ─────────────────────────────────
// FIX (Queue Manager Pool redesign): candidates now come from the curated
// queueManagerPool (domains/configuration/systemConfig.model.js), not a full search of every ACTIVE
// merchant. This is what actually stops manual/forced assignment from
// competing with merchantScoring.service.js's full candidate set — the pool
// membership is enforced again server-side in every assign/reassign endpoint
// below, so this filter isn't just cosmetic.
router.get('/queue/available-merchants', authenticate, isAdminOrSubAdminOrQueueManager, async (req, res) => {
  if (!req.user.isQueueManager && !req.user.isAdmin) {
    return res.status(403).json({ success: false, message: 'Queue manager access required' });
  }
  try {
    const { type, orderAmount } = req.query;
    const amount = parseFloat(orderAmount) || 0;
    const Merchant = mongoose.model('Merchant');

    const poolConfig = await getSystemConfig();
    const poolIds = poolConfig?.queueManagerPool || [];

    if (poolIds.length === 0) {
      return res.json({
        success: true,
        merchants: [],
        isPoolConfigured: false,
        message: 'No merchant pool configured yet. Ask an admin to set one via the Queue Manager Pool settings.',
      });
    }

    const merchantFilter = { _id: { $in: poolIds }, status: 'ACTIVE', isOnline: true };
    if (type === 'DEPOSIT')    merchantFilter.acceptsDeposits    = true;
    if (type === 'WITHDRAWAL') merchantFilter.acceptsWithdrawals = true;
    const merchantDocs = await Merchant.find(merchantFilter).lean();
    // The token figure comes from the WALLET, in one batched read, because this
    // list is what a queue manager assigns from — the number they see has to be
    // the number the transfer will find. A merchant with no wallet row reports
    // -1 paise below and is excluded rather than shown as empty: no row means
    // the money system has never seen them.
    const availablePaise = await getAvailablePaiseFor(merchantDocs.map((m) => m._id));
    const merchants = merchantDocs
      .map((m) => ({
        _id:               m._id,
        userId:            m.userId,
        name:              m.name || m.username || '',
        mobile:            m.mobile || '',
        status:            m.status,
        isOnline:          m.isOnline,
        acceptsDeposits:   m.acceptsDeposits   !== false,
        acceptsWithdrawals:m.acceptsWithdrawals !== false,
        tokenBalance:      paiseToRupees(availablePaise.get(String(m._id)) ?? 0),
        // The same figure, under a name that says where it came from: the
        // filter below gates an assignment, and a reader should not have to
        // trace thirty lines back to see that it reads the wallet.
        walletAvailableTokens: availablePaise.has(String(m._id))
          ? paiseToRupees(availablePaise.get(String(m._id)))
          : null,
        merchantStats: {
          monthlyProcessed:     m.merchantStats?.monthlyProcessed     || 0,
          totalOrdersProcessed: m.merchantStats?.totalOrdersProcessed || 0,
        },
        limits: { minOrder: m.minOrder || 0, maxOrder: m.maxOrder || 50000 },
      }))
      .filter(m => {
        if (amount > 0) {
          // Excluded, not merely outranked: a merchant the money system has
          // never seen must not be offered for an assignment. `null` here is
          // "no wallet row", which is a different thing from a zero balance.
          if (m.walletAvailableTokens === null) return false;
          if (m.walletAvailableTokens < amount) return false;  // Finding 5
          if (amount > m.limits.maxOrder)      return false;
          if (m.limits.minOrder > 0 && amount < m.limits.minOrder) return false;
        }
        return true;
      })
      .sort((a, b) => b.walletAvailableTokens - a.walletAvailableTokens);

    res.json({ success: true, merchants, isPoolConfigured: true, poolSize: poolIds.length });
  } catch (error) {
    console.error('Get available merchants error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch available merchants' });
  }
});

// ─── GET /api/admin/queue/merchant-pool ───────────────────────────────────────
// Returns the full curated pool (including offline/ineligible members, unlike
// available-merchants above) so the settings UI can show and edit it.
router.get('/queue/merchant-pool', authenticate, isAdminOrSubAdminOrQueueManager, async (req, res) => {
  try {
    const Merchant = mongoose.model('Merchant');
    const config = await getSystemConfig();
    const poolIds = config?.queueManagerPool || [];

    const merchants = poolIds.length
      ? await Merchant.find({ _id: { $in: poolIds } })
          .select('name username mobile status isOnline acceptsDeposits acceptsWithdrawals tokenBalance merchantStats')
          .lean()
      : [];

    res.json({
      success: true,
      pool: merchants,
      poolSize: merchants.length,
      isConfigured: poolIds.length > 0,
      message: poolIds.length === 0
        ? 'No merchant pool configured yet. Set one with PUT /api/admin/queue/merchant-pool (1 or more merchant IDs).'
        : undefined,
    });
  } catch (error) {
    console.error('Get merchant pool error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch merchant pool' });
  }
});

// ─── PUT /api/admin/queue/merchant-pool ───────────────────────────────────────
// Replaces the whole pool. Body: { merchantIds: string[] } — must be 3-5
// unique, existing, ACTIVE + APPROVED merchant IDs. Same role gate as manual
// assignment itself (admin, sub-admin, or queue_manager) since curating the
// pool is part of the queue manager's job per business direction.
router.put('/queue/merchant-pool', authenticate, isAdminOrSubAdminOrQueueManager, async (req, res) => {
  try {
    const { merchantIds } = req.body;
    if (!Array.isArray(merchantIds) || merchantIds.length < 1) {
      return res.status(400).json({ success: false, message: 'merchantIds must be an array of at least 1 merchant ID.' });
    }
    const uniqueIds = [...new Set(merchantIds.map(String))];
    if (uniqueIds.length !== merchantIds.length) {
      return res.status(400).json({ success: false, message: 'Duplicate merchant IDs in pool.' });
    }

    const Merchant = mongoose.model('Merchant');

    const foundMerchants = await Merchant.find({ _id: { $in: uniqueIds } })
      .select('name username status merchantApprovalStatus').lean();
    if (foundMerchants.length !== uniqueIds.length) {
      return res.status(400).json({ success: false, message: 'One or more merchant IDs do not exist.' });
    }
    const notEligible = foundMerchants.filter(m => m.status !== 'ACTIVE' || m.merchantApprovalStatus !== 'APPROVED');
    if (notEligible.length) {
      return res.status(400).json({
        success: false,
        message: `These merchants are not ACTIVE/APPROVED and cannot be pooled: ${notEligible.map(m => m.name || m.username).join(', ')}`,
      });
    }

    const before = await getSystemConfig();

    // The write, its version bump and its audit row commit TOGETHER. This was
    // `SystemConfig.findOneAndUpdate` — a name deleted with the ODM, so the
    // handler threw after telling the caller its validation had passed.
    await db.config.applySystemConfig(
      { queueManagerPool: uniqueIds },
      { actor: req.user.userId, reason: 'Queue manager pool updated' },
    );

    await db.audit.recordDetailed({
      performedBy: req.user.userId,
      performedByName: req.user.username,
      performedByRole: req.user.isAdmin ? 'admin' : (req.user.isSubAdmin ? 'subadmin' : 'queue_manager'),
      action: 'UPDATE_QUEUE_MANAGER_POOL',
      category: 'MERCHANT',
      details: {
        oldPool: (before?.queueManagerPool || []).map(String),
        newPool: uniqueIds,
        merchantNames: foundMerchants.map(m => m.name || m.username),
      },
      success: true,
    });

    res.json({ success: true, message: `Merchant pool updated (${uniqueIds.length} merchants)`, pool: uniqueIds });
  } catch (error) {
    console.error('Update merchant pool error:', error);
    res.status(500).json({ success: false, message: 'Failed to update merchant pool' });
  }
});

// ─── GET /api/admin/queue/eligible-merchants ──────────────────────────────────
// Lists every ACTIVE + APPROVED merchant as pool-picker candidates (unlike
// available-merchants above, this is NOT filtered to current pool members —
// it's the full candidate list you choose the pool FROM). Deliberately minimal
// fields and scoped to queue_manager's job (unlike /api/admin/merchants, which
// is isAdmin-only and returns broader account data not needed here).
router.get('/queue/eligible-merchants', authenticate, isAdminOrSubAdminOrQueueManager, async (req, res) => {
  try {
    const Merchant = mongoose.model('Merchant');
    const merchantDocs = await Merchant.find({ status: 'ACTIVE', merchantApprovalStatus: 'APPROVED' })
      .select('name username mobile isOnline tokenBalance merchantStats')
      .lean();
    const merchants = merchantDocs.map(m => ({
      _id: m._id,
      name: m.name || m.username || '',
      mobile: m.mobile || '',
      isOnline: m.isOnline || false,
      tokenBalance: m.tokenBalance || 0,
      totalOrdersProcessed: m.merchantStats?.totalOrdersProcessed || 0,
    }));
    res.json({ success: true, merchants });
  } catch (error) {
    console.error('Get eligible merchants error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch eligible merchants' });
  }
});

// ─── GET /api/admin/queue/pending-orders ──────────────────────────────────────
router.get('/queue/pending-orders', authenticate, isAdminOrSubAdminOrQueueManager, async (req, res) => {
  if (!req.user.isQueueManager && !req.user.isAdmin) {
    return res.status(403).json({ success: false, message: 'Queue manager access required' });
  }
  try {
    const PaymentOrder = mongoose.model('PaymentOrder');
    const rawOrders = await PaymentOrder.find({ status: 'PENDING_QUEUE' })
      .populate('userId', 'username mobile kycStatus bankDetails')
      .sort({ createdAt: 1 })
      .limit(50)
      .lean();

    const orders = rawOrders.map((o) => ({
      ...o,
      userName:      o.userId?.username || o.userName || 'Unknown',
      userMobile:    o.userId?.mobile   || o.userMobile || '',
      userKycStatus: o.userId?.kycStatus || 'UNKNOWN',
      userId:        o.userId?._id     || o.userId,
    }));

    res.json({ success: true, orders });
  } catch (error) {
    console.error('Get pending orders error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch pending orders' });
  }
});

// ─── POST /api/admin/queue/assign/:orderId (queue manager) ────────────────────
router.post('/queue/assign/:orderId', authenticate, isAdminOrSubAdminOrQueueManager, async (req, res) => {
  if (!req.user.isQueueManager && !req.user.isAdmin) {
    return res.status(403).json({ success: false, message: 'Queue manager access required' });
  }
  try {
    const { orderId } = req.params;
    const { merchantId } = req.body;
    const PaymentOrder  = mongoose.model('PaymentOrder');
    const Merchant  = mongoose.model('Merchant');

    const order = await db.orders.getOrderRecord(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'PENDING_QUEUE') {
      return res.status(400).json({ success: false, message: `Order status is ${order.status}, cannot assign` });
    }

    const merchantDoc = await db.merchants.getMerchant(merchantId);
    if (!merchantDoc || merchantDoc.merchantApprovalStatus !== 'APPROVED') {
      return res.status(400).json({ success: false, message: 'Invalid or unapproved merchant' });
    }

    // ── Queue Manager Pool guard (same rule as payment-orders assign/reassign) ─
    const poolConfig_qa   = await getSystemConfig();
    const pool_qa         = (poolConfig_qa?.queueManagerPool || []).map(String);
    if (pool_qa.length === 0) {
      return res.status(400).json({ success: false, message: 'No merchant pool configured. Set one via PUT /api/admin/queue/merchant-pool (any number, 1+) before assigning manually.' });
    }
    if (!pool_qa.includes(String(merchantDoc._id))) {
      return res.status(400).json({ success: false, message: 'This merchant is not in the queue manager pool. Manual assignment is restricted to pooled merchants.' });
    }

    // Finding 5: inventory check
    const balance_qa = await getMerchantTokenBalance(merchantDoc._id);
    if (balance_qa < order.tokenAmount) {
      return res.status(400).json({
        success: false,
        message: `Merchant inventory insufficient (${balance_qa} tokens, need ${order.tokenAmount}).`,
      });
    }

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const queueAssigned = await assignOrder(order._id, {
      set: {
        merchantId:       merchantDoc._id,
        merchantSnapshot: buildSnapshot(merchantDoc, expiresAt),
        assignedAt:       new Date(),
        assignedBy:       req.user.userId,
        expiresAt,
      },
    });
    if (!queueAssigned.ok || queueAssigned.idempotent) {
      return res.status(409).json({
        success: false,
        message: `Order status is ${queueAssigned.status ?? 'missing'}, cannot assign`,
      });
    }
    Object.assign(order, queueAssigned.order);

    if (!merchantDoc.merchantStats) merchantDoc.merchantStats = {};
    merchantDoc.merchantStats.totalOrdersProcessed = (merchantDoc.merchantStats.totalOrdersProcessed || 0) + 1;
    await merchantDoc.save();

    emitMerchantUpdate(merchantDoc._id.toString(), 'new_order', {
      orderId: order._id, orderStrId: order.orderId,
      type: order.type, tokenAmount: order.tokenAmount, fiatAmount: order.fiatAmount,
      expiresAt, server_ts: Date.now(),
    });
    emitOrderUpdate(order.userId.toString(), 'order_assigned', {
      orderId: order.orderId, _id: order._id, status: 'ASSIGNED',
      merchantSnapshot: order.merchantSnapshot, expiresAt, server_ts: Date.now(),
    });
    emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'ASSIGNED' });

    res.json({
      success: true,
      message: 'Order assigned successfully',
      order: await db.orders.getOrderRecord(orderId)
        .populate('merchantId', 'username mobile'),
    });
  } catch (error) {
    console.error('Assign order error:', error);
    res.status(500).json({ success: false, message: 'Failed to assign order' });
  }
});

// ─── PUT /api/admin/merchants/:merchantId/scoring — admin sets maxConcurrentOrders ──
router.put('/merchants/:merchantId/scoring', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { maxConcurrentOrders, maxConcurrentDepositOrders, maxConcurrentWithdrawalOrders } = req.body;
    for (const [key, value] of Object.entries({ maxConcurrentOrders, maxConcurrentDepositOrders, maxConcurrentWithdrawalOrders })) {
      if (value === undefined || value === null || value === '') continue;
      const val = Number(value);
      if (isNaN(val) || val < 1 || val > 10) return res.status(400).json({ success: false, message: `${key} must be 1–10` });
    }
    const Merchant = mongoose.model('Merchant');
    const update = {};
    if (maxConcurrentOrders !== undefined) update.maxConcurrentOrders = Number(maxConcurrentOrders);
    if (maxConcurrentDepositOrders !== undefined) update.maxConcurrentDepositOrders = Number(maxConcurrentDepositOrders);
    if (maxConcurrentWithdrawalOrders !== undefined) update.maxConcurrentWithdrawalOrders = Number(maxConcurrentWithdrawalOrders);

    const merchant = await Merchant.findByIdAndUpdate(
      req.params.merchantId, { $set: update }, { new: true }
    );
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    res.json({ success: true, merchant });
  } catch (error) {
    console.error('PUT /admin/merchants/:merchantId/scoring error:', error);
    res.status(500).json({ success: false, message: 'Failed to update merchant scoring settings' });
  }
});

export default router;
