// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * revenue.admin.routes.js — admin surface of the Revenue & Settlement Platform
 * (BBEPS Phase 007). Mounted at /api/admin via routes/admin/index.js.
 *
 * ORCHESTRATION ONLY: these routes read the ledger and forward admin intents
 * to revenueSettlement.service.js — every financial rule (double-entry
 * balance, idempotency, the platform-funded-only bonus rule, the
 * distributable-revenue cap) is enforced in the service, never here.
 */
import { express, mongoose, authenticate, isAdmin, isAdminOrSubAdmin } from '../../routes/admin/_adminShared.js';
import {
  getTrialBalance,
  getDistributableRevenueMinor,
  getAccountBalanceMinor,
  getLedger,
  fundMerchantBonusPool,
} from './revenueSettlement.service.js';
import { ACCOUNTS, EVENT_TYPE_LIST, toMinor, toRupees } from './chartOfAccounts.js';

const router = express.Router();

// GET /api/admin/revenue/summary — trial balance, distributable revenue,
// bonus pool balance, ledger integrity check.
router.get('/revenue/summary', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const [trial, distributableMinor, bonusPoolMinor] = await Promise.all([
      getTrialBalance(),
      getDistributableRevenueMinor(),
      getAccountBalanceMinor(ACCOUNTS.MERCHANT_BONUS_POOL.code),
    ]);

    // Rupee views are derived at the edge for display only — the ledger
    // itself is integer paise throughout.
    const accounts = Object.values(trial.accounts).map(a => ({
      ...a,
      reportedRupees: toRupees(a.reportedMinor),
    }));

    res.json({
      success: true,
      summary: {
        accounts,
        integrityOk: trial.integrityOk, // all postings across the ledger sum to 0
        distributableRevenue: toRupees(distributableMinor),
        merchantBonusPool: toRupees(bonusPoolMinor),
      },
    });
  } catch (error) {
    console.error('Revenue summary error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch revenue summary' });
  }
});

// GET /api/admin/revenue/ledger?page=&limit=&eventType= — paginated journal.
router.get('/revenue/ledger', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const { eventType } = req.query;
    if (eventType && !EVENT_TYPE_LIST.includes(eventType)) {
      return res.status(400).json({ success: false, message: `Unknown eventType. Valid: ${EVENT_TYPE_LIST.join(', ')}` });
    }
    const result = await getLedger({ page, limit, eventType });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Revenue ledger error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch ledger' });
  }
});

// POST /api/admin/revenue/bonus-pool/fund — move distributable platform
// revenue into the merchant bonus pool.
// Body: { amount (rupees), justification, idempotencyKey? }
// The service enforces: platform-funded only, capped at distributable
// revenue, justification required, append-only + idempotent.
router.post('/revenue/bonus-pool/fund', authenticate, isAdmin, async (req, res) => {
  try {
    const { amount, justification, idempotencyKey } = req.body;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'amount must be a positive number of rupees.' });
    }

    const actor = { userId: req.user._id, userName: req.user.username };
    let result;
    try {
      result = await fundMerchantBonusPool({
        amountMinor: toMinor(amount),
        actor,
        justification,
        idempotencyKey,
      });
    } catch (ruleError) {
      return res.status(400).json({ success: false, message: ruleError.message });
    }

    const EnhancedAuditLog = mongoose.model('EnhancedAuditLog');
    await EnhancedAuditLog.create({
      performedBy: req.user._id,
      performedByName: req.user.username,
      performedByRole: 'admin',
      action: 'FUND_MERCHANT_BONUS_POOL',
      category: 'FINANCIAL',
      targetType: 'AccountingEvent',
      targetId: String(result.event._id),
      details: {
        amountRupees: amount,
        idempotent: result.idempotent,
        justification,
      },
      success: true,
    });

    const [distributableMinor, bonusPoolMinor] = await Promise.all([
      getDistributableRevenueMinor(),
      getAccountBalanceMinor(ACCOUNTS.MERCHANT_BONUS_POOL.code),
    ]);

    res.json({
      success: true,
      message: result.idempotent
        ? 'Duplicate request — the original funding event was returned, nothing was recorded twice.'
        : `₹${amount.toLocaleString()} moved from distributable revenue to the merchant bonus pool.`,
      event: result.event,
      distributableRevenue: toRupees(distributableMinor),
      merchantBonusPool: toRupees(bonusPoolMinor),
    });
  } catch (error) {
    console.error('Fund bonus pool error:', error);
    res.status(500).json({ success: false, message: 'Failed to fund merchant bonus pool' });
  }
});

export default router;
