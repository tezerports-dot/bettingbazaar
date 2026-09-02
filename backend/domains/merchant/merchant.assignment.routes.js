// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/merchant/merchant.assignment.routes.js — who gets handed a player's
 * money.
 *
 * Owns manual assignment and reassignment, the queue-manager merchant pool, and
 * the pending-order worklist. Payment-order lifecycle (approve / reject /
 * cancel / resolve-dispute) is Payment domain territory and lives in
 * domains/payment/paymentOrder.routes.js.
 *
 * ── Every eligibility gate here decides with money ──────────────────────────
 * An assignment hands a merchant an order they must fund. The inventory check
 * therefore reads `merchant_wallets` — the rows a transfer will actually lock —
 * never a copy of the figure held anywhere else. A merchant with NO wallet row
 * is excluded rather than shown as empty: no row means the money system has
 * never seen them, which is a different thing from a zero balance.
 *
 * ── Three assign paths, one rule ────────────────────────────────────────────
 * Manual assignment is confined to the curated `queueManagerPool` so it cannot
 * compete with the automatic assigner's full candidate set. That rule is
 * enforced server-side in every assign and reassign endpoint here, not just in
 * the list the picker renders.
 */
import { express, authenticate, isAdmin, isAdminOrSubAdmin, isAdminOrSubAdminOrQueueManager } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
// The order state machine — the expected state is in the update's filter, so
// two admins assigning the same order produce one winner, not a silent overwrite.
import { assignOrder, reassignOrder } from '../payment/orderLifecycle.service.js';
import { emitAdminUpdate, emitMerchantUpdate, emitOrderUpdate } from '../notification/realtimeEmitters.js';
// Inventory eligibility is a MONEY read, so it reads the wallet.
import { getMerchantTokenBalance } from '#db/repositories/merchantWallets.js';
import { getAvailablePaiseFor } from '#db/repositories/merchantWallets.core.js';
import { paiseToRupees } from '../../shared/money.js';
import { getSystemConfig } from '#db/repositories/config.js';

const router = express.Router();

// ─── Helper: build merchantSnapshot from a merchant row ──────────────────────
// PRIVACY FIX 2026-07-05: merchantName was `name || username`, which in this
// data is literally the merchant's own mobile number — every user assigned an
// order could see the merchant's real phone number. Replaced with a persisted,
// non-identifying public reference.
function merchantDisplayRef(merchant) {
  return `Merchant #${merchant.publicRef}`;
}

function buildSnapshot(merchant, expiresAt) {
  return {
    merchantId:    merchant.merchantId,
    merchantName:  merchantDisplayRef(merchant),
    upiId:         merchant.bankDetails?.upiId              || '',
    bankName:      merchant.bankDetails?.bankName           || '',
    accountNo:     merchant.bankDetails?.accountNo          || '',
    ifsc:          merchant.bankDetails?.ifsc               || '',
    accountHolder: merchant.bankDetails?.accountHolderName  || '',
    usdtAddress:   merchant.usdtWalletAddress               || '',
    snapshotAt:    new Date(),
    expiresAt,
  };
}

/**
 * The manual-assignment pool guard, in one place.
 *
 * It was copy-pasted into three handlers with three different local variable
 * names. Three copies of a rule is three chances for one of them to drift, and
 * the rule decides which merchant is handed a player's deposit.
 *
 * Returns null when the merchant may be assigned to, or a `{status, message}`
 * the caller sends back unchanged.
 */
async function poolRefusal(merchantId, action = 'assigning') {
  const config = await getSystemConfig();
  const pool = (config?.queueManagerPool || []).map(String);
  if (pool.length === 0) {
    return {
      status: 400,
      message: `No merchant pool configured. Set one via PUT /api/admin/queue/merchant-pool (any number, 1+) before ${action} manually.`,
    };
  }
  if (!pool.includes(String(merchantId))) {
    return {
      status: 400,
      message: `This merchant is not in the queue manager pool. Manual ${action === 'reassigning' ? 'reassignment' : 'assignment'} is restricted to pooled merchants.`,
    };
  }
  return null;
}

/**
 * The inventory guard, from the wallet.
 *
 * Returns null when the merchant can fund the order. This is a DECISION read:
 * a merchant handed an order they cannot fund leaves a player waiting for a
 * payment that will never arrive.
 */
async function inventoryRefusal(merchantId, tokenAmount) {
  const balance = await getMerchantTokenBalance(merchantId);
  if (balance >= tokenAmount) return null;
  return {
    status: 400,
    message: `Merchant has insufficient inventory (${balance} < ${tokenAmount}). Top up merchant inventory first.`,
    merchantBalance: balance,
    required: tokenAmount,
  };
}

/** The order-assigned fan-out, identical across all three assign paths. */
function announceAssignment(order, merchant, expiresAt) {
  emitMerchantUpdate(String(merchant.merchantId), 'new_order', {
    orderId:     order.orderId,
    orderStrId:  order.orderId,
    type:        order.type,
    tokenAmount: order.tokenAmount,
    fiatAmount:  order.fiatAmount,
    expiresAt,
    server_ts:   Date.now(),
  });
  emitOrderUpdate(String(order.userId), 'order_assigned', {
    orderId:          order.orderId,
    _id:              order.orderId,
    status:           'ASSIGNED',
    merchantSnapshot: order.merchantSnapshot,  // user reads payment details from snapshot
    expiresAt,
    server_ts:        Date.now(),
  });
  emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'ASSIGNED' });
}

/** The manual-assignment window (Section 8). */
const ASSIGN_WINDOW_MS = 10 * 60 * 1000;

// NOTE: GET /payment-queue is intentionally not registered in the Merchant
// domain. The canonical queue listing lives in the Payment domain
// (domains/payment/paymentOrder.routes.js), where it enforces the granular
// canViewTransactions permission. Keeping this route here shadowed the Payment
// route because merchant.assignment.routes.js is mounted first.

// ─── POST /api/admin/payment-orders/:id/assign ───────────────────────────────
// Dedicated assign endpoint. Creates merchantSnapshot + 10-min timer.
// Spec Section 8 / 16.1 / Finding 5
router.post('/payment-orders/:id/assign', authenticate, isAdmin, async (req, res) => {
  try {
    const { merchantId } = req.body || {};
    if (!merchantId) return res.status(400).json({ success: false, message: 'merchantId is required' });

    const order = await db.orders.getOrderRecord(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'PENDING_QUEUE') {
      return res.status(400).json({ success: false, message: `Order is ${order.status}, cannot assign` });
    }

    const merchant = await db.merchants.getMerchant(merchantId);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    const pooled = await poolRefusal(merchant.merchantId, 'assigning');
    if (pooled) return res.status(pooled.status).json({ success: false, ...pooled });

    const funded = await inventoryRefusal(merchant.merchantId, order.tokenAmount);
    if (funded) return res.status(funded.status).json({ success: false, ...funded });

    const expiresAt = new Date(Date.now() + ASSIGN_WINDOW_MS);

    // The transition is the gate: the expected state is in the UPDATE's WHERE,
    // so this route and the automatic assigner reaching the same queued order
    // produce one winner rather than a silent overwrite.
    const assigned = await assignOrder(order.orderId, {
      set: {
        merchantId:       merchant.merchantId,
        merchantSnapshot: buildSnapshot(merchant, expiresAt),
        assignedAt:       new Date(),
        assignedBy:       req.user.userId,
        expiresAt,
      },
    });
    if (!assigned.ok || assigned.idempotent) {
      return res.status(409).json({
        success: false,
        message: `Order is ${assigned.status ?? 'missing'}, cannot assign`,
      });
    }
    Object.assign(order, assigned.order);

    announceAssignment(order, merchant, expiresAt);
    res.json({ success: true, message: 'Order assigned with merchant snapshot', order });
  } catch (error) {
    console.error('POST /payment-orders/:id/assign error:', error);
    res.status(500).json({ success: false, message: 'Failed to assign order' });
  }
});

// ─── POST /api/admin/payment-orders/:id/reassign ─────────────────────────────
// Reassign to a different merchant. New snapshot, reset timer.
// Spec Section 11.3 / 16.1
router.post('/payment-orders/:id/reassign', authenticate, isAdminOrSubAdminOrQueueManager, async (req, res) => {
  try {
    const { merchantId } = req.body || {};
    if (!merchantId) return res.status(400).json({ success: false, message: 'merchantId is required' });

    const order = await db.orders.getOrderRecord(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (!['ASSIGNED', 'PROCESSING'].includes(order.status)) {
      return res.status(400).json({ success: false, message: `Order is ${order.status}, cannot reassign` });
    }

    const merchant = await db.merchants.getMerchant(merchantId);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });
    if (merchant.status !== 'ACTIVE') {
      return res.status(400).json({ success: false, message: 'Merchant is not ACTIVE' });
    }

    const pooled = await poolRefusal(merchant.merchantId, 'reassigning');
    if (pooled) return res.status(pooled.status).json({ success: false, ...pooled });

    const funded = await inventoryRefusal(merchant.merchantId, order.tokenAmount);
    if (funded) return res.status(funded.status).json({ success: false, ...funded });

    const expiresAt = new Date(Date.now() + ASSIGN_WINDOW_MS);

    // An assignee change, not a lifecycle move — the order stays ASSIGNED.
    const moved = await reassignOrder(order.orderId, {
      set: {
        merchantId:       merchant.merchantId,
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

    announceAssignment(order, merchant, expiresAt);
    res.json({ success: true, message: 'Order reassigned with new merchant snapshot', order });
  } catch (error) {
    console.error('POST /payment-orders/:id/reassign error:', error);
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
// Pool members a queue manager may assign to RIGHT NOW. Candidates come from
// the curated queueManagerPool, not a full search of every ACTIVE merchant —
// which is what stops manual assignment competing with the automatic
// assigner's candidate set. Pool membership is re-enforced server-side in every
// assign endpoint above, so this filter is not merely cosmetic.
router.get('/queue/available-merchants', authenticate, isAdminOrSubAdminOrQueueManager, async (req, res) => {
  if (!req.user.isQueueManager && !req.user.isAdmin) {
    return res.status(403).json({ success: false, message: 'Queue manager access required' });
  }
  try {
    const { type, orderAmount } = req.query;
    const amount = parseFloat(orderAmount) || 0;

    const config = await getSystemConfig();
    const poolIds = config?.queueManagerPool || [];
    if (poolIds.length === 0) {
      return res.json({
        success: true,
        merchants: [],
        isPoolConfigured: false,
        message: 'No merchant pool configured yet. Ask an admin to set one via the Queue Manager Pool settings.',
      });
    }

    // Approved, active, online and accepting this direction — decided by the
    // row, in one query, rather than by four `!== false` checks over a wider
    // set fetched first.
    const merchants = await db.merchants.getAssignablePoolMerchants(poolIds, { direction: type });

    // The token figure comes from the WALLET, in one batched read, because this
    // list is what a queue manager assigns from — the number they see has to be
    // the number the transfer will find.
    const availablePaise = await getAvailablePaiseFor(merchants.map((m) => m.merchantId));

    const rows = merchants
      .map((m) => ({
        _id:                m.merchantId,
        userId:             m.userId,
        name:               m.name || m.username || '',
        mobile:             m.mobile || '',
        status:             m.status,
        isOnline:           m.isOnline,
        acceptsDeposits:    m.acceptsDeposits,
        acceptsWithdrawals: m.acceptsWithdrawals,
        // The same figure twice, the second under a name that says where it
        // came from: the filter below gates an assignment, and a reader should
        // not have to trace back to see that it reads the wallet.
        tokenBalance: paiseToRupees(availablePaise.get(String(m.merchantId)) ?? 0),
        walletAvailableTokens: availablePaise.has(String(m.merchantId))
          ? paiseToRupees(availablePaise.get(String(m.merchantId)))
          : null,
        merchantStats: {
          monthlyProcessed:     m.merchantStats?.monthlyProcessed     || 0,
          totalOrdersProcessed: m.merchantStats?.totalOrdersProcessed || 0,
        },
        limits: { minOrder: m.minOrder || 0, maxOrder: m.maxOrder || 50000 },
      }))
      .filter((m) => {
        if (amount <= 0) return true;
        // Excluded, not merely outranked: a merchant the money system has never
        // seen must not be offered for an assignment. `null` here is "no wallet
        // row", which is a different thing from a zero balance.
        if (m.walletAvailableTokens === null) return false;
        if (m.walletAvailableTokens < amount) return false;
        if (amount > m.limits.maxOrder) return false;
        if (m.limits.minOrder > 0 && amount < m.limits.minOrder) return false;
        return true;
      })
      .sort((a, b) => b.walletAvailableTokens - a.walletAvailableTokens);

    res.json({ success: true, merchants: rows, isPoolConfigured: true, poolSize: poolIds.length });
  } catch (error) {
    console.error('GET /queue/available-merchants error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch available merchants' });
  }
});

// ─── GET /api/admin/queue/merchant-pool ───────────────────────────────────────
// The full curated pool — including offline and currently-ineligible members,
// unlike available-merchants above — so the settings UI can show and edit it.
router.get('/queue/merchant-pool', authenticate, isAdminOrSubAdminOrQueueManager, async (req, res) => {
  try {
    const config = await getSystemConfig();
    const poolIds = config?.queueManagerPool || [];
    const merchants = await db.merchants.getPoolMerchants(poolIds);

    // Balances from the wallet, so the settings screen and the assignment
    // screen quote the same number. They read from different places once, and
    // an admin curating the pool saw a figure no transfer would have found.
    const availablePaise = await getAvailablePaiseFor(merchants.map((m) => m.merchantId));

    res.json({
      success: true,
      pool: merchants.map((m) => ({
        _id: m.merchantId,
        name: m.name || m.username || '',
        username: m.username,
        mobile: m.mobile,
        status: m.status,
        isOnline: m.isOnline,
        acceptsDeposits: m.acceptsDeposits,
        acceptsWithdrawals: m.acceptsWithdrawals,
        tokenBalance: paiseToRupees(availablePaise.get(String(m.merchantId)) ?? 0),
        totalOrdersProcessed: m.merchantStats?.totalOrdersProcessed || 0,
      })),
      poolSize: merchants.length,
      // A pooled merchant deleted since is reported, not silently dropped: the
      // settings list would otherwise shrink with no explanation.
      missing: poolIds.length - merchants.length,
      isConfigured: poolIds.length > 0,
      message: poolIds.length === 0
        ? 'No merchant pool configured yet. Set one with PUT /api/admin/queue/merchant-pool (1 or more merchant IDs).'
        : undefined,
    });
  } catch (error) {
    console.error('GET /queue/merchant-pool error:', error);
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

    const foundMerchants = await db.merchants.getPoolMerchants(uniqueIds);
    if (foundMerchants.length !== uniqueIds.length) {
      // Name the ones that are missing. "One or more IDs do not exist" sends an
      // admin to compare two lists by hand.
      const found = new Set(foundMerchants.map((m) => String(m.merchantId)));
      return res.status(400).json({
        success: false,
        message: `These merchant IDs do not exist: ${uniqueIds.filter((id) => !found.has(id)).join(', ')}`,
      });
    }
    const notEligible = foundMerchants.filter(
      (m) => m.status !== 'ACTIVE' || m.merchantApprovalStatus !== 'APPROVED',
    );
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
    const merchants = await db.merchants.listPoolCandidates();
    // The balance comes from the WALLET here too. It read a stored
    // `tokenBalance` field, so an admin curating the pool was shown a figure
    // that no transfer would have found — and picked their pool from it.
    const availablePaise = await getAvailablePaiseFor(merchants.map((m) => m.merchantId));

    res.json({
      success: true,
      merchants: merchants.map((m) => ({
        _id: m.merchantId,
        name: m.name || m.username || '',
        mobile: m.mobile || '',
        isOnline: m.isOnline || false,
        tokenBalance: paiseToRupees(availablePaise.get(String(m.merchantId)) ?? 0),
        totalOrdersProcessed: m.merchantStats?.totalOrdersProcessed || 0,
      })),
    });
  } catch (error) {
    console.error('GET /queue/eligible-merchants error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch eligible merchants' });
  }
});

// ─── GET /api/admin/queue/pending-orders ──────────────────────────────────────
router.get('/queue/pending-orders', authenticate, isAdminOrSubAdminOrQueueManager, async (req, res) => {
  if (!req.user.isQueueManager && !req.user.isAdmin) {
    return res.status(403).json({ success: false, message: 'Queue manager access required' });
  }
  try {
    // One query with the player joined, not a populate per page. A player who
    // has since been deleted comes back with null columns rather than a `null`
    // reference the mapper turned into the string 'Unknown' — a closed account
    // and a data problem looked identical.
    const orders = await db.orders.queuePendingOrders({ limit: 50 });
    res.json({
      success: true,
      orders: orders.map((o) => ({
        ...o,
        userName:      o.userName ?? 'Deleted account',
        userMobile:    o.userMobile ?? '',
        userKycStatus: o.userKycStatus ?? 'UNKNOWN',
      })),
    });
  } catch (error) {
    console.error('GET /queue/pending-orders error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch pending orders' });
  }
});

// ─── POST /api/admin/queue/assign/:orderId (queue manager) ────────────────────
router.post('/queue/assign/:orderId', authenticate, isAdminOrSubAdminOrQueueManager, async (req, res) => {
  if (!req.user.isQueueManager && !req.user.isAdmin) {
    return res.status(403).json({ success: false, message: 'Queue manager access required' });
  }
  try {
    const { merchantId } = req.body || {};
    if (!merchantId) return res.status(400).json({ success: false, message: 'merchantId is required' });

    const order = await db.orders.getOrderRecord(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.status !== 'PENDING_QUEUE') {
      return res.status(400).json({ success: false, message: `Order status is ${order.status}, cannot assign` });
    }

    const merchant = await db.merchants.getMerchant(merchantId);
    if (!merchant || merchant.merchantApprovalStatus !== 'APPROVED') {
      return res.status(400).json({ success: false, message: 'Invalid or unapproved merchant' });
    }

    const pooled = await poolRefusal(merchant.merchantId, 'assigning');
    if (pooled) return res.status(pooled.status).json({ success: false, ...pooled });

    const funded = await inventoryRefusal(merchant.merchantId, order.tokenAmount);
    if (funded) return res.status(funded.status).json({ success: false, ...funded });

    const expiresAt = new Date(Date.now() + ASSIGN_WINDOW_MS);

    const assigned = await assignOrder(order.orderId, {
      set: {
        merchantId:       merchant.merchantId,
        merchantSnapshot: buildSnapshot(merchant, expiresAt),
        assignedAt:       new Date(),
        assignedBy:       req.user.userId,
        expiresAt,
      },
    });
    if (!assigned.ok || assigned.idempotent) {
      return res.status(409).json({
        success: false,
        message: `Order status is ${assigned.status ?? 'missing'}, cannot assign`,
      });
    }
    Object.assign(order, assigned.order);

    // No `totalOrdersProcessed` increment here. Two things were wrong with it:
    // it counted an order as PROCESSED at the moment it was handed out, which
    // is not what the word means and inflated every merchant's throughput; and
    // it did it by calling `.save()` on a plain object, so the handler threw a
    // TypeError AFTER the order had already been assigned — the assignment
    // stuck and the queue manager saw a 500. The counter moves when the order
    // completes, in `recordCompletedOrder`, in one statement.

    announceAssignment(order, merchant, expiresAt);

    res.json({
      success: true,
      message: 'Order assigned successfully',
      // Re-read, so the response describes the row that exists. This called
      // `.populate()` on the returned promise — another TypeError, on the line
      // that was meant to enrich the response.
      order: await db.orders.getOrderRecord(order.orderId),
      merchant: { _id: merchant.merchantId, ref: merchantDisplayRef(merchant) },
    });
  } catch (error) {
    console.error('POST /queue/assign/:orderId error:', error);
    res.status(500).json({ success: false, message: 'Failed to assign order' });
  }
});

// ─── PUT /api/admin/merchants/:merchantId/scoring — admin sets maxConcurrentOrders ──
router.put('/merchants/:merchantId/scoring', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { maxConcurrentOrders, maxConcurrentDepositOrders, maxConcurrentWithdrawalOrders } = req.body || {};
    const patch = {};
    for (const [key, value] of Object.entries({
      maxConcurrentOrders, maxConcurrentDepositOrders, maxConcurrentWithdrawalOrders,
    })) {
      if (value === undefined || value === null || value === '') continue;
      const val = Number(value);
      if (!Number.isInteger(val) || val < 1 || val > 10) {
        return res.status(400).json({ success: false, message: `${key} must be a whole number 1–10` });
      }
      patch[key] = val;
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ success: false, message: 'Nothing to update.' });
    }

    const merchant = await db.merchants.updateMerchant(req.params.merchantId, patch);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    // These caps decide how many orders a merchant may hold at once, so a
    // change to them is an operational decision worth a record.
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'UPDATE_MERCHANT_CONCURRENCY', category: 'MERCHANT',
      targetType: 'Merchant', targetId: merchant.merchantId, details: patch,
    });

    res.json({ success: true, merchant });
  } catch (error) {
    console.error('PUT /merchants/:merchantId/scoring error:', error);
    res.status(500).json({ success: false, message: 'Failed to update merchant scoring settings' });
  }
});

export default router;
