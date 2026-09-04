// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * depositPolicy.admin.routes.js — admin-facing Deposit Policy management.
 * Domain: Configuration / Business Policy Platform (BBEPS Phase 006).
 *
 * Mounted at /api/admin via routes/admin/index.js (domain-owned admin route,
 * same pattern as merchant.admin.routes.js / content.admin.routes.js).
 */
import { express, authenticate, isAdmin, isAdminOrSubAdmin } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
import {
  getActivePolicy,
  getPolicyHistory,
  createPolicyVersion,
  approvePolicyVersion,
  rollbackToPolicyVersion,
  SUPPORTED_CURRENCIES,
} from './depositPolicy.service.js';

const router = express.Router();

/**
 * A policy version is addressed by CURRENCY AND VERSION, not by a document id.
 *
 * That is what the history listing shows, what every order's snapshot records,
 * and what an operator says out loud — "roll INR back to v3". The panel
 * round-trips the `_id` the API hands it, which is this same pair rendered as
 * `INR:v3`, so the URLs are unchanged and there is exactly one way to name a
 * version.
 */
function parseVersionRef(versionId, res) {
  const match = /^([A-Za-z]+):v(\d+)$/.exec(String(versionId || ''));
  if (!match) {
    res.status(400).json({
      success: false,
      message: `Malformed version reference '${versionId}'. Expected a value from the policy history, e.g. INR:v3.`,
    });
    return null;
  }
  return { currency: match[1].toUpperCase(), version: Number(match[2]) };
}

function assertCurrency(req, res) {
  const { currency } = req.params;
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    res.status(400).json({ success: false, message: `Unsupported currency '${currency}'. Supported: ${SUPPORTED_CURRENCIES.join(', ')}` });
    return null;
  }
  return currency;
}

// GET /api/admin/deposit-policy/:currency — the currently active policy.
router.get('/deposit-policy/:currency', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const currency = assertCurrency(req, res);
    if (!currency) return;
    const policy = await getActivePolicy(currency);
    if (!policy) {
      return res.json({ success: true, policy: null, message: `No DepositPolicy configured yet for ${currency}.` });
    }
    res.json({ success: true, policy });
  } catch (error) {
    console.error('Get deposit policy error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch deposit policy' });
  }
});

// GET /api/admin/deposit-policy/:currency/history — full audit trail.
router.get('/deposit-policy/:currency/history', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const currency = assertCurrency(req, res);
    if (!currency) return;
    const history = await getPolicyHistory(currency);
    res.json({ success: true, history });
  } catch (error) {
    console.error('Get deposit policy history error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch deposit policy history' });
  }
});

// PUT /api/admin/deposit-policy/:currency — create a new version.
// Body: { depositAllocationPercent, reserveAllocationPercent,
//         reserveUsageRules, justification, effectiveAt, requireApproval }
router.put('/deposit-policy/:currency', authenticate, isAdmin, async (req, res) => {
  try {
    const currency = assertCurrency(req, res);
    if (!currency) return;

    const {
      depositAllocationPercent, reserveAllocationPercent, reserveUsageRules,
      justification, effectiveAt, requireApproval,
    } = req.body;

    if (depositAllocationPercent === undefined || reserveAllocationPercent === undefined) {
      return res.status(400).json({ success: false, message: 'depositAllocationPercent and reserveAllocationPercent are required.' });
    }
    if (!justification || !justification.trim()) {
      return res.status(400).json({ success: false, message: 'businessJustification is required for every DepositPolicy change.' });
    }

    const actor = { userId: req.user.userId, userName: req.user.username };
    let doc;
    try {
      doc = await createPolicyVersion(
        currency,
        { depositAllocationPercent, reserveAllocationPercent, reserveUsageRules },
        actor,
        { justification, effectiveAt: effectiveAt ? new Date(effectiveAt) : undefined, requireApproval: !!requireApproval }
      );
    } catch (validationError) {
      return res.status(400).json({ success: false, message: validationError.message });
    }

    await db.audit.recordDetailed({
      performedBy: req.user.userId,
      performedByName: req.user.username,
      performedByRole: 'admin',
      action: 'UPDATE_DEPOSIT_POLICY',
      category: 'FINANCIAL',
      targetType: 'DepositPolicy',
      targetId: String(doc._id),
      details: {
        currency,
        version: doc.version,
        status: doc.status,
        depositAllocationPercent: doc.depositAllocationPercent,
        reserveAllocationPercent: doc.reserveAllocationPercent,
        justification,
      },
      success: true,
    });

    // BBEPS-registered real-time event — see docs/governance/04-GOVERNANCE.md §11.
    if (global.io) global.io.emit('deposit_policy_updated', { currency, policy: doc });
    if (global.sseManager) global.sseManager.broadcast('deposit_policy_updated', { currency, policy: doc });

    res.json({ success: true, message: `Deposit policy v${doc.version} for ${currency} is ${doc.status}.`, policy: doc });
  } catch (error) {
    console.error('Update deposit policy error:', error);
    res.status(500).json({ success: false, message: 'Failed to update deposit policy' });
  }
});

// POST /api/admin/deposit-policy/version/:versionId/approve — body: { approve: boolean }
router.post('/deposit-policy/version/:versionId/approve', authenticate, isAdmin, async (req, res) => {
  try {
    const { approve = true } = req.body;
    const actor = { userId: req.user.userId, userName: req.user.username };
    let doc;
    try {
      const ref = parseVersionRef(req.params.versionId, res);
      if (!ref) return;
      doc = await approvePolicyVersion(ref, actor, !!approve);
    } catch (e) {
      return res.status(e.status || 400).json({ success: false, message: e.message });
    }

    await db.audit.recordDetailed({
      performedBy: req.user.userId,
      performedByName: req.user.username,
      performedByRole: 'admin',
      action: approve ? 'APPROVE_DEPOSIT_POLICY' : 'REJECT_DEPOSIT_POLICY',
      category: 'FINANCIAL',
      targetType: 'DepositPolicy',
      targetId: String(doc._id),
      details: { currency: doc.currency, version: doc.version, status: doc.status },
      success: true,
    });

    if (global.io) global.io.emit('deposit_policy_updated', { currency: doc.currency, policy: doc });
    if (global.sseManager) global.sseManager.broadcast('deposit_policy_updated', { currency: doc.currency, policy: doc });

    res.json({ success: true, message: `Version ${doc.version} is now ${doc.status}.`, policy: doc });
  } catch (error) {
    console.error('Approve deposit policy error:', error);
    res.status(500).json({ success: false, message: 'Failed to approve deposit policy' });
  }
});

// POST /api/admin/deposit-policy/version/:versionId/rollback
router.post('/deposit-policy/version/:versionId/rollback', authenticate, isAdmin, async (req, res) => {
  try {
    const actor = { userId: req.user.userId, userName: req.user.username };
    let doc;
    try {
      const ref = parseVersionRef(req.params.versionId, res);
      if (!ref) return;
      doc = await rollbackToPolicyVersion(ref, actor);
    } catch (e) {
      return res.status(e.status || 400).json({ success: false, message: e.message });
    }

    await db.audit.recordDetailed({
      performedBy: req.user.userId,
      performedByName: req.user.username,
      performedByRole: 'admin',
      action: 'ROLLBACK_DEPOSIT_POLICY',
      category: 'FINANCIAL',
      targetType: 'DepositPolicy',
      targetId: String(doc._id),
      details: { currency: doc.currency, restoredAsVersion: doc.version, rollbackOfVersionId: req.params.versionId },
      success: true,
    });

    if (global.io) global.io.emit('deposit_policy_updated', { currency: doc.currency, policy: doc });
    if (global.sseManager) global.sseManager.broadcast('deposit_policy_updated', { currency: doc.currency, policy: doc });

    res.json({ success: true, message: `Rolled back to a new v${doc.version} for ${doc.currency}.`, policy: doc });
  } catch (error) {
    console.error('Rollback deposit policy error:', error);
    res.status(500).json({ success: false, message: 'Failed to roll back deposit policy' });
  }
});

export default router;
