// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * merchantAccount.admin.routes.js — the admin's half of MERCHANT ACCOUNTS
 * (owner, 2026-10-11 — Phase B of the merchants-and-agents plan). Mounted at
 * /api/admin, every route under `canManageMerchants`.
 *
 *   GET  /merchant-accounts         every merchant account with its pool,
 *                                   commission, payment accounts, sub-members
 *                                   and recent problem days
 *   POST /merchant-accounts         make an existing INR merchant one
 *   GET  /merchant-flags            the flags problems raised (they suspend nothing)
 *
 * A new merchant account is created on POST /merchants/create with
 * `kind: 'DIRECT'`; its pool requests are fulfilled on the Team pool requests
 * routes (`canFundMerchants`), like a team's.
 */
import { authenticate, express, hasPermission } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
import { respondError } from '../../shared/httpError.js';

const router = express.Router();
const AREA = 'canManageMerchants';

const REFUSED = Object.freeze({
  not_found: [404, 'No merchant has that ID.'],
  is_supervisor: [409, 'A supervisor cannot be a merchant account. Remove the supervisor role first.'],
  is_member: [409, 'That merchant is in a team. Remove them from it first.'],
});

router.get('/merchant-accounts', authenticate, hasPermission(AREA), async (req, res) => {
  try {
    const teams = await db.teams.listDirectTeams();
    const accounts = await Promise.all(teams.map(async (t) => ({
      ...t,
      accounts: await db.merchantPaymentAccounts.listAccounts(t.ownerMerchantId, { includeRemoved: true }),
      staff: await db.merchantStaff.listStaff(t.ownerMerchantId, { includeRemoved: true }),
      problemDays: await db.merchantProblems.problemDays(t.ownerMerchantId, { days: 14 }),
    })));
    res.json({ success: true, merchantAccounts: accounts });
  } catch (err) {
    respondError(res, err, 'GET /admin/merchant-accounts', { message: 'Could not load merchant accounts.' });
  }
});

router.post('/merchant-accounts', authenticate, hasPermission(AREA), async (req, res) => {
  try {
    const merchantId = String(req.body?.merchantId ?? '').trim();
    if (!merchantId) return res.status(400).json({ success: false, code: 'MERCHANT_REQUIRED', message: 'Give the merchant ID.' });
    const out = await db.teams.createDirectTeam({ merchantId, name: req.body?.name ?? null });
    if (!out.ok) {
      const [status, message] = REFUSED[out.reason] ?? [409, 'That merchant cannot be made a merchant account.'];
      return res.status(status).json({ success: false, code: out.reason, message });
    }
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'MERCHANT_ACCOUNT_CREATED', category: 'MERCHANT',
      targetType: 'Merchant', targetId: merchantId, details: { teamId: out.teamId },
    }).catch(() => {});
    res.status(out.already ? 200 : 201).json({ success: true, teamId: out.teamId, already: Boolean(out.already) });
  } catch (err) {
    respondError(res, err, 'POST /admin/merchant-accounts', { message: 'Could not make the merchant account.' });
  }
});

router.get('/merchant-flags', authenticate, hasPermission(AREA), async (req, res) => {
  try {
    const flags = await db.merchantProblems.listFlags({
      merchantId: req.query.merchantId ? String(req.query.merchantId) : null,
      days: Number(req.query.days) || 30,
    });
    res.json({ success: true, flags });
  } catch (err) {
    respondError(res, err, 'GET /admin/merchant-flags', { message: 'Could not load the flags.' });
  }
});

export default router;
