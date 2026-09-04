// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * merchantBonusPolicy.admin.routes.js — admin management of the Merchant
 * Performance Bonus policy (Business Policy Platform).
 * Mounted at /api/admin via routes/admin/index.js.
 */
import { express, authenticate, isAdmin, isAdminOrSubAdmin } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
import {
  getActiveBonusPolicy,
  getBonusPolicyHistory,
  createBonusPolicyVersion,
  rollbackToBonusPolicyVersion,
} from './merchantBonusPolicy.service.js';

const router = express.Router();

// GET /api/admin/merchant-bonus-policy — the currently active policy.
router.get('/merchant-bonus-policy', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const policy = await getActiveBonusPolicy();
    res.json({ success: true, policy: policy || null,
      ...(policy ? {} : { message: 'No MerchantBonusPolicy configured yet — the bonus engine is idle.' }) });
  } catch (error) {
    console.error('Get merchant bonus policy error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch merchant bonus policy' });
  }
});

// GET /api/admin/merchant-bonus-policy/history — full audit trail.
router.get('/merchant-bonus-policy/history', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const history = await getBonusPolicyHistory();
    res.json({ success: true, history });
  } catch (error) {
    console.error('Get merchant bonus policy history error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch policy history' });
  }
});

// PUT /api/admin/merchant-bonus-policy — create a new version.
// Body: { enabled, bonusPercent, minMatchedVolume, justification }
router.put('/merchant-bonus-policy', authenticate, isAdmin, async (req, res) => {
  try {
    const { enabled, bonusPercent, minMatchedVolume, justification } = req.body;
    const actor = { userId: req.user.userId, userName: req.user.username };

    let doc;
    try {
      doc = await createBonusPolicyVersion({ enabled, bonusPercent, minMatchedVolume }, actor, { justification });
    } catch (validationError) {
      return res.status(400).json({ success: false, message: validationError.message });
    }

    await db.audit.recordDetailed({
      performedBy: req.user.userId,
      performedByName: req.user.username,
      performedByRole: 'admin',
      action: 'UPDATE_MERCHANT_BONUS_POLICY',
      category: 'FINANCIAL',
      targetType: 'MerchantBonusPolicy',
      targetId: doc._id.toString(),
      details: { version: doc.version, enabled: doc.enabled, bonusPercent: doc.bonusPercent,
                 minMatchedVolume: doc.minMatchedVolume, justification },
      success: true,
    });

    res.json({ success: true, message: `Merchant bonus policy v${doc.version} is ACTIVE.`, policy: doc });
  } catch (error) {
    console.error('Update merchant bonus policy error:', error);
    res.status(500).json({ success: false, message: 'Failed to update merchant bonus policy' });
  }
});

// POST /api/admin/merchant-bonus-policy/version/:versionId/rollback
router.post('/merchant-bonus-policy/version/:versionId/rollback', authenticate, isAdmin, async (req, res) => {
  try {
    const actor = { userId: req.user.userId, userName: req.user.username };
    let doc;
    try {
      doc = await rollbackToBonusPolicyVersion(req.params.versionId, actor);
    } catch (e) {
      return res.status(400).json({ success: false, message: e.message });
    }

    await db.audit.recordDetailed({
      performedBy: req.user.userId,
      performedByName: req.user.username,
      performedByRole: 'admin',
      action: 'ROLLBACK_MERCHANT_BONUS_POLICY',
      category: 'FINANCIAL',
      targetType: 'MerchantBonusPolicy',
      targetId: doc._id.toString(),
      details: { restoredAsVersion: doc.version, rollbackOfVersionId: req.params.versionId },
      success: true,
    });

    res.json({ success: true, message: `Rolled back to a new v${doc.version}.`, policy: doc });
  } catch (error) {
    console.error('Rollback merchant bonus policy error:', error);
    res.status(500).json({ success: false, message: 'Failed to roll back merchant bonus policy' });
  }
});

export default router;
