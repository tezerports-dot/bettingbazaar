// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * ownerLedger.admin.routes.js — Admin › Owner Dashboard (owner, 2026-10-22).
 * Every figure is read by `database/repositories/ownerLedger.js` and
 * `presence.js`; these routes only turn the panel's IST days into a window.
 *
 *   GET  /owner/dashboard          platform figures, VIP revenue, General
 *                                  bonuses, players online (?from=&to= days)
 *   GET  /owner/merchant-ledger    per merchant: tokens, volume, commission
 *   GET  /owner/settlements        the owner's weeks, what may be claimed,
 *                                  and every withdrawal recorded
 *   PUT  /owner/settlements/week-start   when the owner's weeks start
 *   POST /owner/settlements        record cash the owner took out
 *
 * The figures are analytics (canViewAnalytics). The settlement is the owner's
 * own money, so it is full admin only (staffPermissions.ADMIN_ONLY_AREAS).
 */
import {
  authenticate, express, hasPermission, isAdmin,
} from '../../routes/admin/_adminShared.js';
import { db } from '#db';
import { respondError } from '../../shared/httpError.js';
import { istDay } from '../../shared/istDay.js';
import { toMinor } from './chartOfAccounts.js';

const router = express.Router();

/** `from`/`to` IST days (the `to` day included whole) as timestamps; either unset is open. */
function windowOf(q) {
  const from = istDay(q.from, 'from');
  const to = istDay(q.to, 'to');
  const start = from ? new Date(`${from}T00:00:00+05:30`) : null;
  const end = to ? new Date(new Date(`${to}T00:00:00+05:30`).getTime() + 86_400_000) : null;
  return { from: start, to: end };
}

router.get('/owner/dashboard', authenticate, hasPermission('canViewAnalytics'), async (req, res) => {
  try {
    const w = windowOf(req.query);
    const [stats, vip, general, online] = await Promise.all([
      db.ownerLedger.platformStats(w),
      db.ownerLedger.vipLedger(w),
      db.ownerLedger.generalLedger(w),
      db.presence.presenceSummary(w),
    ]);
    res.json({ success: true, stats, vip, general, online });
  } catch (error) {
    respondError(res, error, 'GET /admin/owner/dashboard', { message: 'Could not read the dashboard.' });
  }
});

router.get('/owner/merchant-ledger', authenticate, hasPermission('canViewAnalytics'), async (req, res) => {
  try {
    res.json({ success: true, ...(await db.ownerLedger.merchantLedger(windowOf(req.query))) });
  } catch (error) {
    respondError(res, error, 'GET /admin/owner/merchant-ledger', { message: 'Could not read the merchant ledger.' });
  }
});

const publicSummary = ({ claimablePaise, withdrawnTotalPaise, ...rest }) => rest;

router.get('/owner/settlements', authenticate, isAdmin, async (req, res) => {
  try {
    const [summary, settlements] = await Promise.all([
      db.ownerLedger.settlementSummary(),
      db.ownerLedger.listSettlements(),
    ]);
    res.json({ success: true, ...publicSummary(summary), settlements });
  } catch (error) {
    respondError(res, error, 'GET /admin/owner/settlements', { message: 'Could not read the settlements.' });
  }
});

router.put('/owner/settlements/week-start', authenticate, isAdmin, async (req, res) => {
  try {
    const schedule = await db.ownerLedger.setSchedule(req.body?.weekStartsAt, req.user.userId);
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'OWNER_WEEK_START_SET', category: 'FINANCIAL',
      targetType: 'owner_settlement_schedule', targetId: 'main', targetName: 'Owner week start',
      details: { weekStartsAt: schedule.weekStartsAt },
      ip: req.ip, method: req.method, endpoint: req.originalUrl,
    });
    res.json({ success: true, schedule });
  } catch (error) {
    respondError(res, error, 'PUT /admin/owner/settlements/week-start', { message: 'Could not save the week start.' });
  }
});

router.post('/owner/settlements', authenticate, isAdmin, async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount)) {
      throw Object.assign(new Error('Enter how much you took out.'), { status: 400, code: 'INVALID_AMOUNT' });
    }
    const settlement = await db.ownerLedger.recordSettlement({
      amountPaise: toMinor(amount), note: req.body?.note ?? null, actor: req.user.userId,
    });
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'OWNER_PROFIT_SETTLED', category: 'FINANCIAL',
      targetType: 'owner_settlements', targetId: settlement.settlementId, targetName: 'Owner profit settlement',
      details: { amount: settlement.amount, weekStart: settlement.weekStart, note: settlement.note },
      ip: req.ip, method: req.method, endpoint: req.originalUrl,
    });
    res.status(201).json({ success: true, settlement });
  } catch (error) {
    respondError(res, error, 'POST /admin/owner/settlements', { message: 'Could not record the settlement.' });
  }
});

export default router;
