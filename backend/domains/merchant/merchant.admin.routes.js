// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/** merchant.admin.routes.js — admin-facing merchant management. Domain: Merchant
 * (BBEPS Phase 003 §3.3). Moved from backend/routes/admin/merchants.admin.routes.js
 * on 2026-07-01 (BBEPS Phase 004 migration). */
import { express, authenticate, hasPermission } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
import { assertExternalHttpsUrl } from '../../shared/storedUrl.js';
import { normalisePhone, isValidMobile } from '../identity/signupFields.js';
import { emitToStaff } from '../notification/staffEventAreas.js';
import { NAME_IS_A_MOBILE_MESSAGE } from '../identity/mobileInText.js';
import { respondError } from '../../shared/httpError.js';
import { sendXlsx, oneTable, columnsOf, istText } from '../reporting/xlsx.util.js';
import { paiseToRupees } from '../../shared/money.js';
import { panelOrigin } from '../../config/network.config.js';

const router = express.Router();


/*
 * `createMerchantWithPublicRefRetry` is deleted.
 *
 * It caught a duplicate `publicRef` and retried with a freshly generated one,
 * up to three times. The reference is 16 random hex characters — a collision is
 * not a thing that happens, and a retry loop around it reads as though it does,
 * which invites someone to make the reference shorter. The insert now either
 * succeeds or raises, like every other insert here.
 */

/**
 * GET /api/admin/merchants — the merchants table (owner, 2026-10-14).
 *
 * Agents, supervisors and merchant accounts, one row each, with what they
 * processed, their completed orders, the pool they work from and their
 * commission today, this month and in all. Every figure from its owner in
 * `adminDirectory.listMerchants`; `sort` is one of `MERCHANT_SORTS` and `role`
 * one of `MERCHANT_ROLES`, both sent back so the panel keeps no list (§32 S25).
 * `status` here is the APPROVAL status (PENDING, APPROVED, REJECTED); the
 * account status (ACTIVE, SUSPENDED) is `accountStatus`.
 */
router.get('/merchants', authenticate, hasPermission('canManageMerchants'), async (req, res) => {
  try {
    const { status, accountStatus, role, sort, dir, page = 1, limit = 50, search } = req.query;
    const size = Math.min(parseInt(limit, 10) || 50, 200);
    const { rows, total } = await db.adminDirectory.listMerchants({
      approval: status && status !== 'ALL' ? String(status) : null,
      status: accountStatus && accountStatus !== 'ALL' ? String(accountStatus) : null,
      role: role && role !== 'ALL' ? String(role) : null,
      search: search ? String(search) : null,
      sort: sort ? String(sort) : undefined,
      dir: dir ? String(dir) : undefined,
      limit: size,
      page: parseInt(page, 10) || 1,
    });
    res.json({
      success: true,
      merchants: rows,
      sorts: Object.keys(db.adminDirectory.MERCHANT_SORTS),
      roles: Object.keys(db.adminDirectory.MERCHANT_ROLES),
      pagination: {
        total,
        page: parseInt(page, 10) || 1,
        limit: size,
        pages: Math.max(Math.ceil(total / size), 1),
      },
    });
  } catch (error) {
    return respondError(res, error, 'GET /admin/merchants', { message: 'Failed to fetch merchants' });
  }
});

/** GET /api/admin/merchants.xlsx — every merchant the table's filters match, as a workbook (rupees). */
router.get('/merchants.xlsx', authenticate, hasPermission('canManageMerchants'), async (req, res) => {
  try {
    const { status, accountStatus, role, sort, dir, search } = req.query;
    const { rows } = await db.adminDirectory.listMerchants({
      approval: status && status !== 'ALL' ? String(status) : null,
      status: accountStatus && accountStatus !== 'ALL' ? String(accountStatus) : null,
      role: role && role !== 'ALL' ? String(role) : null,
      search: search ? String(search) : null,
      sort: sort ? String(sort) : undefined,
      dir: dir ? String(dir) : undefined,
      exportAll: true,
    });
    const table = rows.map((m) => ({
      merchant_id: m.merchantId,
      name: m.name,
      mobile: m.mobile,
      role: m.role,
      team: m.team?.name || '',
      status: m.status,
      approval: m.merchantApprovalStatus,
      online: m.isOnline ? 'yes' : 'no',
      rail: m.rail || '',
      takes_buys: m.acceptsDeposits ? 'yes' : 'no',
      takes_sells: m.acceptsWithdrawals ? 'yes' : 'no',
      priority: m.routingPriority,
      completed_orders: m.completedOrders,
      processed: paiseToRupees(m.processedPaise),
      pool_available: paiseToRupees(m.pool.availablePaise),
      pool_held: paiseToRupees(m.pool.heldPaise),
      commission_today: paiseToRupees(m.commission.todayPaise),
      commission_month: paiseToRupees(m.commission.monthPaise),
      commission_total: paiseToRupees(m.commission.totalPaise),
      lost_disputes: m.lostDisputes,
      created_at: m.createdAt ? new Date(m.createdAt).toISOString() : '',
    }));
    sendXlsx(res, 'merchants.xlsx', oneTable({
      name: 'Merchants', title: 'Merchants', subtitle: `Downloaded ${istText(new Date())}`, accent: 'purple',
      rows: table, columns: columnsOf(table, { money: ['processed', 'pool_available', 'pool_held', 'commission_today', 'commission_month', 'commission_total'] }),
    }));
  } catch (error) {
    return respondError(res, error, 'GET /admin/merchants.xlsx', { message: 'Could not build the export.' });
  }
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 📝 AUDIT LOGS
 * ════════════════════════════════════════════════════════════════════════════
 */

// ✅ FIX #20: Audit log endpoint now uses EnhancedAuditLog model (defined in models/audit.model.js)
// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
router.get('/merchants/:merchantId', authenticate, hasPermission('canManageMerchants'), async (req, res) => {
  try {
    const { merchantId } = req.params;
    const merchant = await db.merchants.getMerchant(merchantId);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });
    res.json({ success: true, merchant });
  } catch (error) {
    console.error('Get merchant error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch merchant details' });
  }
});

// Suspend a merchant. The reason is required by the row, not only by the route.
router.put('/merchants/:merchantId/suspend', authenticate, hasPermission('canManageMerchants'), async (req, res) => {
  try {
    const { merchantId } = req.params;
    const { reason } = req.body;

    // The reason is required by the ROW as well as by this check — a suspended
    // merchant without one is a suspension nobody can appeal, and the CHECK
    // means no other path can create that state either.
    if (!String(reason ?? '').trim()) {
      return res.status(400).json({ success: false, message: 'Suspension reason is required' });
    }

    const merchant = await db.merchants.suspendMerchant(merchantId, reason, { actor: req.user.userId });
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'MERCHANT_SUSPENDED', category: 'MERCHANT',
      targetType: 'Merchant', targetId: merchantId, targetName: merchant.name,
      details: { reason },
    });

    res.json({ success: true, message: 'Merchant suspended successfully' });
  } catch (error) {
    console.error('Suspend merchant error:', error);
    res.status(500).json({ success: false, message: 'Failed to suspend merchant' });
  }
});

/**
 * Reinstate a merchant — the activate and approve screens share it, so they
 * admit the same things (§32 S3).
 *
 * A team member in high-risk review (a third lost dispute, 2c+) is reinstated
 * by a full admin only. `approveMerchant` refuses it in its WHERE; the read
 * after a refusal is only there to say why, rather than "not found".
 */
async function reinstate(req, merchantId) {
  const mayLiftHighRisk = req.user.isAdmin === true;
  const merchant = await db.merchants.approveMerchant(merchantId, { actor: req.user.userId, mayLiftHighRisk });
  if (merchant) return merchant;
  const existing = await db.merchants.getMerchant(merchantId);
  if (existing?.highRiskAt && !mayLiftHighRisk) {
    return { refused: true, status: 403, body: {
      success: false, code: 'HIGH_RISK_REVIEW',
      message: `This team member has lost ${existing.lostDisputes} disputes and is in high-risk review. Only an admin can reinstate them.`,
    } };
  }
  return { refused: true, status: 404, body: { success: false, message: 'Merchant not found' } };
}

// Activate a merchant, clearing any stale suspension reason in the same statement.
router.put('/merchants/:merchantId/activate', authenticate, hasPermission('canManageMerchants'), async (req, res) => {
  try {
    const { merchantId } = req.params;

    // Approving clears the suspension reason in the SAME statement. A merchant
    // that is ACTIVE while still carrying "suspended for chargebacks" is a row
    // that says two things at once, and an operator reading it cannot tell
    // which is current.
    const merchant = await reinstate(req, merchantId);
    if (merchant.refused) return res.status(merchant.status).json(merchant.body);

    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'MERCHANT_ACTIVATED', category: 'MERCHANT',
      targetType: 'Merchant', targetId: merchantId, targetName: merchant.name,
    });

    res.json({ success: true, message: 'Merchant activated successfully' });
  } catch (error) {
    console.error('Activate merchant error:', error);
    res.status(500).json({ success: false, message: 'Failed to activate merchant' });
  }
});

// Get merchant earnings
router.get('/merchants/:merchantId/earnings', authenticate, hasPermission('canManageMerchants'), async (req, res) => {
  try {
    const merchant = await db.merchants.getMerchant(req.params.merchantId);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    // ONE pass over one snapshot. Four separate counts and a full fetch of
    // every completed order to sum in JavaScript — the sum stops working on the
    // day a merchant has enough orders for anyone to care, and the counts could
    // disagree with each other because each saw the table at a different moment.
    const counts = await db.stats.merchantQueueCounts(merchant.merchantId);
    const earnings = await db.stats.merchantEarnings(merchant.merchantId);
    const totalOrders     = merchant.totalOrdersAll;
    const completedOrders = merchant.totalOrdersCompleted;
    const pendingOrders   = counts.pending + counts.processing;
    const totalVolume     = earnings.lifetime.totalVolume;

    res.json({ success: true, earnings: {
      totalOrders, completedOrders, pendingOrders, totalVolume,
      // commissionRate removed — merchants earn via buy/sell spread only
    }});
  } catch (error) {
    console.error('Get merchant earnings error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch merchant earnings' });
  }
});

router.get('/merchants/:merchantId/profile', authenticate, hasPermission('canManageMerchants'), async (req, res) => {
  try {
    const { merchantId } = req.params;
    const merchant = await db.merchants.getMerchant(merchantId);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    // The lifetime counters live on the merchant row and are moved by the
    // arithmetic in the statement that records each completed order, so they
    // cannot lose one to a concurrent settlement. `successRate` is derived from
    // them in the same statement — it can never describe a different number of
    // orders than the count beside it.
    const totalOrders     = merchant.totalOrdersAll;
    const completedOrders = merchant.totalOrdersCompleted;
    const failedOrders    = Math.max(0, totalOrders - completedOrders);
    const successRate     = (merchant.successRate * 100).toFixed(2);
    res.json({
      success: true,
      merchant: {
        ...merchant,
        // Fixed 1:1 conversion (Phase 006 flattening, 2026-07-08) — no spread.
        prices: { buyPrice: 1, sellPrice: 1, profit: 0 },
        statistics: { totalOrders, completedOrders, failedOrders, successRate: parseFloat(successRate) },
      },
      // The merchants-table row: role, team, pool and commission, from the
      // same query the table reads (display only, §9).
      summary: await db.adminDirectory.merchantRow(merchant.merchantId),
      // The choices the profile's controls offer, from their owners, so the
      // page keeps no copy (§32 S25): routing priority's bounds and the rails a
      // supervisor can run.
      choices: {
        routingPriority: db.merchants.ROUTING_PRIORITY,
        supervisorRails: db.teams.SUPERVISOR_RAILS,
      },
      // Where the merchant panel is: its own host when MERCHANT_HOST is set,
      // else /merchant/ on this origin (owner, 2026-10-20).
      merchantPanelUrl: `${panelOrigin('MERCHANT', '')}/merchant/`,
    });
  } catch (error) {
    console.error('Get merchant profile error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch merchant profile' });
  }
});

// Approve a merchant application.
router.put('/merchants/:merchantId/approve', authenticate, hasPermission('canManageMerchants'), async (req, res) => {
  try {
    const { merchantId } = req.params;
    // Approval sets the status, records WHO approved it and WHEN, and clears
    // any stale suspension or rejection reason — one statement, so an ACTIVE
    // merchant cannot still be carrying "rejected: documents did not verify".
    const merchant = await reinstate(req, merchantId);
    if (merchant.refused) return res.status(merchant.status).json(merchant.body);

    // The linked account carries the merchant role so it is excluded from the
    // player list. Signup already sets it; this is the repair for accounts
    // approved through the older queue path.
    if (merchant.userId) {
      await db.users.updateUser(merchant.userId, { roles: ['merchant'] });
    }

    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'MERCHANT_APPROVED', category: 'MERCHANT',
      targetType: 'Merchant', targetId: merchantId, targetName: merchant.name,
    });

    if (global.sseManager) {
      global.sseManager.broadcastToAdmins('merchant_approved', { merchantId, approvedAt: new Date() });
    }

    res.json({ success: true, message: 'Merchant approved' });
  } catch (error) {
    console.error('Approve merchant error:', error);
    res.status(500).json({ success: false, message: 'Failed to approve merchant' });
  }
});

/**
 * Lift an assignment pause after speaking to the merchant.
 *
 * The merchant was paused because three buy orders in a row expired with nobody
 * paying — which says nothing about their honesty and quite a lot about whether
 * anyone can actually pay them. There is no timer on it, deliberately: a clock
 * cannot tell whether the QR was fixed, and an admin who has just had the
 * conversation can.
 *
 * SEPARATE from approve/suspend, because it answers a different question (§7).
 * `approveMerchant` is about whether this merchant is allowed to trade at all;
 * this is about whether the platform currently believes they are reachable.
 * Folding it into approve would mean lifting a pause required un-suspending a
 * merchant nobody had suspended.
 *
 * The expiry streak is zeroed with it, in the same statement — left at three,
 * the next ordinary expiry pauses them again and this decision lasts one order.
 */
router.put('/merchants/:merchantId/resume-assignment', authenticate, hasPermission('canManageMerchants'), async (req, res) => {
  try {
    const { merchantId } = req.params;
    const { note } = req.body ?? {};

    const before = await db.merchants.getMerchant(merchantId);
    if (!before) return res.status(404).json({ success: false, message: 'Merchant not found' });
    if (!before.assignmentPausedAt) {
      // 200, not an error: an admin clearing a pause that a completed order has
      // already cleared has got what they wanted.
      return res.json({ success: true, message: 'This merchant was not paused.', alreadyActive: true });
    }

    const merchant = await db.merchants.resumeAssignment(merchantId);

    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'MERCHANT_ASSIGNMENT_RESUMED', category: 'MERCHANT',
      targetType: 'Merchant', targetId: merchantId, targetName: merchant.name,
      // What they were paused FOR travels into the record, because the row no
      // longer carries it once the pause is lifted.
      details: {
        pausedAt: before.assignmentPausedAt,
        pausedReason: before.assignmentPauseReason,
        expiriesAtPause: before.consecutiveExpiries,
        note: note ? String(note).slice(0, 500) : null,
      },
    });

    if (global.sseManager) {
      global.sseManager.broadcastToAdmins('merchant_assignment_resumed', {
        merchantId, resumedAt: new Date(),
      });
    }

    res.json({ success: true, message: 'Assignment resumed for this merchant.' });
  } catch (error) {
    console.error('Resume merchant assignment error:', error);
    res.status(500).json({ success: false, message: 'Failed to resume assignment' });
  }
});

// Reject merchant — FIX B6-b: new endpoint (previously missing)
router.put('/merchants/:merchantId/reject', authenticate, hasPermission('canManageMerchants'), async (req, res) => {
  try {
    const { merchantId } = req.params;
    const { reason } = req.body;
    // `trim()`, as the writer asks: a reason of spaces passed `!reason` and
    // left `rejectMerchant` to throw a bare Error, answered as a 500 (S35).
    if (!String(reason ?? '').trim()) return res.status(400).json({ success: false, message: 'Rejection reason is required' });

    // ONE statement. This was two updates to the same row — the first setting
    // the status without the reason, the second adding it — so a failure
    // between them left a merchant REJECTED with no reason recorded, and the
    // applicant with nothing to appeal against.
    const merchant = await db.merchants.rejectMerchant(merchantId, reason, { actor: req.user.userId });
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'MERCHANT_REJECTED', category: 'MERCHANT',
      targetType: 'Merchant', targetId: merchantId, targetName: merchant.name,
      details: { reason },
    });

    if (global.sseManager) {
      global.sseManager.broadcastToAdmins('merchant_rejected', { merchantId, reason, rejectedAt: new Date() });
    }

    res.json({ success: true, message: 'Merchant application rejected' });
  } catch (error) {
    console.error('Reject merchant error:', error);
    res.status(500).json({ success: false, message: 'Failed to reject merchant' });
  }
});

// Create merchant account — FIX B6-c: also create Merchant doc (was User-only, broke all merchant APIs)
//
// No password (owner, 2026-10-14): the merchant signs in with "Continue with
// Telegram" on the merchant panel, and their first Verify shares their contact,
// which links this login — so the mobile must be the one on their Telegram,
// ten digits, as `telegram_link_phone_is_mobile` compares it.
router.post('/merchants/create', authenticate, hasPermission('canManageMerchants'), async (req, res) => {
  try {
    const { username, email } = req.body ?? {};
    if (!username || !req.body?.mobile) {
      return res.status(400).json({ success: false, code: 'FIELDS_REQUIRED', message: 'Enter the merchant\'s name and mobile number.' });
    }
    if (!isValidMobile(req.body.mobile)) {
      return res.status(400).json({ success: false, code: 'MOBILE_INVALID',
        message: 'Enter the merchant\'s 10-digit mobile number — the one on their Telegram account — without +91.' });
    }
    const mobile = normalisePhone(req.body.mobile);
    // ONE transaction for the account, the merchant and the wallet: a failure
    // on the second write used to leave an account flagged as a merchant with
    // no merchant record behind it, holding a mobile nobody could reuse.

    // `kind: 'DIRECT'` creates a MERCHANT ACCOUNT (owner, 2026-10-11): INR,
    // with its own pool's team, in the same transaction.
    const kind = req.body?.kind ?? 'AGENT';
    if (!['AGENT', 'DIRECT'].includes(kind)) {
      return res.status(400).json({ success: false, code: 'UNKNOWN_KIND', message: "kind is 'AGENT' or 'DIRECT'." });
    }
    const created = await db.merchants.createMerchantAccount({
      userId: db.users.newUserId(),
      username, mobile, email: email || null,
      direct: kind === 'DIRECT',
    });
    if (!created.ok && created.reason === 'NAME_IS_A_MOBILE') {
      return res.status(400).json({ success: false, code: 'NAME_IS_A_MOBILE', message: NAME_IS_A_MOBILE_MESSAGE });
    }
    if (!created.ok) {
      return res.status(409).json({
        success: false,
        message: created.reason === 'MOBILE_TAKEN'
          ? 'Mobile already registered'
          : 'Those payment details are already registered to another merchant',
      });
    }

    // Admin-created merchants are approved on creation — an admin adding one
    // by hand has already done the review this status records.
    const merchant = await db.merchants.approveMerchant(created.merchant.merchantId, {
      actor: req.user.userId,
    });

    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'MERCHANT_CREATED', category: 'MERCHANT',
      targetType: 'Merchant', targetId: merchant.merchantId, targetName: merchant.name,
      details: { mobile, createdByAdmin: true, kind },
    });

    res.json({
      success: true, message: 'Merchant created',
      merchantId: merchant.merchantId, userId: created.userId, kind,
    });
  } catch (error) {
    console.error('Create merchant error:', error);
    res.status(500).json({ success: false, message: 'Failed to create merchant' });
  }
});

// Get user transaction history for admin user detail modal
router.get('/merchants/:merchantId/transactions', authenticate, hasPermission('canManageMerchants'), async (req, res) => {
  try {
    const { merchantId } = req.params;
    const { type, status, limit = 50, skip = 0 } = req.query;
    const merchantDoc = await db.merchants.getMerchant(merchantId);
    if (!merchantDoc) return res.status(404).json({ success: false, message: 'Merchant not found' });

    // One query returns the page AND the total, so the two cannot disagree —
    // it was a find plus a separate countDocuments, and an order arriving
    // between them made the paginator show a page that did not add up.
    const { orders: transactions, total } = await db.orders.findOrders({
      merchantId: merchantDoc.merchantId,
      orderType: type || null,
      state: status || null,
      limit: parseInt(limit, 10) || 50,
    });
    
    res.json({
      success: true,
      transactions,
      pagination: { 
        total, 
        limit: parseInt(limit), 
        skip: parseInt(skip),
        hasMore: (parseInt(skip) + parseInt(limit)) < total
      }
    });
  } catch (error) {
    console.error('Get merchant transactions error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch transactions' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/admin/merchants/:merchantId/panel-url
// Admin sets the external merchant panel Railway URL so users get redirected

// Also used to approve and set up merchant accounts after registration.
// ─────────────────────────────────────────────────────────────────────────────
router.put('/merchants/:merchantId/panel-url', authenticate, hasPermission('canManageMerchants'), async (req, res) => {
  try {
    const { merchantId } = req.params;
    const { panelUrl } = req.body;

    // The panel URL lives on the merchant record. It was written to the
    // account, which nothing reads.
    // Stored by an admin, followed by a merchant — the condition under which a
    // downgrade to http is somebody else's problem. Empty clears it.
    let safePanelUrl = '';
    if (String(panelUrl ?? '').trim()) {
      try { safePanelUrl = assertExternalHttpsUrl(panelUrl, 'panel URL'); }
      catch (e) { return res.status(400).json({ success: false, message: e.message }); }
    }
    const merchant = await db.merchants.updateMerchant(merchantId, { panelUrl: safePanelUrl });
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found' });
    }

    emitToStaff(global.io, 'merchant_config_updated', { merchantId, panelUrl: merchant.panelUrl });

    res.json({ success: true, message: 'Merchant panel URL updated', panelUrl: merchant.panelUrl });
  } catch (error) {
    console.error('Update merchant panel URL error:', error);
    res.status(500).json({ success: false, message: 'Failed to update merchant panel URL' });
  }
});

export default router;
