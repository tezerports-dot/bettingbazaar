// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * team.admin.routes.js — supervisors and teams, the admin's half
 * (PROJECT_STATUS §3.10, Step 2a). Mounted at /api/admin.
 *
 * An admin makes a merchant a supervisor on one rail, and approves or removes
 * the members supervisors propose. Supervisors create their own teams and
 * propose members from the merchant panel (team.merchant.routes.js). Every
 * change is audited, and every cap is enforced by the repository inside the
 * write (teams.js) — these handlers only translate.
 */
import { authenticate, express, hasPermission } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
import { respondError } from '../../shared/httpError.js';
import { refuse } from './teamRefusals.js';
import { resolveConsideration } from '../merchant/tradeConsideration.js';
import { DIRECTIONS as CONSIDERATION_DIRECTIONS } from '#db/repositories/adminTokenConsiderations.js';
import { paiseToRupees } from '../../shared/money.js';

const router = express.Router();
const AREA = 'canManageTeams';
// Selling tokens to a team, or buying them back, moves money: the same area
// that tops up and deducts merchant wallets (Step 2b).
const POOL_AREA = 'canFundMerchants';

// GET /api/admin/teams — every supervisor, team and member (pending included).
router.get('/teams', authenticate, hasPermission(AREA), async (req, res) => {
  try {
    const [supervisors, teams, members] = await Promise.all([
      db.teams.listSupervisors(), db.teams.listTeams(), db.teams.listMembers(),
    ]);
    res.json({ success: true, supervisors, teams, members });
  } catch (err) { respondError(res, err, 'GET /admin/teams'); }
});

// GET /api/admin/team-red-flags?days=30 — every red flag of the last `days`
// days (Step 2f): low activity per member.
router.get('/team-red-flags', authenticate, hasPermission(AREA), async (req, res) => {
  try {
    const flags = await db.teamOversight.listRedFlags({ days: Number(req.query.days) || 30, limit: 500 });
    res.json({ success: true, flags });
  } catch (err) { respondError(res, err, 'GET /admin/team-red-flags'); }
});

// PUT /api/admin/merchants/:merchantId/supervisor  { rail: 'CASH'|'UPI_BANK'|'USDT'|null }
router.put('/merchants/:merchantId/supervisor', authenticate, hasPermission(AREA), async (req, res) => {
  try {
    const rail = req.body?.rail ?? null;
    const out = await db.teams.setSupervisorRole(req.params.merchantId, { rail });
    if (!out.ok) return refuse(res, out.reason);
    await db.audit.recordDetailed({
      performedBy: req.user.userId, category: 'TEAMS', targetType: 'MERCHANT', action: rail ? 'SUPERVISOR_SET' : 'SUPERVISOR_REMOVED',
      details: { rail }, targetId: req.params.merchantId, ip: req.ip,
    });
    res.json({ success: true, message: rail ? `Now a supervisor on ${rail}.` : 'Supervisor role removed.' });
  } catch (err) { respondError(res, err, 'PUT /admin/merchants/:id/supervisor'); }
});

// POST /api/admin/team-members/:merchantId/approve
router.post('/team-members/:merchantId/approve', authenticate, hasPermission(AREA), async (req, res) => {
  try {
    const out = await db.teams.approveMember({ merchantId: req.params.merchantId, actor: req.user.userId });
    if (!out.ok) return refuse(res, out.reason);
    await db.audit.recordDetailed({
      performedBy: req.user.userId, category: 'TEAMS', targetType: 'MERCHANT', action: 'TEAM_MEMBER_APPROVED',
      details: { teamId: out.teamId }, targetId: req.params.merchantId, ip: req.ip,
    });
    res.json({ success: true, team: await db.teams.getTeam(out.teamId) });
  } catch (err) { respondError(res, err, 'POST /admin/team-members/:id/approve'); }
});

// POST /api/admin/team-members/:merchantId/reject — a pending proposal only.
router.post('/team-members/:merchantId/reject', authenticate, hasPermission(AREA), async (req, res) => {
  try {
    const out = await db.teams.removeMember({ merchantId: req.params.merchantId, onlyPending: true });
    if (!out.ok) return refuse(res, out.reason);
    await db.audit.recordDetailed({
      performedBy: req.user.userId, category: 'TEAMS', targetType: 'MERCHANT', action: 'TEAM_MEMBER_REJECTED',
      details: { teamId: out.teamId }, targetId: req.params.merchantId, ip: req.ip,
    });
    res.json({ success: true });
  } catch (err) { respondError(res, err, 'POST /admin/team-members/:id/reject'); }
});

// DELETE /api/admin/team-members/:merchantId — take an approved member out.
router.delete('/team-members/:merchantId', authenticate, hasPermission(AREA), async (req, res) => {
  try {
    const out = await db.teams.removeMember({ merchantId: req.params.merchantId });
    if (!out.ok) return refuse(res, out.reason);
    await db.audit.recordDetailed({
      performedBy: req.user.userId, category: 'TEAMS', targetType: 'MERCHANT', action: 'TEAM_MEMBER_REMOVED',
      details: { teamId: out.teamId, wasStatus: out.wasStatus }, targetId: req.params.merchantId, ip: req.ip,
    });
    res.json({ success: true, team: await db.teams.getTeam(out.teamId) });
  } catch (err) { respondError(res, err, 'DELETE /admin/team-members/:id'); }
});

// ── Team token pools (Step 2b) ───────────────────────────────────────────────

// GET /api/admin/team-pool-requests?status=PENDING
router.get('/team-pool-requests', authenticate, hasPermission(POOL_AREA), async (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;
    const requests = await db.teamPools.listRequests({ status });
    res.json({ success: true, requests });
  } catch (err) { respondError(res, err, 'GET /admin/team-pool-requests'); }
});

/**
 * POST /api/admin/team-pool-requests/:requestId/fulfil
 *   { settlementCurrency: 'INR'|'USDT', settlementAmount }
 *
 * Sells the tokens into the pool (a BUY request) or buys them back (a SELL
 * request), and records what was paid — one transaction (teamPools.js). A
 * second press, or a redelivery, finds the request no longer PENDING.
 */
router.post('/team-pool-requests/:requestId/fulfil', authenticate, hasPermission(POOL_AREA), async (req, res) => {
  try {
    const request = await db.teamPools.getRequest(req.params.requestId);
    if (!request) return refuse(res, 'request_not_found');
    const direction = request.direction === 'BUY' ? CONSIDERATION_DIRECTIONS.RECEIVED : CONSIDERATION_DIRECTIONS.PAID;
    const { currency, fiatAmountMinor, rateUsed } = await resolveConsideration(req.body, direction);
    const out = await db.teamPools.fulfilRequest({
      requestId: request.requestId, actor: req.user.userId,
      consideration: { currency, fiatAmountMinor, rateUsed },
    });
    if (!out.ok) return refuse(res, out.reason);
    await db.audit.recordDetailed({
      performedBy: req.user.userId, category: 'TREASURY', targetType: 'TEAM',
      action: request.direction === 'BUY' ? 'TEAM_POOL_SALE' : 'TEAM_POOL_BUYBACK',
      targetId: out.teamId, ip: req.ip,
      details: {
        requestId: request.requestId, tokenAmount: paiseToRupees(request.tokenAmountPaise),
        settlementCurrency: out.consideration.currency,
        settlementAmount: paiseToRupees(out.consideration.fiatAmountMinor),
        settlementInr: paiseToRupees(out.consideration.inrEquivalentPaise),
        rateUsed: out.consideration.rateUsed,
      },
    });
    res.json({
      success: true,
      message: request.direction === 'BUY'
        ? `Sold ${paiseToRupees(request.tokenAmountPaise)} tokens into the team's pool.`
        : `Bought ${paiseToRupees(request.tokenAmountPaise)} tokens back from the team's pool.`,
      pool: out.pool,
      settlement: {
        currency: out.consideration.currency,
        amount: paiseToRupees(out.consideration.fiatAmountMinor),
        inrValue: paiseToRupees(out.consideration.inrEquivalentPaise),
        rateUsed: out.consideration.rateUsed,
      },
    });
  } catch (err) { respondError(res, err, 'POST /admin/team-pool-requests/:id/fulfil'); }
});

// POST /api/admin/team-pool-requests/:requestId/reject  { reason }
router.post('/team-pool-requests/:requestId/reject', authenticate, hasPermission(POOL_AREA), async (req, res) => {
  try {
    const out = await db.teamPools.rejectRequest({
      requestId: req.params.requestId, actor: req.user.userId, reason: req.body?.reason ?? null,
    });
    if (!out.ok) return refuse(res, out.reason);
    await db.audit.recordDetailed({
      performedBy: req.user.userId, category: 'TREASURY', targetType: 'TEAM_POOL_REQUEST',
      action: 'TEAM_POOL_REQUEST_REJECTED', targetId: req.params.requestId, ip: req.ip,
      details: { reason: req.body?.reason ?? null },
    });
    res.json({ success: true });
  } catch (err) { respondError(res, err, 'POST /admin/team-pool-requests/:id/reject'); }
});

export default router;
