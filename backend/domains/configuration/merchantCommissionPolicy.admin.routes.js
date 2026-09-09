// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * merchantCommissionPolicy.admin.routes.js — admin management of the merchant
 * commission policy (Business Policy Platform): what a merchant earns, per
 * variety of work.
 * Mounted at /api/admin via routes/admin/index.js.
 */
import { express, authenticate, isAdmin, isAdminOrSubAdmin } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
import {
  getActiveCommissionPolicy,
  getCommissionPolicyHistory,
  commissionVarietyCatalogue,
  createCommissionPolicyVersion,
  rollbackToCommissionPolicyVersion,
} from './merchantCommissionPolicy.service.js';

const router = express.Router();

// GET /api/admin/merchant-commission-policy — the currently active policy.
router.get('/merchant-commission-policy', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const policy = await getActiveCommissionPolicy();
    res.json({ success: true, policy: policy || null,
      // The varieties an admin may price, from the modules that own the
      // ladders. The panel renders its picker from this rather than holding a
      // copy that would drift out of agreement with the CHECK constraint.
      varieties: commissionVarietyCatalogue(),
      ...(policy ? {} : { message: 'No merchant commission policy configured yet — the engine is idle.' }) });
  } catch (error) {
    console.error('Get merchant commission policy error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch merchant commission policy' });
  }
});

// GET /api/admin/merchant-commission-policy/history — full audit trail.
router.get('/merchant-commission-policy/history', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const history = await getCommissionPolicyHistory();
    res.json({ success: true, history });
  } catch (error) {
    console.error('Get merchant commission policy history error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch policy history' });
  }
});

// PUT /api/admin/merchant-commission-policy — create a new version.
// Body: { enabled, minMatchedVolume, rates: [{currency, paymentMode,
//         denominationPaise, buyPercent, sellPercent}], justification }
router.put('/merchant-commission-policy', authenticate, isAdmin, async (req, res) => {
  try {
    const { enabled, minMatchedVolume, rates, justification } = req.body;
    const actor = { userId: req.user.userId, userName: req.user.username };

    let doc;
    try {
      doc = await createCommissionPolicyVersion({ enabled, minMatchedVolume, rates }, actor, { justification });
    } catch (validationError) {
      return res.status(400).json({ success: false, message: validationError.message });
    }

    await db.audit.recordDetailed({
      performedBy: req.user.userId,
      performedByName: req.user.username,
      performedByRole: 'admin',
      action: 'UPDATE_MERCHANT_COMMISSION_POLICY',
      category: 'FINANCIAL',
      targetType: 'MerchantCommissionPolicy',
      targetId: doc._id.toString(),
      // The rates are the change. Recording only "how many" would leave the
      // audit trail unable to answer what a merchant was paid under, which is
      // the question this table is versioned to answer.
      details: { version: doc.version, enabled: doc.enabled,
                 minMatchedVolume: doc.minMatchedVolume, rates: doc.rates, justification },
      success: true,
    });

    res.json({ success: true, message: `Merchant commission policy v${doc.version} is ACTIVE.`, policy: doc });
  } catch (error) {
    console.error('Update merchant commission policy error:', error);
    res.status(500).json({ success: false, message: 'Failed to update merchant commission policy' });
  }
});

// POST /api/admin/merchant-commission-policy/version/:versionId/rollback
router.post('/merchant-commission-policy/version/:versionId/rollback', authenticate, isAdmin, async (req, res) => {
  try {
    const actor = { userId: req.user.userId, userName: req.user.username };
    let doc;
    try {
      doc = await rollbackToCommissionPolicyVersion(req.params.versionId, actor);
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }

    await db.audit.recordDetailed({
      performedBy: req.user.userId,
      performedByName: req.user.username,
      performedByRole: 'admin',
      action: 'ROLLBACK_MERCHANT_COMMISSION_POLICY',
      category: 'FINANCIAL',
      targetType: 'MerchantCommissionPolicy',
      targetId: doc._id.toString(),
      details: { restoredAsVersion: doc.version, rollbackOfVersionId: req.params.versionId },
      success: true,
    });

    res.json({ success: true, message: `Rolled back to a new v${doc.version}.`, policy: doc });
  } catch (error) {
    console.error('Rollback merchant commission policy error:', error);
    res.status(500).json({ success: false, message: 'Failed to roll back merchant commission policy' });
  }
});

export default router;
