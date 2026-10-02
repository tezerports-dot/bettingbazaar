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

const router = express.Router();
const AREA = 'canManageTeams';

// GET /api/admin/teams — every supervisor, team and member (pending included).
router.get('/teams', authenticate, hasPermission(AREA), async (req, res) => {
  try {
    const [supervisors, teams, members] = await Promise.all([
      db.teams.listSupervisors(), db.teams.listTeams(), db.teams.listMembers(),
    ]);
    res.json({ success: true, supervisors, teams, members });
  } catch (err) { respondError(res, err, 'GET /admin/teams'); }
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

export default router;
