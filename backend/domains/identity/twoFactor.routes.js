// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/identity/twoFactor.routes.js — enrolment and management of TOTP 2FA.
 *
 * Covers every account held in the User collection: players, admins and
 * sub-admins (they differ by `role`/`roles`, not by model).
 *
 * ── The enrolment handshake, and why it has two steps ──────────────────────
 *   POST /api/2fa/setup     → mints a secret, stores it as PENDING, returns the
 *                             otpauth:// URI for the panel to render as a QR
 *   POST /api/2fa/activate  → the user types a code from their app; only if it
 *                             verifies does the secret become live
 *
 * The pending/live split is the whole point. If `setup` enabled 2FA
 * immediately, anyone who closed the tab before scanning — or scanned into an
 * app they then deleted — would own an account that demands codes from an
 * authenticator entry that does not exist. For a player that is a support
 * ticket. For the main admin it is an unrecoverable lockout of the platform's
 * own operator, with nobody above them to reset it.
 *
 * ── Recovery codes are issued at activation, once ──────────────────────────
 * Shown exactly one time, stored only as hashes. This is not a nicety: 2FA is
 * mandatory for privileged roles, so a lost handset without recovery codes is
 * the same unrecoverable lockout by a different route.
 */
import express from 'express';
import { db } from '#db';
import { authenticate } from './auth.middleware.js';
import { twoFactorLimiter } from '../../middleware/security.js';
import {
  generateSecret, buildOtpauthUri, encryptSecret, decryptSecret,
  verifyToken, generateBackupCodes, hashBackupCode,
} from './totp.service.js';

const router = express.Router();

/** Roles for which 2FA is mandatory rather than optional. */
const MANDATORY_2FA_ROLES = new Set(['admin', 'subadmin']);

/**
 * Does this account have to hold a second factor?
 *
 * `isAdmin` / `isSubAdmin` are checked FIRST and are authoritative, because
 * that is what the login handler and route guards actually use to grant
 * privilege. Deriving this from `roles` alone was a real hole: an account with
 * `isAdmin: true` and the default `roles: ['user']` — which is how externally
 * created or older admin documents look — would be reported as non-mandatory
 * and allowed to switch its own 2FA off, while the rest of the application
 * treated it as an admin. The policy has to key on the same field the
 * privilege does, or it is guarding a different account than it thinks.
 */
export function requires2FA(user) {
  if (!user) return false;
  if (user.isAdmin === true || user.isSubAdmin === true) return true;
  const roles = [user.role, ...(user.roles || [])].filter(Boolean);
  return roles.some((r) => MANDATORY_2FA_ROLES.has(String(r).toLowerCase()));
}

/** The effective role name, from the same flags the login handler trusts. */
function effectiveRole(user) {
  if (user.isAdmin === true) return 'admin';
  if (user.isSubAdmin === true) return 'subadmin';
  const roles = [user.role, ...(user.roles || [])].filter(Boolean).map((r) => String(r).toLowerCase());
  return roles.find((r) => MANDATORY_2FA_ROLES.has(r)) || 'user';
}

/** A label that tells the user WHICH account a code belongs to, in their app. */
function accountLabel(user) {
  // `email` was removed from User on 2026-08-26; mobile is the identity.
  const who = user.mobile || String(user._id);
  // effectiveRole, not user.role — the schema has no singular `role` field, so
  // reading it gave every admin an unlabelled entry indistinguishable from
  // their player account in the same authenticator app.
  const role = effectiveRole(user);
  return role === 'user' ? who : `${role}:${who}`;
}

// ── Status ──────────────────────────────────────────────────────────────────
router.get('/status', authenticate, async (req, res) => {
  const user = await db.users.getUser(req.user.userId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  return res.json({
    success: true,
    enabled: !!user.twoFactorEnabled,
    mandatory: requires2FA(user),
    enrolledAt: user.twoFactorEnrolledAt || null,
    backupCodesRemaining: (user.backupCodes || []).length,
  });
});

// ── Step 1: mint a pending secret and hand back a scannable URI ─────────────
router.post('/setup', authenticate, async (req, res) => {
  const user = await db.users.getUser(req.user.userId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  if (user.twoFactorEnabled) {
    // Re-enrolling silently would invalidate the authenticator the account is
    // currently protected by, so it has to be an explicit disable first.
    return res.status(409).json({
      success: false,
      code: '2FA_ALREADY_ENABLED',
      message: 'Two-factor authentication is already active. Disable it first to re-enrol.',
    });
  }

  const secret = generateSecret();
  user.twoFactorPendingSecret = encryptSecret(secret);
  await user.save();

  return res.json({
    success: true,
    // Both forms: the QR for scanning, and the raw secret for the "can't scan?"
    // path that every authenticator flow needs.
    otpauthUri: buildOtpauthUri({ secret, label: accountLabel(user) }),
    secret,
    message: 'Scan the QR code, then confirm with a code from your authenticator app.',
  });
});

// ── Step 2: prove the app was actually added, then go live ─────────────────
router.post('/activate', authenticate, twoFactorLimiter, async (req, res) => {
  const user = await db.users.getUser(req.user.userId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  if (!user.twoFactorPendingSecret) {
    return res.status(400).json({
      success: false, code: '2FA_NO_PENDING_SETUP',
      message: 'Start with /api/2fa/setup before activating.',
    });
  }

  const secret = decryptSecret(user.twoFactorPendingSecret);
  const result = verifyToken({ secret, token: req.body?.otp });
  if (!result.valid) {
    return res.status(400).json({
      success: false, code: '2FA_INVALID_CODE',
      message: 'That code is not valid. Check your authenticator app and try again.',
    });
  }

  // Only now does the secret become the thing that guards the account.
  const backupCodes = generateBackupCodes();
  user.twoFactorSecret = user.twoFactorPendingSecret;
  user.twoFactorPendingSecret = undefined;
  user.twoFactorEnabled = true;
  user.twoFactorLastCounter = result.counter;
  user.twoFactorEnrolledAt = new Date();
  user.backupCodes = backupCodes.map(hashBackupCode);
  await user.save();

  return res.json({
    success: true,
    message: 'Two-factor authentication is now active.',
    // The ONLY time these are ever readable. Stored as hashes from here on, so
    // there is no path — for the user or for support — to see them again.
    backupCodes,
    warning: 'Save these recovery codes now. They are shown once and cannot be retrieved later.',
  });
});

// ── Disable ─────────────────────────────────────────────────────────────────
router.post('/disable', authenticate, twoFactorLimiter, async (req, res) => {
  const user = await db.users.getUser(req.user.userId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  if (requires2FA(user)) {
    // An admin who can switch off their own second factor does not have one in
    // any meaningful sense — the control would be advisory.
    return res.status(403).json({
      success: false, code: '2FA_MANDATORY',
      message: 'Two-factor authentication is mandatory for this role and cannot be disabled.',
    });
  }
  if (!user.twoFactorEnabled) {
    return res.json({ success: true, message: 'Two-factor authentication is already off.' });
  }

  // Turning it off is itself a privileged action: require a current code, so a
  // hijacked session cannot quietly strip the protection it is meant to defeat.
  const secret = decryptSecret(user.twoFactorSecret);
  const result = verifyToken({
    secret, token: req.body?.otp, lastCounter: user.twoFactorLastCounter ?? null,
  });
  if (!result.valid) {
    return res.status(400).json({
      success: false, code: '2FA_INVALID_CODE',
      message: 'Enter a current code from your authenticator app to turn off 2FA.',
    });
  }

  user.twoFactorEnabled = false;
  user.twoFactorSecret = undefined;
  user.twoFactorPendingSecret = undefined;
  user.twoFactorLastCounter = undefined;
  user.twoFactorEnrolledAt = undefined;
  user.backupCodes = [];
  await user.save();

  return res.json({ success: true, message: 'Two-factor authentication disabled.' });
});

export default router;
