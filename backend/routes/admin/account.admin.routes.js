// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * routes/admin/account.admin.routes.js — the signed-in staff account's own
 * authenticator (owner, 2026-10-13: staff sign in with mobile, password and an
 * authenticator app).
 *
 *   GET  /api/admin/account/2fa                  enrolled? since when? how many
 *                                                recovery codes are left. Never
 *                                                a secret.
 *   POST /api/admin/account/2fa/recovery-codes   `{ code }` — ten new recovery
 *                                                codes, shown once; needs a
 *                                                current code from the app.
 *
 * About the caller themselves, so no area (`SELF_ROUTES`, staffPermissions.js):
 * every staff account, of any role. `authenticateStaff` admits STAFF rows only.
 *
 *   GET  /api/admin/account/me                   the admin panel's session
 *                                                restore: the signed-in STAFF
 *                                                account and its roles. A
 *                                                player's or merchant's session
 *                                                is refused 403 WRONG_PANEL by
 *                                                `authenticateStaff`, so the
 *                                                panel never adopts one.
 * Replacing the authenticator itself is not here: only a full admin's reset
 * (`POST /staff/:userId/reset-authenticator`) or the break-glass script does it.
 */
import express from 'express';
import { db } from '#db';
import { authenticateStaff } from '../../domains/identity/auth.middleware.js';
import { regenerateRecoveryCodes } from '../../domains/identity/totp.service.js';
import { twoFactorLimiter } from '../../middleware/security.js';
import { respondError } from '../../shared/httpError.js';

const router = express.Router();

router.get('/account/me', authenticateStaff, (req, res) => {
  const u = req.user;
  res.json({
    success: true,
    user: {
      id: u.userId, _id: u.userId, username: u.username, mobile: u.mobile,
      accountType: u.accountType,
      isAdmin: u.isAdmin || false, isSubAdmin: u.isSubAdmin || false,
      isQueueManager: u.isQueueManager || false, isMediator: u.isMediator || false,
      permissions: u.subAdminPermissions || {},
      status: u.status || 'ACTIVE', lastLogin: u.lastLogin || null,
    },
  });
});

router.get('/account/2fa', authenticateStaff, async (req, res) => {
  try {
    const state = await db.totp.getState(req.userId);
    return res.json({ success: true, ...state });
  } catch (e) {
    return respondError(res, e, 'admin/account/2fa', { message: 'Could not read your authenticator.' });
  }
});

router.post('/account/2fa/recovery-codes', authenticateStaff, twoFactorLimiter, async (req, res) => {
  try {
    const { recoveryCodes } = await regenerateRecoveryCodes(req.user, req.body?.code);
    await db.audit.recordDetailed({
      performedBy: req.userId, performedByRole: 'staff',
      action: 'STAFF_RECOVERY_CODES_REGENERATED', category: 'SECURITY',
      targetType: 'User', targetId: req.userId,
      ip: req.ip, userAgent: req.get('user-agent') || null,
    });
    return res.json({ success: true, recoveryCodes });
  } catch (e) {
    // A wrong code here is answered 400, not the sign-in legs' 401: this
    // caller HOLDS a session, and the panel ends a held session on any 401.
    if (e?.code === 'TOTP_INVALID') e.status = 400;
    return respondError(res, e, 'admin/account/2fa/recovery-codes', { message: 'Could not make new recovery codes.' });
  }
});

export default router;
