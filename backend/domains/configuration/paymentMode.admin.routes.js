// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * paymentMode.admin.routes.js — the settlement rail, and the one button that
 * moves it.
 *
 * Mounted at /api/admin via routes/admin/index.js, the same pattern as
 * depositPolicy.admin.routes.js — which is deliberate, because this is the same
 * kind of thing: an admin-editable value that governs money, versioned so an
 * auditor can answer "what was in force at time T".
 *
 * ── Why the switch is isAdmin and not isAdminOrSubAdmin ─────────────────────
 * Reading the rail is operational. Changing it changes the workflow every
 * merchant on the platform performs and what every new order asks of a player.
 * Reads are open to sub-admins; the switch is not.
 */
import { express, authenticate, isAdmin, isAdminOrSubAdmin } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
import {
  PAYMENT_MODES, getActivePolicy, getPolicyHistory, switchPaymentMode, modeCopy,
} from './paymentMode.service.js';

const router = express.Router();

/** The rails an admin may choose, with the copy the panel renders. */
const MODE_OPTIONS = Object.values(PAYMENT_MODES).map((mode) => ({
  mode, ...modeCopy(mode),
}));

// GET /api/admin/payment-mode — the rail in force, and the rails available.
router.get('/payment-mode', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const policy = await getActivePolicy();
    res.json({ success: true, policy, modes: MODE_OPTIONS });
  } catch (error) {
    console.error('Get payment mode error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch the settlement rail' });
  }
});

// GET /api/admin/payment-mode/history — every version, newest first.
router.get('/payment-mode/history', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const history = await getPolicyHistory({ limit });
    res.json({ success: true, history });
  } catch (error) {
    console.error('Get payment mode history error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch the settlement rail history' });
  }
});

/**
 * POST /api/admin/payment-mode — switch the rail, change the timers, or both.
 *
 * The service refuses with a NAMED reason rather than throwing, because every
 * one of these is an operator error with a specific answer — "that timer is
 * zero", "no link would ever be assignable" — and a 500 tells the admin
 * nothing they can act on.
 */
router.post('/payment-mode', authenticate, isAdmin, async (req, res) => {
  try {
    const { activeMode, timers = {}, justification = '' } = req.body || {};

    if (activeMode === undefined && !Object.keys(timers).length) {
      return res.status(400).json({
        success: false,
        message: 'Nothing to change: name a rail, a timer, or both.',
      });
    }

    const result = await switchPaymentMode({
      activeMode, timers, justification,
      actorId: req.user.userId, actorName: req.user.username || '',
    });

    if (!result.ok) {
      // CONCURRENT_CHANGE is not the caller's mistake — another admin saved
      // first — so it is a 409 the panel can retry, not a 400.
      const status = result.reason === 'CONCURRENT_CHANGE' ? 409 : 400;
      return res.status(status).json({ success: false, reason: result.reason, message: result.message });
    }

    // Recorded AFTER the write, with the version it produced: an audit row for
    // a change that then failed its CHECK is a record of something that never
    // happened.
    await db.audit.recordDetailed({
      performedBy: req.user.userId,
      performedByName: req.user.username,
      performedByRole: 'admin',
      action: 'SWITCH_PAYMENT_MODE',
      category: 'FINANCIAL',
      targetType: 'PaymentModePolicy',
      targetId: String(result.policy.version),
      details: {
        fromMode: result.previous?.activeMode ?? null,
        toMode: result.policy.activeMode,
        version: result.policy.version,
        timers,
        justification: result.policy.justification,
      },
    });

    res.json({ success: true, policy: result.policy, previous: result.previous });
  } catch (error) {
    console.error('Switch payment mode error:', error);
    res.status(500).json({ success: false, message: 'Failed to switch the settlement rail' });
  }
});

export default router;
