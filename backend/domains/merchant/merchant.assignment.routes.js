// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Domain: Merchant (BBEPS Phase 003 §3.3). Owns merchant assignment/reassignment,
// the queue manager merchant pool, and pending-order-for-assignment listing.
// Payment-order lifecycle (approve/reject/cancel/resolve-dispute) moved to
// domains/payment/paymentOrder.routes.js — that's Payment domain territory, not
// Merchant. Split out of the old backend/routes/admin/queue.admin.routes.js on
// 2026-07-01 as part of the Merchant+Payment domain migration (BBEPS Phase 004).
// See backend/domains/README.md.

import { express, mongoose, authenticate, isAdmin, isAdminOrSubAdmin, getModels, isAdminOrSubAdminOrQueueManager } from '../../routes/admin/_adminShared.js';
import { creditDeposit, creditWinnings } from '../wallet/walletAuthority.service.js';
import { emitAdminUpdate, emitMerchantUpdate, emitOrderUpdate, emitWalletUpdate } from '../notification/realtimeEmitters.js';

const router = express.Router();

// ─── Helper: build merchantSnapshot from a Merchant doc ──────────────────────
// PRIVACY FIX 2026-07-05: merchantName was merchantDoc.name||merchantDoc.username,
// which in this data is literally the merchant's own mobile number -- every user
// assigned an order could see the merchant's real phone number. Replaced with a
// short, non-identifying reference derived from the merchant's _id.
function merchantDisplayRef(merchantDoc) {
  return `Merchant #${String(merchantDoc._id).slice(-4).toUpperCase()}`;
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

// ─── GET /api/admin/payment-queue ─────────────────────────────────────────────────
router.get('/payment-queue', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const { PaymentOrder } = getModels();
    const query = {};
    if (status && status !== 'all') query.status = status;
    const orders = await PaymentOrder.find(query)
      .populate('userId',     'username mobile kycStatus')
      .populate('merchantId', 'username mobile')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();
    const grouped = {
      pending:    orders.filter(o => o.status === 'PENDING_QUEUE'),
      assigned:   orders.filter(o => o.status === 'ASSIGNED'),
      processing: orders.filter(o => o.status === 'PROCESSING'),
      paid:       orders.filter(o => o.status === 'PAID'),
      disputed:   orders.filter(o => o.status === 'DISPUTED'),
      completed:  orders.filter(o => o.status === 'COMPLETED'),
    };
    res.json({
      success: true, orders, grouped,
      stats: {
        pending:    grouped.pending.length,
        assigned:   grouped.assigned.length,
        processing: grouped.processing.length,
        paid:       grouped.paid.length,
        disputed:   grouped.disputed.length,
        completed:  grouped.completed.length,
        total:      orders.length,
      },
    });
  } catch (error) {
    console.error('GET /payment-queue error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch Payment queue' });
  }
});

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

    const order    = await PaymentOrder.findById(id);
    if (!order)    return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'PENDING_QUEUE') {
      return res.status(400).json({ success: false, message: `Order is ${order.status}, cannot assign` });
    }

    const merchant = await Merchant.findById(merchantId);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    // ── Queue Manager Pool guard: manual assignment is confined to the
    // curated pool (see domains/configuration/systemConfig.model.js queueManagerPool). This keeps
    // manual/forced assignment from competing with merchantScoring.service.js's
    // full ACTIVE merchant set for automatic assignment. ─────────────────────
    const SystemConfig_pa = mongoose.model('SystemConfig');
    const poolConfig_pa   = await SystemConfig_pa.findOne({ key: 'main' }).lean();
    const pool_pa         = (poolConfig_pa?.queueManagerPool || []).map(String);
    if (pool_pa.length === 0) {
      return res.status(400).json({ success: false, message: 'No merchant pool configured. Set one via PUT /api/admin/queue/merchant-pool (any number, 1+) before assigning manually.' });
    }
    if (!pool_pa.includes(String(merchant._id))) {
      return res.status(400).json({ success: false, message: 'This merchant is not in the queue manager pool. Manual assignment is restricted to pooled merchants.' });
    }

    // ── Finding 5: Inventory check before assignment ───────────────────────
    if (merchant.tokenBalance < order.tokenAmount) {
      return res.status(400).json({
        success: false,
        message: `Merchant has insufficient inventory (${merchant.tokenBalance} < ${order.tokenAmount}). Top up merchant inventory first.`,
        merchantBalance: merchant.tokenBalance,
        required:        order.tokenAmount,
      });
    }

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min (Section 8)

    // ── Snapshot: freeze payment details at assignment time (Section 8.3) ─
    order.merchantId       = merchant._id;
    order.merchantSnapshot = buildSnapshot(merchant, expiresAt);
    order.status           = 'ASSIGNED';
    order.assignedAt       = new Date();
    order.assignedBy       = req.user._id;
    order.expiresAt        = expiresAt;
    await order.save();

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

    const order    = await PaymentOrder.findById(id);
    if (!order)    return res.status(404).json({ success: false, message: 'Order not found' });
    if (!['ASSIGNED', 'PROCESSING'].includes(order.status)) {
      return res.status(400).json({ success: false, message: `Order is ${order.status}, cannot reassign` });
    }

    const merchant = await Merchant.findById(merchantId);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });
    if (merchant.status !== 'ACTIVE') {
      return res.status(400).json({ success: false, message: 'Merchant is not ACTIVE' });
    }

    // ── Queue Manager Pool guard (same rule as /payment-orders/:id/assign) ──
    const SystemConfig_pr = mongoose.model('SystemConfig');
    const poolConfig_pr   = await SystemConfig_pr.findOne({ key: 'main' }).lean();
    const pool_pr         = (poolConfig_pr?.queueManagerPool || []).map(String);
    if (pool_pr.length === 0) {
      return res.status(400).json({ success: false, message: 'No merchant pool configured. Set one via PUT /api/admin/queue/merchant-pool (any number, 1+) before reassigning manually.' });
    }
    if (!pool_pr.includes(String(merchant._id))) {
      return res.status(400).json({ success: false, message: 'This merchant is not in the queue manager pool. Manual reassignment is restricted to pooled merchants.' });
    }

    // ── Finding 5: Inventory check ─────────────────────────────────────────
    if (merchant.tokenBalance < order.tokenAmount) {
      return res.status(400).json({
        success: false,
        message: `Merchant has insufficient inventory (${merchant.tokenBalance} < ${order.tokenAmount}).`,
        merchantBalance: merchant.tokenBalance,
        required:        order.tokenAmount,
      });
    }

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    order.merchantId       = merchant._id;
    order.merchantSnapshot = buildSnapshot(merchant, expiresAt);   // overwrite old snapshot
    order.status           = 'ASSIGNED';
    order.assignedAt       = new Date();
    order.assignedBy       = req.user._id;
    order.expiresAt        = expiresAt;
    await order.save();

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
    const SystemConfig = mongoose.model('SystemConfig');

    const poolConfig = await SystemConfig.findOne({ key: 'main' }).lean();
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
        tokenBalance:      m.tokenBalance || 0,
        merchantStats: {
          monthlyProcessed:     m.merchantStats?.monthlyProcessed     || 0,
          totalOrdersProcessed: m.merchantStats?.totalOrdersProcessed || 0,
        },
        limits: { minOrder: m.minOrder || 0, maxOrder: m.maxOrder || 50000 },
      }))
      .filter(m => {
        if (amount > 0) {
          if (m.tokenBalance < amount)         return false;  // Finding 5
          if (amount > m.limits.maxOrder)      return false;
          if (m.limits.minOrder > 0 && amount < m.limits.minOrder) return false;
        }
        return true;
      })
      .sort((a, b) => b.tokenBalance - a.tokenBalance);

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
    const SystemConfig = mongoose.model('SystemConfig');
    const Merchant = mongoose.model('Merchant');
    const config = await SystemConfig.findOne({ key: 'main' }).lean();
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

    const SystemConfig = mongoose.model('SystemConfig');
    const Merchant = mongoose.model('Merchant');
    const EnhancedAuditLog = mongoose.model('EnhancedAuditLog');

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

    const before = await SystemConfig.findOne({ key: 'main' }).lean();

    await SystemConfig.findOneAndUpdate(
      { key: 'main' },
      { $set: { queueManagerPool: uniqueIds, updatedAt: new Date(), updatedBy: req.user._id } },
      { upsert: true, new: true }
    );

    await EnhancedAuditLog.create({
      performedBy: req.user._id,
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

    const order = await PaymentOrder.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'PENDING_QUEUE') {
      return res.status(400).json({ success: false, message: `Order status is ${order.status}, cannot assign` });
    }

    const merchantDoc = await Merchant.findById(merchantId);
    if (!merchantDoc || merchantDoc.merchantApprovalStatus !== 'APPROVED') {
      return res.status(400).json({ success: false, message: 'Invalid or unapproved merchant' });
    }

    // ── Queue Manager Pool guard (same rule as payment-orders assign/reassign) ─
    const SystemConfig_qa = mongoose.model('SystemConfig');
    const poolConfig_qa   = await SystemConfig_qa.findOne({ key: 'main' }).lean();
    const pool_qa         = (poolConfig_qa?.queueManagerPool || []).map(String);
    if (pool_qa.length === 0) {
      return res.status(400).json({ success: false, message: 'No merchant pool configured. Set one via PUT /api/admin/queue/merchant-pool (any number, 1+) before assigning manually.' });
    }
    if (!pool_qa.includes(String(merchantDoc._id))) {
      return res.status(400).json({ success: false, message: 'This merchant is not in the queue manager pool. Manual assignment is restricted to pooled merchants.' });
    }

    // Finding 5: inventory check
    if (merchantDoc.tokenBalance < order.tokenAmount) {
      return res.status(400).json({
        success: false,
        message: `Merchant inventory insufficient (${merchantDoc.tokenBalance} tokens, need ${order.tokenAmount}).`,
      });
    }

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    order.merchantId       = merchantDoc._id;
    order.merchantSnapshot = buildSnapshot(merchantDoc, expiresAt);
    order.status           = 'ASSIGNED';
    order.assignedAt       = new Date();
    order.assignedBy       = req.user._id;
    order.expiresAt        = expiresAt;
    await order.save();

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
      order: await PaymentOrder.findById(orderId)
        .populate('userId', 'username mobile')
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
    const { maxConcurrentOrders } = req.body;
    if (maxConcurrentOrders !== undefined) {
      const val = Number(maxConcurrentOrders);
      if (isNaN(val) || val < 1 || val > 10)
        return res.status(400).json({ success: false, message: 'maxConcurrentOrders must be 1–10' });
    }

    const Merchant = mongoose.model('Merchant');
    const update = {};
    if (maxConcurrentOrders !== undefined) update.maxConcurrentOrders = Number(maxConcurrentOrders);

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
