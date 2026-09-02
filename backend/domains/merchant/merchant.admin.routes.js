// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** merchant.admin.routes.js — admin-facing merchant management. Domain: Merchant
 * (BBEPS Phase 003 §3.3). Moved from backend/routes/admin/merchants.admin.routes.js
 * on 2026-07-01 (BBEPS Phase 004 migration). */
import { express, authenticate, isAdmin, isAdminOrSubAdmin } from '../../routes/admin/_adminShared.js';
import { paiseToRupees } from '../../shared/money.js';
import { db } from '#db';
import { creditMerchantTokens, debitMerchantTokens } from './merchantWallet.service.js';
import { MERCHANT_CURRENCY, MERCHANT_CURRENCIES, merchantTypeOf } from './merchantCurrency.js';
import * as issuance from '#db/repositories/adminIssuance.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyKey.js';

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
 * Issuance goes through the authority resolver (postgres/moneyAuthority.js).
 *
 * Both implementations live in postgres/adminIssuanceAuthority.js — the Mongo
 * counter this file used to hold inline, and the double-entry treasury. Which
 * one runs is decided per call, and MongoDB is still the default.
 *
 * ── The contract change ─────────────────────────────────────────────────────
 * Every mint carries a `movementId`, because the operation is not idempotent
 * without one: `reserveAdminMint(amount)` took an amount and nothing else, so
 * two deliveries of one admin request minted twice and nothing could tell that
 * from two legitimate top-ups. The key also ties the mint to the merchant
 * credit that follows it, so the pair can never half-apply.
 *
 * Where the key comes from differs by endpoint, and the difference is whether a
 * NATURAL one exists:
 *
 *  - `/merchant-token-orders/:id/approve` keys on the ORDER. The order is the
 *    request; approving it twice is the same act twice. No caller input needed.
 *  - `/merchants/:id/fund` has no natural key — "top up merchant X by ₹5,000"
 *    is identical bytes whether it is a retry or a second deliberate top-up —
 *    so the CALLER must supply one, and a missing key is a 400. Deliberately
 *    not defaulted: a server-generated fallback is precisely the bug that
 *    shipped (`mw_topup_${new ObjectId()}`, fresh per delivery), and it is worse
 *    than no gate because the code reads as though it has one.
 *
 * See middleware/idempotencyKey.js for the shape rules and why a key that
 * reaches a UNIQUE column is validated rather than trusted.
 */
async function reserveAdminMint(amount, opts) {
  return issuance.reserveAdminMint({ amountTokens: Number(amount), ...opts });
}

async function rollbackAdminMint(amount, opts) {
  return issuance.rollbackAdminMint({ amountTokens: Number(amount), ...opts });
}


router.get('/merchants', authenticate, isAdmin, async (req, res) => {
  try {
    const { status, page = 1, limit = 50, search, currency } = req.query;

    // ── The filter is IN the query now ────────────────────────────────────
    //
    // It used to paginate first and filter the page afterwards, in JavaScript.
    // So a page could come back short — or completely empty — while merchants
    // matching the filter sat on the next page, and `total` counted every
    // merchant rather than the ones being shown. An admin filtering for
    // PENDING approvals saw "0 of 312" and concluded there were none.
    //
    // There is also no join. Name, mobile and email are columns on the
    // merchant now; the list used to fetch every linked account separately and
    // prefer whichever copy was non-empty, which is two sources for one value.
    const { merchants: rows, total } = await db.merchants.listMerchants({
      approvalStatus: status && status !== 'ALL' ? status : null,
      currency: currency || null,
      search: search || null,
      limit: parseInt(limit, 10) || 50,
    });

    // The wallet is the authority on what a merchant can actually spend. The
    // record carries no balance, deliberately — a copy on the row would be a
    // second writer waiting to disagree with the movement.
    const balances = await db.merchantWallets.getAvailablePaiseFor(rows.map((m) => m.merchantId));

    const merchants = rows.map((m) => ({
      _id:                    m.merchantId,
      merchantId:             m.merchantId,
      userId:                 m.userId,
      name:                   m.username || m.name || '',
      mobile:                 m.mobile || '',
      email:                  m.email || '',
      status:                 m.status,
      merchantApprovalStatus: m.merchantApprovalStatus,
      isOnline:               m.isOnline,
      acceptsDeposits:        m.acceptsDeposits,
      acceptsWithdrawals:     m.acceptsWithdrawals,
      merchantType:           m.merchantType,
      tokenBalance:           paiseToRupees(balances.get(String(m.merchantId)) ?? 0),
      panelUrl:               m.panelUrl,
      merchantStats:          m.merchantStats,
      createdAt:              m.createdAt,
    }));

    res.json({
      success: true,
      merchants,
      pagination: {
        total,
        page: parseInt(page, 10) || 1,
        limit: parseInt(limit, 10) || 50,
        pages: Math.ceil(total / (parseInt(limit, 10) || 50)),
      },
    });
  } catch (error) {
    console.error('Get merchants error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch merchants' });
  }
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 📝 AUDIT LOGS
 * ════════════════════════════════════════════════════════════════════════════
 */

// ✅ FIX #20: Audit log endpoint now uses EnhancedAuditLog model (defined in models/audit.model.js)
// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
router.get('/merchants/:merchantId', authenticate, isAdmin, async (req, res) => {
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
router.put('/merchants/:merchantId/suspend', authenticate, isAdmin, async (req, res) => {
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

// Activate a merchant, clearing any stale suspension reason in the same statement.
router.put('/merchants/:merchantId/activate', authenticate, isAdmin, async (req, res) => {
  try {
    const { merchantId } = req.params;

    // Approving clears the suspension reason in the SAME statement. A merchant
    // that is ACTIVE while still carrying "suspended for chargebacks" is a row
    // that says two things at once, and an operator reading it cannot tell
    // which is current.
    const merchant = await db.merchants.approveMerchant(merchantId, { actor: req.user.userId });
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

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

/**
 * Set the order range an admin will route to this merchant.
 *
 * ── One owner for the value ─────────────────────────────────────────────────
 * This wrote `merchantLimits.perTransactionLimit` onto the ACCOUNT, while the
 * merchant record carried `minOrder`/`maxOrder` for the same thing — two
 * owners for one number, which the assignment service read from the merchant
 * and this route wrote to the account. Changing a limit here therefore changed
 * nothing about which orders the merchant was offered.
 *
 * The merchant row owns it. That is the row assignment reads, and the row that
 * refuses a range excluding every amount.
 */
router.put('/merchants/:merchantId/limits', authenticate, isAdmin, async (req, res) => {
  try {
    const { merchantId } = req.params;
    const { minOrder, maxOrder, perTransactionLimit, minTransaction } = req.body;

    // The panel sends either spelling. Both mean the same range.
    const patch = {};
    const nextMax = maxOrder ?? perTransactionLimit;
    const nextMin = minOrder ?? minTransaction;
    if (nextMin !== undefined) patch.minOrder = Number(nextMin);
    if (nextMax !== undefined) patch.maxOrder = Number(nextMax);
    if (!Object.keys(patch).length) {
      return res.status(400).json({ success: false, message: 'No limit fields provided.' });
    }

    let merchant;
    try {
      merchant = await db.merchants.updateMerchant(merchantId, patch);
    } catch (e) {
      if (e.code === '23514') {
        return res.status(400).json({
          success: false,
          message: 'Those limits exclude every amount — the minimum cannot be above the maximum.',
        });
      }
      throw e;
    }
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    const limits = { minOrder: merchant.minOrder, maxOrder: merchant.maxOrder };

    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'MERCHANT_LIMITS_UPDATED', category: 'MERCHANT',
      targetType: 'Merchant', targetId: merchantId, targetName: merchant.name,
      changes: { after: limits },
    });

    if (global.sseManager) {
      global.sseManager.broadcastToAdmins('merchant_limits_updated', { merchantId, limits });
    }

    // From the WALLET. The merchant record carries no balance — a copy on the
    // row would be a second writer waiting to disagree with the movement.
    const available = await db.merchantWallets.getMerchantTokenBalance(merchantId);
    res.json({
      success: true,
      message: 'Merchant limits updated successfully',
      limits,
      tokenBalance: available,
    });
  } catch (error) {
    console.error('Update merchant limits error:', error);
    res.status(500).json({ success: false, message: 'Failed to update merchant limits' });
  }
});


// PUT /merchants/:merchantId/capabilities — one place to control WHAT a
// merchant can do: order types (deposit/withdrawal), currencies (INR/USDT),
// and order range. Everything here is enforced by
// merchantScoring.selectBestMerchant, so toggling a capability immediately
// changes which orders this merchant is offered. (Phase-audit 2026-07-09.)
router.put('/merchants/:merchantId/capabilities', authenticate, isAdmin, async (req, res) => {
  try {
    const { merchantId } = req.params;
    const { acceptsDeposits, acceptsWithdrawals, acceptedCurrencies, merchantType, minOrder, maxOrder } = req.body;

    const merchant = await db.merchants.getMerchant(merchantId);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    // A merchant settles on exactly ONE rail — an INR merchant (UPI + bank) or
    // a USDT merchant (TRC-20), never both. Accepts either `merchantType:
    // 'USDT'` or the equivalent `acceptedCurrencies: ['USDT']`; both write the
    // one stored authority, and the row's CHECK refuses anything else.
    const patch = {};
    const railInput = merchantType !== undefined ? [merchantType] : acceptedCurrencies;
    if (railInput !== undefined) {
      const rails = Array.isArray(railInput) ? [...new Set(railInput)] : [railInput];
      if (rails.length !== 1 || !MERCHANT_CURRENCIES.includes(rails[0])) {
        return res.status(400).json({ success: false, message: 'A merchant settles on exactly one rail — send merchantType "INR" or "USDT".' });
      }
      const nextRail = rails[0];
      if (nextRail !== merchant.merchantType) {
        // Switching rails strands the old rail's credentials on the record,
        // where they still occupy a unique index — so the merchant cannot
        // re-register them elsewhere — and could still be snapshotted onto an
        // order. Cleared here; the merchant re-enters the credentials for
        // their new rail from the panel.
        if (nextRail === MERCHANT_CURRENCY.USDT) {
          patch.bankUpiId = null; patch.bankAccountNo = null;
          patch.bankIfsc = null; patch.bankAccountHolderName = null;
          patch.qrCodeUrl = null;
        } else {
          patch.usdtWalletAddress = null;
        }
      }
      patch.acceptedCurrencies = rails;
    }
    if (typeof acceptsDeposits === 'boolean')    patch.acceptsDeposits = acceptsDeposits;
    if (typeof acceptsWithdrawals === 'boolean') patch.acceptsWithdrawals = acceptsWithdrawals;
    if (minOrder !== undefined) {
      if (!(Number(minOrder) >= 0)) return res.status(400).json({ success: false, message: 'minOrder must be >= 0.' });
      patch.minOrder = Number(minOrder);
    }
    if (maxOrder !== undefined) {
      if (!(Number(maxOrder) > 0)) return res.status(400).json({ success: false, message: 'maxOrder must be > 0.' });
      patch.maxOrder = Number(maxOrder);
    }

    // The range and the rail are checked by the ROW as well. These messages
    // exist so an admin gets one they can act on rather than a constraint name.
    let updated;
    try {
      updated = await db.merchants.updateMerchant(merchantId, patch);
    } catch (e) {
      if (e.code === '23514') {
        return res.status(400).json({
          success: false,
          message: 'Those settings are not valid — check that the order range includes at least one amount and the rail is INR or USDT.',
        });
      }
      throw e;
    }
    const capabilities = {
      acceptsDeposits: updated.acceptsDeposits, acceptsWithdrawals: updated.acceptsWithdrawals,
      merchantType: updated.merchantType, acceptedCurrencies: updated.acceptedCurrencies,
      minOrder: updated.minOrder, maxOrder: updated.maxOrder,
    };

    // Not swallowed. This is the record of an admin changing which orders a
    // merchant is routed, and `recordDetailed` already logs its own failure
    // rather than throwing — a bare catch here would hide that twice.
    await db.audit.recordDetailed({
      performedBy: req.user.userId, performedByName: req.user.username, performedByRole: 'admin',
      action: 'UPDATE_MERCHANT_CAPABILITIES', category: 'MERCHANT',
      targetType: 'Merchant', targetId: merchantId,
      details: capabilities, success: true,
    });

    if (global.sseManager) global.sseManager.broadcastToAdmins('merchant_status_changed', { merchantId, status: updated.status });

    res.json({ success: true, message: 'Merchant capabilities updated.', capabilities });
  } catch (error) {
    console.error('Update merchant capabilities error:', error);
    res.status(500).json({ success: false, message: 'Failed to update merchant capabilities' });
  }
});

// Get merchant earnings
router.get('/merchants/:merchantId/earnings', authenticate, isAdmin, async (req, res) => {
  try {
    const { merchantId } = req.params;
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
    const pendingOrders   = counts.pending + counts.assigned + counts.processing;
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

router.get('/merchants/:merchantId/profile', authenticate, isAdmin, async (req, res) => {
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
    });
  } catch (error) {
    console.error('Get merchant profile error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch merchant profile' });
  }
});

// Approve a merchant application.
router.put('/merchants/:merchantId/approve', authenticate, isAdmin, async (req, res) => {
  try {
    const { merchantId } = req.params;
    // Approval sets the status, records WHO approved it and WHEN, and clears
    // any stale suspension or rejection reason — one statement, so an ACTIVE
    // merchant cannot still be carrying "rejected: documents did not verify".
    const merchant = await db.merchants.approveMerchant(merchantId, { actor: req.user.userId });
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

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

// Reject merchant — FIX B6-b: new endpoint (previously missing)
router.put('/merchants/:merchantId/reject', authenticate, isAdmin, async (req, res) => {
  try {
    const { merchantId } = req.params;
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: 'Rejection reason is required' });

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
router.post('/merchants/create', authenticate, isAdmin, async (req, res) => {
  try {
    // AQ-8: hash via the password authority (argon2id).
    const { hashPassword } = await import('../identity/password.util.js');
    const { username, mobile, password, email } = req.body;
    if (!username || !mobile || !password) return res.status(400).json({ success: false, message: 'username, mobile, password required' });
    // ONE transaction for the account, the merchant and the wallet — the same
    // fix as the self-signup path, and for the same reason: a failure on the
    // second write left an account flagged as a merchant with no merchant
    // record behind it, holding a mobile nobody could reuse.
    const created = await db.merchants.createMerchantAccount({
      userId: db.users.newUserId(),
      username, mobile, email: email || null,
      passwordHash: await hashPassword(password),
    });
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
      details: { mobile, createdByAdmin: true },
    });

    res.json({
      success: true, message: 'Merchant created',
      merchantId: merchant.merchantId, userId: created.userId,
    });
  } catch (error) {
    console.error('Create merchant error:', error);
    res.status(500).json({ success: false, message: 'Failed to create merchant' });
  }
});

// Get user transaction history for admin user detail modal
router.get('/merchants/:merchantId/transactions', authenticate, isAdmin, async (req, res) => {
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

// ════════════════════════════════════════════════════════════════════════════
// ✅ FIX #9: QUEUE MANAGER ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

// ✅ FIX #18: Missing endpoint — admin panel QueueDashboard calls this at startup
// GET /api/admin/queue/available-merchants?type=DEPOSIT|WITHDRAWAL&orderAmount=5000
router.post('/merchants/:merchantId/fund', authenticate, isAdmin, async (req, res) => {
  // Logs a MERCHANT_TOPUP transaction — appears in merchant-funding dashboard only,
  // NEVER in user deposit/withdrawal dashboards.
  try {
    const { merchantId }  = req.params;
    const { tokenAmount, note } = req.body;
    const tokenAmountNum = Number(tokenAmount);

    if (!(tokenAmountNum > 0) || !Number.isFinite(tokenAmountNum)) {
      return res.status(400).json({ success: false, message: 'tokenAmount must be a positive number' });
    }

    // Admin top-ups mint from the fixed treasury cap before crediting
    // the merchant wallet. Roll back the supply reservation if the wallet
    // write fails.
    //
    // ── The key ────────────────────────────────────────────────────────────
    // REQUIRED from the caller, and one id covers both the mint and the credit
    // so they can never half-apply.
    //
    // What shipped was `mw_topup_${new ObjectId()}` — a fresh key per delivery,
    // which is `random()`. The UNIQUE gate behind it could never fire, so every
    // retry funded the merchant a second time while the code read as though it
    // were protected. Generating a fallback here would restore exactly that
    // illusion, which is why there is no fallback: only the caller can
    // distinguish a retry from a deliberate second top-up, so an absent key is
    // a 400 rather than a guess.
    const mintKey = requireIdempotencyKey(req);

    let supply;
    let creditResult;
    try {
      supply = await reserveAdminMint(tokenAmountNum, {
        movementId: `mint_${mintKey}`, merchantId: String(merchantId),
        actor: String(req.user.userId), refModel: 'Merchant', refId: String(merchantId),
        reason: `Admin wallet top-up${note ? ` — ${note}` : ''}`,
      });
      creditResult = await creditMerchantTokens({
        merchantId, amount: tokenAmountNum,
        reason: `Admin wallet top-up${note ? ` — ${note}` : ''}`,
        refModel: 'Merchant', refId: String(merchantId),
        txId: `mw_topup_${mintKey}`,
      });
    } catch (mintErr) {
      if (supply) {
        await rollbackAdminMint(tokenAmountNum, {
          movementId: `mint_${mintKey}`, actor: String(req.user.userId),
          refModel: 'Merchant', refId: String(merchantId),
          reason: 'Admin wallet top-up failed after minting',
        }).catch((e) => console.error('[admin fund] mint rollback failed:', e.message));
      }
      throw mintErr;
    }
    const { merchant } = creditResult;

    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found' });
    }

    // No separate transaction row. The mint writes a treasury entry and the
    // credit writes a merchant-wallet entry, both append-only and both inside
    // their own movements — a third hand-written record here would be a copy
    // that can disagree with the two the money actually made, and it is those
    // that reconciliation is computed from. WHO did it is the audit entry.
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'MERCHANT_FUNDED', category: 'TREASURY',
      targetType: 'Merchant', targetId: String(merchantId),
      details: { tokenAmount: tokenAmountNum, note: note || null, movementId: `mint_${mintKey}` },
    });

    // From the WALLET, after the credit. The merchant record carries no
    // balance to read back.
    const newTokenBalance = await db.merchantWallets.getMerchantTokenBalance(merchantId);

    res.json({
      success:          true,
      message:          `Merchant wallet credited with ${tokenAmountNum} tokens`,
      merchantUserId:   merchantId,
      tokenAmountAdded: tokenAmountNum,
      newTokenBalance,
    });

  } catch (error) {
    console.error('❌ Admin fund merchant error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Failed to fund merchant wallet' });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// Merchant admin-token purchase workflow: merchant requests once/day with USDT
// proof; admin approval mints from the fixed supply cap into merchant wallet.
router.get('/merchant-token-orders', authenticate, isAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const orders = await db.paymentConfig.listTokenOrders({ status: status || null, limit: 200 });

    // The merchant details, fetched once for the whole page rather than a
    // populate per row. Their spendable balance comes from the WALLET — the
    // merchant record has none, and a listing that showed a stored copy would
    // be showing an admin a number no transfer will find.
    const merchants = await db.merchants.getMerchants(orders.map((o) => o.merchantId));
    const balances  = await db.merchantWallets.getAvailablePaiseFor(orders.map((o) => o.merchantId));
    const byId = Object.fromEntries(merchants.map((m) => [m.merchantId, m]));
    for (const order of orders) {
      const m = byId[order.merchantId];
      order.merchant = m ? {
        merchantId: m.merchantId, name: m.name, username: m.username, mobile: m.mobile,
        tokenBalance: paiseToRupees(balances.get(String(m.merchantId)) ?? 0),
      } : null;
    }
    res.json({ success: true, orders });
  } catch (error) {
    console.error('GET /admin/merchant-token-orders error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch merchant token orders' });
  }
});

router.post('/merchant-token-orders/:orderId/approve', authenticate, isAdmin, async (req, res) => {
  try {
    const { orderId } = req.params;

    // ── The money moves BEFORE the status, and nothing is compensated ────────
    //
    // This used to mark the order APPROVED, then mint, then credit — and on any
    // failure roll the mint back AND reset the order to PENDING. Its own
    // comment described the hazard: the reset "puts the order back in reach of
    // the guard while the mint stays spent", so a retry could approve an order
    // whose supply had already been consumed.
    //
    // The mint and the credit are both keyed on the ORDER, so they are
    // idempotent across requests as well as within one. Doing them first means
    // a failure leaves the order PENDING with nothing to undo, and the retry
    // reuses the same reservation rather than making a second one.
    const pending = await db.paymentConfig.getTokenOrder(orderId);
    if (!pending || pending.status !== 'PENDING') {
      return res.status(404).json({ success: false, message: 'Pending merchant token order not found' });
    }

    let supply;
    try {
      supply = await reserveAdminMint(pending.tokenAmount, {
        movementId: `mint_order_${orderId}`, merchantId: String(pending.merchantId),
        actor: String(req.user.userId), refModel: 'MerchantAdminTokenOrder', refId: String(orderId),
        reason: `Admin token purchase approved: ${orderId}`,
      });
      await creditMerchantTokens({
        merchantId: pending.merchantId,
        amount: pending.tokenAmount,
        reason: `Admin token purchase approved: ${orderId}`,
        refModel: 'MerchantAdminTokenOrder',
        refId: String(orderId),
        txId: `mw_admin_purchase_${orderId}`,
      });
    } catch (err) {
      // The reservation is released because the credit did not happen. Keyed
      // on the same movement id, so releasing twice releases once.
      if (supply) {
        await rollbackAdminMint(pending.tokenAmount, {
          movementId: `mint_order_${orderId}`, actor: String(req.user.userId),
          refModel: 'MerchantAdminTokenOrder', refId: String(orderId),
          reason: `Admin token purchase ${orderId} failed after minting`,
        }).catch((e) => console.error('[admin approve] mint rollback failed:', e.message));
      }
      // The order is untouched — still PENDING, still approvable.
      throw err;
    }

    // The money is where it belongs; record the decision. Guarded on PENDING,
    // so two admins approving together produce one decision and the second is
    // told rather than believing they made it.
    const approved = await db.paymentConfig.approveTokenOrder(orderId, {
      actor: req.user.userId, note: req.body.note || null,
    });

    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'MERCHANT_TOKEN_ORDER_APPROVED', category: 'TREASURY',
      targetType: 'MerchantAdminTokenOrder', targetId: orderId,
      details: { merchantId: pending.merchantId, tokenAmount: pending.tokenAmount },
    });

    const merchantBalance = await db.merchantWallets.getMerchantTokenBalance(pending.merchantId);
    return res.json({
      success: true,
      order: approved.order ?? pending,
      merchant: { merchantId: pending.merchantId, tokenBalance: merchantBalance },
      supply,
    });
  } catch (error) {
    console.error('POST /admin/merchant-token-orders/:orderId/approve error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Failed to approve merchant token order' });
  }
});

router.post('/merchant-token-orders/:orderId/reject', authenticate, isAdmin, async (req, res) => {
  try {
    // The note is required by the row: a rejected request the merchant cannot
    // be given a reason for is one they cannot fix and resubmit.
    const rejected = await db.paymentConfig.rejectTokenOrder(req.params.orderId, {
      actor: req.user.userId, note: req.body.reason || 'Rejected by admin',
    });
    if (!rejected.ok) return res.status(404).json({ success: false, message: 'Pending merchant token order not found' });

    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'MERCHANT_TOKEN_ORDER_REJECTED', category: 'TREASURY',
      targetType: 'MerchantAdminTokenOrder', targetId: req.params.orderId,
      details: { reason: req.body.reason || 'Rejected by admin' },
    });

    res.json({ success: true, order: rejected.order });
  } catch (error) {
    console.error('POST /admin/merchant-token-orders/:orderId/reject error:', error);
    res.status(500).json({ success: false, message: 'Failed to reject merchant token order' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/merchants/:merchantId/deduct — ADM (Phase B, 2026-07-10)
// The missing counterpart to /fund: admin removes tokens from a merchant
// wallet (top-up correction, off-boarding, penalty). STRICT — refuses if the
// balance is insufficient (no overdraft): an admin deduction must never make
// a merchant negative, that would silently mint liability elsewhere.
// GOVERNANCE §1: via merchantWallet.service.js (sole tokenBalance writer).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/merchants/:merchantId/deduct', authenticate, isAdmin, async (req, res) => {
  try {
    const { merchantId } = req.params;
    const { tokenAmount, reason } = req.body;

    if (!tokenAmount || tokenAmount <= 0 || !Number.isFinite(tokenAmount)) {
      return res.status(400).json({ success: false, message: 'tokenAmount must be a positive number' });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ success: false, message: 'A reason is required to deduct merchant tokens (audit trail).' });
    }

    // The key is REQUIRED from the caller, for the same reason the top-up path
    // requires one: "deduct 5,000 from merchant X" is identical bytes whether
    // it is a retry or a second deliberate deduction, and only the caller can
    // tell them apart. A server-generated id — which is what this used —
    // is `random()`: the UNIQUE gate behind it could never fire, so every
    // redelivery deducted a second time while the code read as protected.
    const deductKey = requireIdempotencyKey(req);

    const { merchant, idempotent } = await debitMerchantTokens({
      merchantId, amount: tokenAmount,
      reason: `Admin wallet deduction — ${String(reason).trim()}`,
      refModel: 'Merchant', refId: String(merchantId),
      txId: `mw_deduct_${deductKey}`,
      // allowOverdraft deliberately NOT set — the strict guard applies.
    });

    if (!merchant && !idempotent) {
      // Either the merchant does not exist or the balance is short. Which one
      // decides what an admin does next, so it is looked up rather than
      // collapsed into one message.
      const exists = await db.merchants.getMerchant(merchantId);
      if (!exists) {
        return res.status(404).json({ success: false, message: 'Merchant not found' });
      }
      // From the WALLET. Reporting a stored copy here would tell an admin the
      // deduction should have fit when the wallet says otherwise.
      const available = await db.merchantWallets.getMerchantTokenBalance(merchantId);
      return res.status(400).json({
        success: false,
        message: `Insufficient merchant balance: has ${available} tokens, tried to deduct ${tokenAmount}. Deductions never overdraft.`,
        tokenBalance: available,
      });
    }

    // The movement wrote its own append-only entry. What is recorded here is
    // WHO decided it and why — which the ledger row cannot say.
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'MERCHANT_TOKENS_DEDUCTED', category: 'TREASURY',
      targetType: 'Merchant', targetId: String(merchantId),
      details: { tokenAmount, reason: String(reason).trim(), movementId: `mw_deduct_${deductKey}` },
    });

    const newTokenBalance = await db.merchantWallets.getMerchantTokenBalance(merchantId);
    res.json({
      success:            true,
      message:            `Merchant wallet deducted by ${tokenAmount} tokens`,
      merchantUserId:     merchantId,
      tokenAmountRemoved: tokenAmount,
      newTokenBalance,
    });

  } catch (error) {
    console.error('❌ Admin deduct merchant error:', error);
    res.status(500).json({ success: false, message: 'Failed to deduct merchant wallet' });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/admin/merchants/:merchantId/panel-url
// Admin sets the external merchant panel Railway URL so users get redirected

// Also used to approve and set up merchant accounts after registration.
// ─────────────────────────────────────────────────────────────────────────────
router.put('/merchants/:merchantId/panel-url', authenticate, isAdmin, async (req, res) => {
  try {
    const { merchantId } = req.params;
    const { panelUrl } = req.body;

    // The panel URL lives on the merchant record. It was written to the
    // account, which nothing reads.
    const merchant = await db.merchants.updateMerchant(merchantId, { panelUrl: panelUrl || '' });
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found' });
    }

    global.io?.to('admin-room').emit('merchant_config_updated', { merchantId, panelUrl: merchant.panelUrl });

    res.json({ success: true, message: 'Merchant panel URL updated', panelUrl: merchant.panelUrl });
  } catch (error) {
    console.error('Update merchant panel URL error:', error);
    res.status(500).json({ success: false, message: 'Failed to update merchant panel URL' });
  }
});

// ---------------------------------------------------------------------------
// FRONTEND ERROR REPORTS  (FIX-4b)
// POST /internal/error-report  -- NO auth (ErrorBoundary fires on crashes)
// GET  /error-reports          -- admin only, returns last 200 reports
// DELETE /error-reports        -- admin only, wipes all reports
// ---------------------------------------------------------------------------

// NOTE: POST /internal/error-report is intentionally NOT here.
// ErrorBoundary in user-panel and merchant-panel calls POST /api/internal/error-report
// which is mounted directly in server.js (no /admin prefix, no JWT required so a
// crashing panel can still report errors). The admin-prefixed version at
// /api/admin/internal/error-report was dead code — ErrorBoundary never reached it.
// Reading and clearing reports IS admin-only:



// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/merchants/:merchantId/profit-engine
//

// dashboard counters or wallet balances.
//
// Formula (per spec):
//   Revenue    = sum(fiatAmount of COMPLETED deposit orders assigned to merchant)
//   FundCost   = tokensAllocated × admin sellRate  (what admin paid per token)
//   WithdrawEx = sum(fiatAmount of COMPLETED withdrawal orders assigned to merchant)
//   Profit     = Revenue − FundCost − WithdrawEx
//   ROI        = Profit / FundCost × 100
// ─────────────────────────────────────────────────────────────────────────────
router.get('/merchants/:merchantId/profit-engine', authenticate, isAdmin, async (req, res) => {
  try {
    const { merchantId } = req.params;
    const merchant = await db.merchants.getMerchant(merchantId);
    if (!merchant)
      return res.status(404).json({ success: false, message: 'Merchant not found' });

    // Fixed 1:1 conversion — 1 token = ₹1, no spread. The revenue and exposure
    // figures still come from each order's stored fiat amount, so historical
    // orders keep the values they actually settled at.
    const sellRate = 1;
    const buyRate  = 1;
    const spread   = 0;

    // ONE pass over one snapshot. This was three separate finds pulling EVERY
    // order the merchant had ever touched — twice over for the amounts and
    // again for the status breakdown — to add up in JavaScript. That works on a
    // new merchant and stops working on a busy one, and the three reads could
    // see the table at three different moments, so revenue and exposure need
    // not have described the same set of orders.
    const engine = await db.stats.merchantProfitEngine(merchant.merchantId);

    // The merchant record carries no balance. What they can spend right now
    // comes from the wallet, which is where the movements happen.
    const tokensAllocated = await db.merchantWallets.getMerchantTokenBalance(merchant.merchantId);
    const tokensDeposited = engine.tokensDispensed;
    const tokensReturned  = engine.tokensReturned;
    const revenue         = engine.revenue;
    const withdrawalExposure = engine.withdrawalExposure;

    // Funding cost = tokens given out to players × the admin sell rate — what
    // the merchant spent from their wallet.
    const fundingCost = tokensDeposited * sellRate;
    const profit      = revenue - fundingCost - withdrawalExposure;
    const roi         = fundingCost > 0 ? ((profit / fundingCost) * 100) : 0;
    const netUserVolume = revenue + withdrawalExposure;

    const statusMap = engine.orderStatus;

    res.json({
      success: true,
      data: {
        merchantId:          merchant.merchantId,
        merchantName:        merchant.name || merchant.username || 'Unknown',
        currentTokenHoldings:tokensAllocated,
        tokensAllocated:     tokensDeposited,  // total tokens ever given to users
        tokensReturned:      tokensReturned,   // total tokens received back from withdrawals
        depositsProcessed:   engine.deposits,
        withdrawalsProcessed:engine.withdrawals,
        netUserVolume,                         // total INR moved
        revenue,                               // INR collected from deposit orders
        fundingCost,                           // INR cost of tokens dispensed
        withdrawalExposure,                    // INR paid on withdrawals
        profit,                                // net merchant profit
        roi:                 parseFloat(roi.toFixed(2)),
        spread,                                // buy-sell spread (admin-defined)
        buyRate,
        sellRate,
        orderStatus:         statusMap,
      },
    });
  } catch (err) {
    console.error('[profit-engine]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
