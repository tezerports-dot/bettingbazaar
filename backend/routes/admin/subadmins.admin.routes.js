// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * subadmins.admin.routes.js — sub-admin accounts and their permissions.
 *
 * A sub-admin is an ordinary account with `is_sub_admin` set and a permission
 * object attached; there is no separate table, because a second account table
 * would mean two places that answer "may this person sign in".
 *
 * Three of the four handlers here were DEAD. Two called `.save()` on a plain
 * object returned by the repository — a TypeError on every request, so changing
 * a sub-admin's permissions and removing a sub-admin both 500'd. The create
 * handler passed no user id to a table whose primary key is one.
 */
import { express, authenticate, isAdmin } from './_adminShared.js';
import { db } from '#db';
// AQ-8: hash via the password authority (argon2id).
import { hashPassword } from '../../domains/identity/password.util.js';
import { assertStaffPassword } from '../../domains/identity/passwordPolicy.js';
import {
  PERMISSION_GROUPS, STAFF_PERMISSIONS, ADMIN_ONLY_AREAS, normaliseGrant,
} from '../../domains/identity/staffPermissions.js';
import { personalStaffRoom } from '../../domains/notification/staffEventAreas.js';

const router = express.Router();

/**
 * Answer a refused grant in the caller's terms: the unknown key, by name.
 * A grant is validated against `staffPermissions.js` — the one list — so a key
 * no route asks for can never be stored, and a value that is not a boolean is
 * refused rather than coerced (the string "false" is truthy).
 */
function grantOrRefuse(res, input) {
  try {
    return normaliseGrant(input);
  } catch (e) {
    res.status(e.status || 400).json({ success: false, code: e.code, message: e.message });
    return null;
  }
}

/**
 * End every live stream this account holds, on both transports and every
 * instance. Its permissions just changed, so whatever it was sent under the old
 * grant stops now and the panel reconnects under the new one (§32 S32: a
 * permission that stops at the REST API is half a permission).
 */
function closeLiveStreams(userId) {
  try { global.sseManager?.closeAdminClientsFor(userId); } catch { /* best effort */ }
  try { global.io?.in(personalStaffRoom(userId)).disconnectSockets(true); } catch { /* best effort */ }
}

/**
 * The list an admin picks from: every grantable area, grouped, with what each
 * one opens, and the areas no sub-admin can be given and why. The panel renders
 * its picker from THIS, so there is no second list to drift (§32 S25).
 */
router.get('/staff-permissions', authenticate, isAdmin, (req, res) => {
  res.json({
    success: true,
    groups: PERMISSION_GROUPS,
    permissions: STAFF_PERMISSIONS,
    adminOnly: ADMIN_ONLY_AREAS,
  });
});

router.get('/sub-admins', authenticate, isAdmin, async (req, res) => {
  try {
    // The projection omits the password hash and the second-factor secret, so
    // the exclusion is a property of the repository rather than something each
    // route has to remember to ask for.
    const { users } = await db.users.listUsers({ isSubAdmin: true, limit: 200 });
    res.json({ success: true, subAdmins: users });
  } catch (error) {
    console.error('Get sub-admins error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch sub-admins' });
  }
});

// Create sub-admin
router.post('/sub-admins', authenticate, isAdmin, async (req, res) => {
  try {
    const { username, mobile, password, permissions } = req.body || {};
    if (!mobile || !password) {
      return res.status(400).json({ success: false, message: 'mobile and password are required' });
    }
    // Validated BEFORE the account exists, so a bad grant never leaves a
    // half-made colleague behind it.
    const grant = grantOrRefuse(res, permissions);
    if (!grant) return;

    // A sub-admin reads the player base and the ledger, and holds a session for
    // 24 hours with no second factor required of it — so the password IS the
    // credential. This took anything at all, including one character.
    try {
      assertStaffPassword(password, { mobile, username }, 'sub-admin');
    } catch (e) {
      return res.status(e.status || 400).json({ success: false, code: e.code, message: e.message });
    }

    const passwordHash = await hashPassword(password); // AQ-8: argon2id (was bcrypt cost 12)

    // The duplicate check is the INSERT's own conflict on `(mobile,
    // account_type)`, not a read followed by a write. Reading first leaves a window
    // two simultaneous creates both pass, and the second one then fails on the
    // constraint anyway — as a 500 rather than as this message.
    const { user, created } = await db.users.createUser({
      userId: db.users.newUserId(),
      username,
      mobile,
      passwordHash,
      status: 'ACTIVE',
      // STAFF. A sub-admin written as a PLAYER cannot sign in at the admin door
      // at all — the door scopes its read by account type — and the account
      // would look perfectly correct in every listing.
      accountType: 'STAFF',
    });
    if (!created) {
      // Scoped to STAFF by the unique constraint, so this now means "that
      // number already has a staff account" rather than "that number is known
      // to the platform". The same person holding a player account is no longer
      // a reason to refuse them a colleague's login.
      return res.status(400).json({ success: false, message: 'That mobile number already has a staff account' });
    }

    // The role and the permissions are a second write because they are not
    // creation columns. Both are set before the account is announced, so it is
    // never visible as a sub-admin with no permissions.
    await db.users.setRoles(user.userId, ['subadmin']);
    const subAdmin = await db.users.updateUser(user.userId, {
      isSubAdmin: true,
      subAdminPermissions: grant,
    });

    res.json({ success: true, subAdmin });
  } catch (error) {
    console.error('Create sub-admin error:', error);
    res.status(500).json({ success: false, message: 'Failed to create sub-admin' });
  }
});

// Update sub-admin permissions
router.put('/sub-admins/:subAdminId/permissions', authenticate, isAdmin, async (req, res) => {
  try {
    // ABSENT is not EMPTY. A body without `permissions` is a client that sent
    // the wrong shape — the panel did, and every save revoked everything — so
    // it is refused. Revoking everything is `{ permissions: {} }`, said aloud.
    if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'permissions')) {
      return res.status(400).json({
        success: false, code: 'PERMISSIONS_REQUIRED',
        message: 'Send the grant as { permissions: { key: true|false } }. Nothing was changed.',
      });
    }
    const grant = grantOrRefuse(res, req.body.permissions);
    if (!grant) return;

    const existing = await db.users.getUser(req.params.subAdminId);
    if (!existing || !existing.isSubAdmin) {
      return res.status(404).json({ success: false, message: 'Sub-admin not found' });
    }

    const subAdmin = await db.users.updateUser(req.params.subAdminId, {
      subAdminPermissions: grant,
    });
    await db.audit.recordDetailed({
      performedBy: req.user.userId, performedByRole: 'admin',
      action: 'SUBADMIN_PERMISSIONS_SET', category: 'USER',
      targetType: 'User', targetId: String(req.params.subAdminId),
      details: { granted: Object.keys(grant).filter((k) => grant[k]) },
    });
    // REST reads the row on every request, so the new grant already applies
    // there; the live streams were opened under the old one.
    closeLiveStreams(req.params.subAdminId);

    res.json({ success: true, subAdmin });
  } catch (error) {
    console.error('Update permissions error:', error);
    res.status(500).json({ success: false, message: 'Failed to update permissions' });
  }
});

/**
 * Remove a sub-admin.
 *
 * The ACCOUNT survives; only the elevated role is taken away. Deleting the row
 * would break every audit record that names this person as the actor, which is
 * the record an access review reads first.
 */
router.delete('/sub-admins/:subAdminId', authenticate, isAdmin, async (req, res) => {
  try {
    const existing = await db.users.getUser(req.params.subAdminId);
    if (!existing || !existing.isSubAdmin) {
      return res.status(404).json({ success: false, message: 'Sub-admin not found' });
    }

    // Both the flag and the role, because both are read as authority: the
    // middleware checks `isSubAdmin` and the role list gates individual
    // screens. Clearing one and not the other leaves a half-revoked account.
    await db.users.setRoles(
      req.params.subAdminId,
      (existing.roles || []).filter((r) => r !== 'subadmin'),
    );
    await db.users.updateUser(req.params.subAdminId, {
      isSubAdmin: false,
      subAdminPermissions: {},
    });
    closeLiveStreams(req.params.subAdminId);

    res.json({ success: true, message: 'Sub-admin removed successfully' });
  } catch (error) {
    console.error('Delete sub-admin error:', error);
    res.status(500).json({ success: false, message: 'Failed to remove sub-admin' });
  }
});

export default router;
