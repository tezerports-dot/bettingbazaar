// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * team.merchant.routes.js — supervisors and teams, the merchant panel's half
 * (PROJECT_STATUS §3.10, Step 2a). Mounted at /api/merchant.
 *
 * A SUPERVISOR creates up to four teams and proposes members by merchant ID;
 * an admin approves each proposal. A MEMBER sees the team they are in. Every
 * supervisor route is scoped to the session's own merchant id inside the
 * repository's WHERE — a team id from another supervisor matches no row
 * (trap 16), so there is no separate ownership check to forget.
 */
import express from 'express';
import { db } from '#db';
import { merchantAuth } from '../../middleware/merchantAuth.js';
import { respondError } from '../../shared/httpError.js';
import { refuse } from './teamRefusals.js';
import { rupeesToPaise } from '../../shared/money.js';

const router = express.Router();

const requireSupervisor = (req, res, next) => (req.merchant?.isSupervisor
  ? next()
  : refuse(res, 'not_supervisor'));

/**
 * GET /api/merchant/team — what this merchant's team screen shows.
 *   SUPERVISOR: their rail, their teams, and every member of each.
 *   MEMBER:     the team they are in (or proposed for) and its strength.
 *   NONE:       not in a team; the screen tells them their ID to hand over.
 */
router.get('/team', merchantAuth, async (req, res) => {
  try {
    const me = req.merchant;
    if (me.isSupervisor) {
      const teams = await db.teams.listTeams({ supervisorId: me.merchantId });
      const members = (await Promise.all(teams.map((t) => db.teams.listMembers({ teamId: t.teamId })))).flat();
      const poolRequests = await db.teamPools.listRequests({ supervisorId: me.merchantId, limit: 50 });
      // Team commission (Step 2e): each team's recent payments with this
      // supervisor's 16% of each, and their total across every team.
      const [commissions, myCommissionPaise] = await Promise.all([
        Promise.all(teams.map((t) => db.teamCommission.listCommissions(t.teamId, { merchantId: me.merchantId, limit: 10 })))
          .then((lists) => lists.flat()),
        db.teamCommission.earnedBy(me.merchantId),
      ]);
      return res.json({
        success: true, role: 'SUPERVISOR', rail: me.supervisorRail, publicRef: me.publicRef,
        teams, members, poolRequests, commissions, myCommissionPaise,
      });
    }
    const membership = await db.teams.membershipOf(me.merchantId);
    if (!membership) return res.json({ success: true, role: 'NONE', publicRef: me.publicRef });
    // A member sees their team's payments and their own share of each — never
    // anyone else's share (each reads only their own row).
    const [commissions, myCommissionPaise] = await Promise.all([
      db.teamCommission.listCommissions(membership.team.teamId, { merchantId: me.merchantId, limit: 10 }),
      db.teamCommission.earnedBy(me.merchantId),
    ]);
    res.json({
      success: true, role: 'MEMBER', publicRef: me.publicRef,
      status: membership.member.status, team: membership.team, commissions, myCommissionPaise,
    });
  } catch (err) { respondError(res, err, 'GET /merchant/team'); }
});

// POST /api/merchant/supervisor/teams  { name }
router.post('/supervisor/teams', merchantAuth, requireSupervisor, async (req, res) => {
  try {
    const out = await db.teams.createTeam({ supervisorId: req.merchantId, name: req.body?.name });
    if (!out.ok) return refuse(res, out.reason);
    await db.audit.recordDetailed({ performedBy: req.merchantId, category: 'TEAMS', targetType: 'TEAM', action: 'TEAM_CREATED', targetId: out.teamId, ip: req.ip });
    res.status(201).json({ success: true, team: await db.teams.getTeam(out.teamId) });
  } catch (err) { respondError(res, err, 'POST /merchant/supervisor/teams'); }
});

// PUT /api/merchant/supervisor/teams/:teamId  { name }
router.put('/supervisor/teams/:teamId', merchantAuth, requireSupervisor, async (req, res) => {
  try {
    const out = await db.teams.renameTeam({ teamId: req.params.teamId, supervisorId: req.merchantId, name: req.body?.name });
    if (!out.ok) return refuse(res, out.reason === 'not_found' ? 'team_not_found' : out.reason);
    res.json({ success: true, team: await db.teams.getTeam(req.params.teamId) });
  } catch (err) { respondError(res, err, 'PUT /merchant/supervisor/teams/:id'); }
});

// DELETE /api/merchant/supervisor/teams/:teamId — an empty team only.
router.delete('/supervisor/teams/:teamId', merchantAuth, requireSupervisor, async (req, res) => {
  try {
    const out = await db.teams.deleteTeam({ teamId: req.params.teamId, supervisorId: req.merchantId });
    if (!out.ok) return refuse(res, out.reason === 'not_found' ? 'team_not_found' : out.reason);
    await db.audit.recordDetailed({ performedBy: req.merchantId, category: 'TEAMS', targetType: 'TEAM', action: 'TEAM_DELETED', targetId: req.params.teamId, ip: req.ip });
    res.json({ success: true });
  } catch (err) { respondError(res, err, 'DELETE /merchant/supervisor/teams/:id'); }
});

// POST /api/merchant/supervisor/teams/:teamId/members  { merchantRef } — PENDING until an admin approves.
router.post('/supervisor/teams/:teamId/members', merchantAuth, requireSupervisor, async (req, res) => {
  try {
    const out = await db.teams.addMember({
      teamId: req.params.teamId, supervisorId: req.merchantId,
      merchantRef: req.body?.merchantRef, actor: req.merchantId,
    });
    if (!out.ok) return refuse(res, out.reason);
    await db.audit.recordDetailed({
      performedBy: req.merchantId, category: 'TEAMS', targetType: 'MERCHANT', action: 'TEAM_MEMBER_PROPOSED',
      details: { teamId: req.params.teamId }, targetId: out.merchantId, ip: req.ip,
    });
    res.status(201).json({ success: true, message: 'Added. An admin must approve them before they join.' });
  } catch (err) { respondError(res, err, 'POST /merchant/supervisor/teams/:id/members'); }
});

// DELETE /api/merchant/supervisor/teams/:teamId/members/:merchantId
router.delete('/supervisor/teams/:teamId/members/:merchantId', merchantAuth, requireSupervisor, async (req, res) => {
  try {
    const membership = await db.teams.membershipOf(req.params.merchantId);
    // The member must be in THIS team; the repository scopes to the supervisor.
    if (!membership || membership.team.teamId !== req.params.teamId) return refuse(res, 'not_found');
    const out = await db.teams.removeMember({ merchantId: req.params.merchantId, supervisorId: req.merchantId });
    if (!out.ok) return refuse(res, out.reason);
    await db.audit.recordDetailed({
      performedBy: req.merchantId, category: 'TEAMS', targetType: 'MERCHANT', action: 'TEAM_MEMBER_REMOVED',
      details: { teamId: out.teamId, wasStatus: out.wasStatus }, targetId: req.params.merchantId, ip: req.ip,
    });
    res.json({ success: true, team: await db.teams.getTeam(out.teamId) });
  } catch (err) { respondError(res, err, 'DELETE /merchant/supervisor/teams/:id/members/:mid'); }
});

// ── Team token pools (Step 2b) ───────────────────────────────────────────────

// GET /api/merchant/supervisor/teams/:teamId/pool — the pool and its ledger.
router.get('/supervisor/teams/:teamId/pool', merchantAuth, requireSupervisor, async (req, res) => {
  try {
    const team = await db.teams.getTeam(req.params.teamId);
    // Another supervisor's team is "not yours", never "not found" vs "forbidden" (trap 16).
    if (!team || team.supervisorId !== String(req.merchantId)) return refuse(res, 'team_not_found');
    const [pool, entries, requests] = await Promise.all([
      db.teamPools.getPool(team.teamId),
      db.teamPools.listEntries(team.teamId),
      db.teamPools.listRequests({ teamId: team.teamId }),
    ]);
    res.json({ success: true, team, pool, entries, requests });
  } catch (err) { respondError(res, err, 'GET /merchant/supervisor/teams/:id/pool'); }
});

/**
 * POST /api/merchant/supervisor/teams/:teamId/pool-requests
 *   { direction: 'BUY'|'SELL', tokenAmount, note }
 * BUY asks the platform to sell tokens into the pool; SELL asks it to buy pool
 * tokens back. An admin fulfils it after the money has changed hands.
 */
router.post('/supervisor/teams/:teamId/pool-requests', merchantAuth, requireSupervisor, async (req, res) => {
  try {
    const direction = String(req.body?.direction ?? '').toUpperCase();
    const tokens = Number(req.body?.tokenAmount);
    if (!Number.isInteger(tokens) || tokens <= 0) {
      return res.status(400).json({ success: false, code: 'bad_amount', message: 'Enter a whole number of tokens greater than zero.' });
    }
    const out = await db.teamPools.createRequest({
      teamId: req.params.teamId, supervisorId: req.merchantId, direction,
      tokenAmountPaise: rupeesToPaise(tokens), note: req.body?.note ?? null,
    });
    if (!out.ok) return refuse(res, out.reason);
    await db.audit.recordDetailed({
      performedBy: req.merchantId, category: 'TREASURY', targetType: 'TEAM',
      action: direction === 'BUY' ? 'TEAM_POOL_BUY_REQUESTED' : 'TEAM_POOL_SELL_REQUESTED',
      targetId: req.params.teamId, ip: req.ip, details: { requestId: out.requestId, tokenAmount: tokens },
    });
    res.status(201).json({
      success: true, request: await db.teamPools.getRequest(out.requestId),
      message: direction === 'BUY'
        ? 'Requested. Pay the platform, and an admin will add the tokens once the payment is confirmed.'
        : 'Requested. An admin will pay you and take the tokens out of the pool.',
    });
  } catch (err) { respondError(res, err, 'POST /merchant/supervisor/teams/:id/pool-requests'); }
});

// DELETE /api/merchant/supervisor/pool-requests/:requestId — a pending request only.
router.delete('/supervisor/pool-requests/:requestId', merchantAuth, requireSupervisor, async (req, res) => {
  try {
    const out = await db.teamPools.cancelRequest({ requestId: req.params.requestId, supervisorId: req.merchantId });
    if (!out.ok) return refuse(res, out.reason);
    res.json({ success: true });
  } catch (err) { respondError(res, err, 'DELETE /merchant/supervisor/pool-requests/:id'); }
});

export default router;
