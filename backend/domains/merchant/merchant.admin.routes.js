// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** merchant.admin.routes.js — admin-facing merchant management. Domain: Merchant
 * (BBEPS Phase 003 §3.3). Moved from backend/routes/admin/merchants.admin.routes.js
 * on 2026-07-01 (BBEPS Phase 004 migration). */
import { express, mongoose, authenticate, isAdmin, isAdminOrSubAdmin, getModels } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
import { creditMerchantTokens, debitMerchantTokens } from './merchantWallet.service.js';
import { generateMerchantPublicRef } from './merchant.model.js';
import { MERCHANT_CURRENCY, MERCHANT_CURRENCIES, merchantTypeOf } from './merchantCurrency.js';
import * as issuance from '#db/repositories/adminIssuance.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyKey.js';

const router = express.Router();


function isPublicRefDuplicate(error) {
  return error?.code === 11000 && (
    error?.keyPattern?.publicRef || error?.keyValue?.publicRef || String(error?.message || '').includes('publicRef')
  );
}

async function createMerchantWithPublicRefRetry(Merchant, payload, retries = 3) {
  let nextPayload = payload;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await Merchant.create(nextPayload);
    } catch (error) {
      if (!isPublicRefDuplicate(error) || attempt === retries) throw error;
      nextPayload = { ...payload, publicRef: generateMerchantPublicRef() };
    }
  }
}

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
    const { User } = getModels();
    const Merchant = mongoose.model('Merchant');
    const { status, page = 1, limit = 50 } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [merchantDocs, total] = await Promise.all([
      Merchant.find({}).skip(skip).limit(parseInt(limit)).lean(),
      Merchant.countDocuments({}),
    ]);

    // Batch-fetch linked User docs for name/mobile/email/approval status
    const userIds  = merchantDocs.map(m => m.userId).filter(Boolean);
    const userDocs = await User.find({ _id: { $in: userIds } })
      .select('username name mobile email status merchantApprovalStatus createdAt')
      .lean();
    const userById = Object.fromEntries(userDocs.map(u => [u._id.toString(), u]));

    let merchants = merchantDocs.map(m => {
      const u = userById[m.userId?.toString()] || {};
      return {
        _id:                    m._id,       // Merchant._id — the only ID used for all merchant operations
        userId:                 m.userId,    // User._id — for internal reference only, never a route param
        name:                   u.username || u.name || m.name || '',
        mobile:                 u.mobile   || m.mobile || '',
        email:                  u.email    || m.email  || '',
        status:                 m.status   || 'ACTIVE',
        // FIX-10: check Merchant doc first (set during queue approval), then User doc fallback
        merchantApprovalStatus: m.merchantApprovalStatus || u.merchantApprovalStatus || 'PENDING',
        isOnline:               m.isOnline  || false,
        acceptsDeposits:        m.acceptsDeposits    !== false,
        acceptsWithdrawals:     m.acceptsWithdrawals !== false,
        // Settlement rail — 'INR' (UPI + bank) or 'USDT' (TRC-20), exclusive.
        merchantType:           merchantTypeOf(m),
        tokenBalance:           m.tokenBalance || 0,
        // commissionRate removed — merchants earn via buy/sell spread
        panelUrl:               m.panelUrl || '',
        merchantStats: {
          monthlyProcessed:     m.merchantStats?.monthlyProcessed     || 0,
          totalOrdersProcessed: m.merchantStats?.totalOrdersProcessed || 0,
          dailyProcessed:       m.merchantStats?.dailyProcessed       || 0,
        },
        createdAt: m.createdAt || u.createdAt,
      };
    });

    // Apply status filter after join (filter is on User.merchantApprovalStatus)
    if (status && status !== 'ALL') {
      merchants = merchants.filter(m => m.merchantApprovalStatus === status);
    }

    res.json({
      success: true,
      merchants,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
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
    const Merchant = mongoose.model('Merchant');
    const merchant = await db.merchants.getMerchant(merchantId);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });
    res.json({ success: true, merchant });
  } catch (error) {
    console.error('Get merchant error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch merchant details' });
  }
});

// Suspend merchant — FIX B6-d: also update Merchant.status (merchantAuth checks Merchant.status)
router.put('/merchants/:merchantId/suspend', authenticate, isAdmin, async (req, res) => {
  try {
    const { merchantId } = req.params;
    const { reason } = req.body;
    const { User } = getModels();
    const Merchant = mongoose.model('Merchant');
    
    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Suspension reason is required'
      });
    }
    
    const merchant = await Merchant.findByIdAndUpdate(
      merchantId,
      { status: 'SUSPENDED', suspensionReason: reason },
      { new: true }
    );
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });
    
    res.json({
      success: true,
      message: 'Merchant suspended successfully'
    });
  } catch (error) {
    console.error('Suspend merchant error:', error);
    res.status(500).json({ success: false, message: 'Failed to suspend merchant' });
  }
});

// Activate merchant — FIX B6-d: also update Merchant.status (merchantAuth checks Merchant.status)
router.put('/merchants/:merchantId/activate', authenticate, isAdmin, async (req, res) => {
  try {
    const { merchantId } = req.params;
    const { User } = getModels();
    const Merchant = mongoose.model('Merchant');
    
    const merchant = await Merchant.findByIdAndUpdate(
      merchantId,
      { status: 'ACTIVE', $unset: { suspensionReason: '' } },
      { new: true }
    );
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });
    
    res.json({
      success: true,
      message: 'Merchant activated successfully'
    });
  } catch (error) {
    console.error('Activate merchant error:', error);
    res.status(500).json({ success: false, message: 'Failed to activate merchant' });
  }
});

// Update merchant limits
router.put('/merchants/:merchantId/limits', authenticate, isAdmin, async (req, res) => {
  try {
    const { merchantId } = req.params;
    
    const { minOrder, maxOrder, perTransactionLimit, minTransaction } = req.body;
    const { User } = getModels();

    // merchantId = Merchant._id; admin limits live on User.merchantLimits (queue cap)
    const merchantDoc = await db.merchants.getMerchant(merchantId);
    if (!merchantDoc) return res.status(404).json({ success: false, message: 'Merchant not found' });
    const userDoc = await db.users.getUser(merchantDoc.userId);
    if (!userDoc) return res.status(404).json({ success: false, message: 'Linked user not found' });
    if (!userDoc.merchantLimits) userDoc.merchantLimits = {};
    const newMax = maxOrder ?? perTransactionLimit;
    const newMin = minOrder ?? minTransaction;
    if (newMax !== undefined) userDoc.merchantLimits.perTransactionLimit = newMax;
    if (newMin !== undefined) userDoc.merchantLimits.minOrder            = newMin;
    await userDoc.save();
    const savedLimits = {
      minOrder: userDoc.merchantLimits.minOrder            || 0,
      maxOrder: userDoc.merchantLimits.perTransactionLimit || 50000,
    };
    if (global.sseManager) {
      global.sseManager.broadcastToAdmins('merchant_limits_updated', { merchantId, limits: savedLimits });
    }
    // M-01: Return current tokenBalance so UI can display buy/sell capacity.
    // Buy capacity = tokenBalance; Sell capacity = lifetime top-up (tracked separately).
    const merchantForBalance = await db.merchants.getMerchant(merchantId);
    res.json({
      success: true,
      message: 'Merchant limits updated successfully',
      limits: savedLimits,
      tokenBalance: merchantForBalance?.tokenBalance ?? 0,
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

    // A merchant settles on exactly ONE rail (2026-07-27) — an INR merchant
    // (UPI + bank) or a USDT merchant (TRC-20), never both. Accepts either
    // `merchantType: 'USDT'` or the equivalent `acceptedCurrencies: ['USDT']`;
    // both write the same stored authority, Merchant.acceptedCurrencies.
    const railInput = merchantType !== undefined ? [merchantType] : acceptedCurrencies;
    if (railInput !== undefined) {
      const rails = Array.isArray(railInput) ? [...new Set(railInput)] : [railInput];
      if (rails.length !== 1 || !MERCHANT_CURRENCIES.includes(rails[0])) {
        return res.status(400).json({ success: false, message: 'A merchant settles on exactly one rail — send merchantType "INR" or "USDT".' });
      }
      const nextRail = rails[0];
      if (nextRail !== merchantTypeOf(merchant)) {
        // Switching rails strands the old rail's credentials on the account,
        // where they would still satisfy uniqueness indexes and could be
        // snapshotted onto an order. Clear them; the merchant re-enters the
        // credentials for their new rail from the panel.
        if (nextRail === MERCHANT_CURRENCY.USDT) {
          merchant.bankDetails = undefined;
          merchant.qrCodeUrl   = undefined;
        } else {
          merchant.usdtWalletAddress = undefined;
        }
      }
      merchant.acceptedCurrencies = rails;
    }
    if (typeof acceptsDeposits === 'boolean')    merchant.acceptsDeposits = acceptsDeposits;
    if (typeof acceptsWithdrawals === 'boolean') merchant.acceptsWithdrawals = acceptsWithdrawals;
    if (minOrder !== undefined) {
      if (!(Number(minOrder) >= 0)) return res.status(400).json({ success: false, message: 'minOrder must be >= 0.' });
      merchant.minOrder = Number(minOrder);
    }
    if (maxOrder !== undefined) {
      if (!(Number(maxOrder) > 0)) return res.status(400).json({ success: false, message: 'maxOrder must be > 0.' });
      merchant.maxOrder = Number(maxOrder);
    }
    if (merchant.maxOrder < merchant.minOrder) {
      return res.status(400).json({ success: false, message: 'maxOrder cannot be less than minOrder.' });
    }
    await merchant.save();

    try {
      await db.audit.recordDetailed({
        performedBy: req.user.userId, performedByName: req.user.username, performedByRole: 'admin',
        action: 'UPDATE_MERCHANT_CAPABILITIES', category: 'MERCHANT',
        targetType: 'Merchant', targetId: String(merchant._id),
        details: {
          acceptsDeposits: merchant.acceptsDeposits, acceptsWithdrawals: merchant.acceptsWithdrawals,
          merchantType: merchantTypeOf(merchant), acceptedCurrencies: merchant.acceptedCurrencies,
          minOrder: merchant.minOrder, maxOrder: merchant.maxOrder,
        },
        success: true,
      });
    } catch (_) {}

    if (global.sseManager) global.sseManager.broadcastToAdmins('merchant_status_changed', { merchantId, status: merchant.status });

    res.json({
      success: true,
      message: 'Merchant capabilities updated.',
      capabilities: {
        acceptsDeposits: merchant.acceptsDeposits, acceptsWithdrawals: merchant.acceptsWithdrawals,
        merchantType: merchantTypeOf(merchant), acceptedCurrencies: merchant.acceptedCurrencies,
        minOrder: merchant.minOrder, maxOrder: merchant.maxOrder,
      },
    });
  } catch (error) {
    console.error('Update merchant capabilities error:', error);
    res.status(500).json({ success: false, message: 'Failed to update merchant capabilities' });
  }
});

// Get merchant earnings
router.get('/merchants/:merchantId/earnings', authenticate, isAdmin, async (req, res) => {
  try {
    const { merchantId } = req.params;
    const Merchant = mongoose.model('Merchant');
    const PaymentOrder = mongoose.model('PaymentOrder');

    const merchant = await db.merchants.getMerchant(merchantId);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    const [totalOrders, completedOrders, pendingOrders] = await Promise.all([
      PaymentOrder.countDocuments({ merchantId: merchant._id }),
      PaymentOrder.countDocuments({ merchantId: merchant._id, status: { $in: ['PAID', 'COMPLETED'] } }),
      PaymentOrder.countDocuments({ merchantId: merchant._id, status: 'PENDING' }),
    ]);
    const completedDocs = await PaymentOrder.find(
      { merchantId: merchant._id, status: { $in: ['PAID', 'COMPLETED'] } },
      { amount: 1 }
    ).lean();
    const totalVolume = completedDocs.reduce((sum, o) => sum + (o.amount || 0), 0);

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
    const Merchant   = mongoose.model('Merchant');
    const PaymentOrder   = mongoose.model('PaymentOrder');
    const merchant = await db.merchants.getMerchant(merchantId);
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });
    const [totalOrders, completedOrders, failedOrders] = await Promise.all([
      PaymentOrder.countDocuments({ merchantId: merchant._id }),
      PaymentOrder.countDocuments({ merchantId: merchant._id, status: { $in: ['PAID', 'COMPLETED'] } }),
      PaymentOrder.countDocuments({ merchantId: merchant._id, status: { $in: ['FAILED', 'CANCELLED'] } }),
    ]);
    const successRate = totalOrders > 0 ? ((completedOrders / totalOrders) * 100).toFixed(2) : 0;
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

// Approve merchant — FIX B6-a: also update Merchant.status to 'ACTIVE'
router.put('/merchants/:merchantId/approve', authenticate, isAdmin, async (req, res) => {
  try {
    const { merchantId } = req.params;
    const User     = mongoose.model('User');
    const Merchant = mongoose.model('Merchant');

    const merchant = await Merchant.findByIdAndUpdate(
      merchantId, {
        merchantApprovalStatus: 'APPROVED',
        merchantApprovedBy: req.user.userId,
        merchantApprovedAt: new Date(),
        status: 'ACTIVE',
      }, { new: true }
    );
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });

    // AUDIT FIX: isMerchant is NOT a User schema field (merchants are separate entity).
    // Merchant approval only needs to update the Merchant document status.
    
    // and does NOT need any merchant-specific flag.
    if (merchant.userId) {
      // Ensure the linked User account has roles:['merchant'] so they're excluded
      // from the player-users list in GET /api/admin/users.
      await User.findByIdAndUpdate(merchant.userId, { roles: ['merchant'] });
    }

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

    const User     = mongoose.model('User');
    const Merchant = mongoose.model('Merchant');

    const merchant = await Merchant.findByIdAndUpdate(
      merchantId, { status: 'REJECTED' }, { new: true }
    );
    if (!merchant) return res.status(404).json({ success: false, message: 'Merchant not found' });
    await mongoose.model('Merchant').findByIdAndUpdate(merchantId, {
      merchantApprovalStatus: 'REJECTED', merchantRejectionReason: reason, status: 'REJECTED',
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
    const { User } = getModels();
    const Merchant = mongoose.model('Merchant');
    const existing = await User.findOne({ mobile });
    if (existing) return res.status(409).json({ success: false, message: 'Mobile already registered' });
    const passwordHash = await hashPassword(password);
    const user = await User.create({ username, mobile, email, passwordHash, status: 'ACTIVE', roles: ['merchant'] });
    const merchant = await createMerchantWithPublicRefRetry(Merchant, {
      userId: user._id, name: username, username, mobile, email: email || undefined,
      passwordHash, password: passwordHash,
      status: 'ACTIVE', merchantApprovalStatus: 'APPROVED', tokenBalance: 0, isOnline: false, // LOW-05 FIX: auto-approve admin-created merchants
    });
    res.json({ success: true, message: 'Merchant created', merchantId: merchant._id, userId: user._id });
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
    const User = mongoose.model('User');
    const PaymentOrder = mongoose.model('PaymentOrder');
    
    const merchantDoc = await db.merchants.getMerchant(merchantId);
    if (!merchantDoc) return res.status(404).json({ success: false, message: 'Merchant not found' });
    const query = { merchantId: merchantDoc._id };
    if (type) query.type = type;
    if (status) query.status = status;
    
    const transactions = await PaymentOrder.find(query)
      .populate('userId', 'username mobile')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));
    
    const total = await PaymentOrder.countDocuments(query);
    
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

    const Merchant    = mongoose.model('Merchant');
    const Transaction = mongoose.model('Transaction');

    // merchantId = Merchant._id. Admin top-ups mint from the fixed 10B
    // treasury cap before crediting the merchant wallet. Roll back the supply
    // reservation if the wallet write fails.
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

    // Audit trail — userId = the merchant's linked User _id
    await Transaction.create([{
      userId:      merchant.userId,
      type:        'DEPOSIT',
      amount:      tokenAmountNum,
      balanceType: 'DEPOSIT',
      status:      'SUCCESS',
      description: `Admin wallet top-up: +${tokenAmountNum} tokens` + (note ? ` — ${note}` : ''),
      referenceId: req.user.userId.toString(),
      timestamp:   new Date()
    }]);

    console.log(`💳 Admin ${req.user.userId} funded merchant (userId:${merchantId}) +${tokenAmountNum} tokens → balance: ${merchant.tokenBalance}`);

    res.json({
      success:          true,
      message:          `Merchant wallet credited with ${tokenAmountNum} tokens`,
      merchantUserId:   merchantId,
      tokenAmountAdded: tokenAmountNum,
      newTokenBalance:  merchant.tokenBalance
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
    const MerchantAdminTokenOrder = mongoose.model('MerchantAdminTokenOrder');
    const { status } = req.query;
    const query = status ? { status } : {};
    const orders = await MerchantAdminTokenOrder.find(query).sort({ requestedAt: -1 }).populate('merchantId', 'name username mobile tokenBalance').lean();
    res.json({ success: true, orders });
  } catch (error) {
    console.error('GET /admin/merchant-token-orders error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch merchant token orders' });
  }
});

router.post('/merchant-token-orders/:orderId/approve', authenticate, isAdmin, async (req, res) => {
  try {
    const MerchantAdminTokenOrder = mongoose.model('MerchantAdminTokenOrder');
    const order = await MerchantAdminTokenOrder.findOneAndUpdate(
      { _id: req.params.orderId, status: 'PENDING' },
      { $set: { status: 'APPROVED', reviewedAt: new Date(), reviewedBy: req.user.userId, reviewNote: req.body.note || '' } },
      { new: true }
    );
    if (!order) return res.status(404).json({ success: false, message: 'Pending merchant token order not found' });
    let supply;
    try {
      // Keyed on the ORDER, so this endpoint is idempotent across requests as
      // well as within one: a redelivered approval mints nothing further. The
      // status guard above already refuses a second approval, but that guard
      // and this key protect different things — the guard stops the workflow
      // advancing twice, the key stops the MONEY moving twice, and a rollback
      // that reset the status (see the catch below) puts the order back in
      // reach of the guard while the mint stays spent.
      supply = await reserveAdminMint(order.tokenAmount, {
        movementId: `mint_order_${order._id}`, merchantId: String(order.merchantId),
        actor: String(req.user.userId), refModel: 'MerchantAdminTokenOrder', refId: String(order._id),
        reason: `Admin token purchase approved: ${order.orderId}`,
      });
      const { merchant } = await creditMerchantTokens({
        merchantId: order.merchantId,
        amount: order.tokenAmount,
        reason: `Admin token purchase approved: ${order.orderId}`,
        refModel: 'MerchantAdminTokenOrder',
        refId: String(order._id),
        txId: `mw_admin_purchase_${order._id}`,
      });
      return res.json({ success: true, order, merchant, supply });
    } catch (err) {
      if (supply) {
        await rollbackAdminMint(order.tokenAmount, {
          movementId: `mint_order_${order._id}`, actor: String(req.user.userId),
          refModel: 'MerchantAdminTokenOrder', refId: String(order._id),
          reason: `Admin token purchase ${order.orderId} failed after minting`,
        }).catch((e) => console.error('[admin approve] mint rollback failed:', e.message));
      }
      await MerchantAdminTokenOrder.findByIdAndUpdate(order._id, { $set: { status: 'PENDING', reviewedAt: null, reviewedBy: null, reviewNote: '' } });
      throw err;
    }
  } catch (error) {
    console.error('POST /admin/merchant-token-orders/:orderId/approve error:', error);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Failed to approve merchant token order' });
  }
});

router.post('/merchant-token-orders/:orderId/reject', authenticate, isAdmin, async (req, res) => {
  try {
    const MerchantAdminTokenOrder = mongoose.model('MerchantAdminTokenOrder');
    const order = await MerchantAdminTokenOrder.findOneAndUpdate(
      { _id: req.params.orderId, status: 'PENDING' },
      { $set: { status: 'REJECTED', reviewedAt: new Date(), reviewedBy: req.user.userId, reviewNote: req.body.reason || 'Rejected by admin' } },
      { new: true }
    );
    if (!order) return res.status(404).json({ success: false, message: 'Pending merchant token order not found' });
    res.json({ success: true, order });
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

    const Transaction = mongoose.model('Transaction');

    // Like top-ups, each deduction is a distinct admin action — fresh txId.
    const { merchant, idempotent } = await debitMerchantTokens({
      merchantId, amount: tokenAmount,
      reason: `Admin wallet deduction — ${String(reason).trim()}`,
      refModel: 'Merchant', refId: String(merchantId),
      txId: `mw_deduct_${new mongoose.Types.ObjectId().toString()}`,
      // allowOverdraft deliberately NOT set — strict $gte guard applies.
    });

    if (!merchant && !idempotent) {
      // Either the merchant doesn't exist or the balance is short — look up
      // which, so the admin gets an actionable message.
      const Merchant = mongoose.model('Merchant');
      const exists = await db.merchants.getMerchant(merchantId);
      if (!exists) {
        return res.status(404).json({ success: false, message: 'Merchant not found' });
      }
      return res.status(400).json({
        success: false,
        message: `Insufficient merchant balance: has ${exists.tokenBalance} tokens, tried to deduct ${tokenAmount}. Deductions never overdraft.`,
        tokenBalance: exists.tokenBalance,
      });
    }

    await Transaction.create([{
      userId:      merchant.userId,
      type:        'WITHDRAWAL',
      amount:      tokenAmountNum,
      balanceType: 'DEPOSIT',
      status:      'SUCCESS',
      description: `Admin wallet deduction: -${tokenAmount} tokens — ${String(reason).trim()}`,
      referenceId: req.user.userId.toString(),
      adminId:     req.user.userId.toString(),
      merchantId:  String(merchantId),
      timestamp:   new Date()
    }]);

    console.log(`💳 Admin ${req.user.userId} deducted merchant ${merchantId} -${tokenAmount} tokens → balance: ${merchant.tokenBalance}`);

    res.json({
      success:            true,
      message:            `Merchant wallet deducted by ${tokenAmount} tokens`,
      merchantUserId:     merchantId,
      tokenAmountRemoved: tokenAmount,
      newTokenBalance:    merchant.tokenBalance
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

    // ✅ FIXED: panelUrl lives on Merchant doc. Was updating User.panelUrl which is never read.
    const MerchantModel = mongoose.model('Merchant');
    const merchant = await MerchantModel.findById(merchantId);
    if (!merchant) {
      return res.status(404).json({ success: false, message: 'Merchant not found' });
    }

    merchant.panelUrl = panelUrl || '';
    await merchant.save();

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
    const Merchant   = mongoose.model('Merchant');
    const PaymentOrder   = mongoose.model('PaymentOrder');

    const merchant = await db.merchants.getMerchant(merchantId);
    if (!merchant)
      return res.status(404).json({ success: false, message: 'Merchant not found' });

    // Fixed 1:1 conversion (Phase 006 flattening, 2026-07-08): 1 token = ₹1,
    // no spread. Revenue/withdrawal figures below still come from each
    // order's stored fiatAmount, so historical orders keep their real values.
    const sellRate = 1;
    const buyRate  = 1;
    const spread   = 0;

    // Pull all COMPLETED orders for this merchant from the ledger
    const [depositOrders, withdrawalOrders, allOrders] = await Promise.all([
      // Deposits processed: user deposited → merchant gave tokens → credit user
      PaymentOrder.find(
        { merchantId: merchant._id, type: 'DEPOSIT', status: { $in: ['COMPLETED', 'PAID'] } },
        { tokenAmount: 1, fiatAmount: 1, rateUsed: 1, createdAt: 1 }
      ).lean(),
      // Withdrawals processed: user withdrew → merchant received tokens → debit user
      PaymentOrder.find(
        { merchantId: merchant._id, type: 'WITHDRAWAL', status: { $in: ['COMPLETED', 'PAID'] } },
        { tokenAmount: 1, fiatAmount: 1, rateUsed: 1, createdAt: 1 }
      ).lean(),
      PaymentOrder.find(
        { merchantId: merchant._id },
        { status: 1 }
      ).lean(),
    ]);

    // Aggregate from ledger
    const tokensAllocated = merchant.tokenBalance || 0;   // current wallet (admin-controlled)
    const tokensDeposited = depositOrders.reduce((s, o) => s + (o.tokenAmount || 0), 0);
    const tokensReturned  = withdrawalOrders.reduce((s, o) => s + (o.tokenAmount || 0), 0);

    // Revenue = INR received from COMPLETED deposit orders (user paid merchant for tokens)
    const revenue = depositOrders.reduce((s, o) => s + (o.fiatAmount || 0), 0);

    // Withdrawal exposure = INR merchant paid out on withdrawal orders
    const withdrawalExposure = withdrawalOrders.reduce((s, o) => s + (o.fiatAmount || 0), 0);

    // Funding cost = tokens given out to users × admin sell rate
    // (this is what merchant "spent" from their wallet)
    const fundingCost = tokensDeposited * sellRate;

    // Profit = Revenue - FundingCost - WithdrawalExposure
    const profit = revenue - fundingCost - withdrawalExposure;

    // ROI
    const roi = fundingCost > 0 ? ((profit / fundingCost) * 100) : 0;

    // Net user volume (total INR moved through this merchant)
    const netUserVolume = revenue + withdrawalExposure;

    // Order status breakdown
    const statusMap = {};
    for (const o of allOrders) statusMap[o.status] = (statusMap[o.status] || 0) + 1;

    res.json({
      success: true,
      data: {
        merchantId:          merchant._id,
        merchantName:        merchant.name || merchant.username || 'Unknown',
        currentTokenHoldings:tokensAllocated,
        tokensAllocated:     tokensDeposited,  // total tokens ever given to users
        tokensReturned:      tokensReturned,   // total tokens received back from withdrawals
        depositsProcessed:   depositOrders.length,
        withdrawalsProcessed:withdrawalOrders.length,
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
