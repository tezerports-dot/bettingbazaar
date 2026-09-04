// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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

const router = express.Router();

/**
 * The permission object a sub-admin carries.
 *
 * Normalised to booleans on write. A permission stored as the string "false" is
 * truthy everywhere it is read, which turns a revoked capability back on — and
 * a JSONB column will hold whatever it is handed.
 */
function normalisePermissions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, Boolean(value)]),
  );
}

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

    const passwordHash = await hashPassword(password); // AQ-8: argon2id (was bcrypt cost 12)

    // The duplicate check is the INSERT's own conflict on the mobile's unique
    // constraint, not a read followed by a write. Reading first leaves a window
    // two simultaneous creates both pass, and the second one then fails on the
    // constraint anyway — as a 500 rather than as this message.
    const { user, created } = await db.users.createUser({
      userId: db.users.newUserId(),
      username,
      mobile,
      passwordHash,
      status: 'ACTIVE',
      // A sub-admin does not go through Aadhaar verification — staff do not
      // authenticate through Telegram at all — so the KYC gate is satisfied at
      // creation rather than left blocking a colleague on their first day.
      kycStatus: 'APPROVED',
    });
    if (!created) {
      return res.status(400).json({ success: false, message: 'Mobile number already exists' });
    }

    // The role and the permissions are a second write because they are not
    // creation columns. Both are set before the account is announced, so it is
    // never visible as a sub-admin with no permissions.
    await db.users.setRoles(user.userId, ['subadmin']);
    const subAdmin = await db.users.updateUser(user.userId, {
      isSubAdmin: true,
      subAdminPermissions: normalisePermissions(permissions),
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
    const { permissions } = req.body || {};

    const existing = await db.users.getUser(req.params.subAdminId);
    if (!existing || !existing.isSubAdmin) {
      return res.status(404).json({ success: false, message: 'Sub-admin not found' });
    }

    const subAdmin = await db.users.updateUser(req.params.subAdminId, {
      subAdminPermissions: normalisePermissions(permissions),
    });

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

    res.json({ success: true, message: 'Sub-admin removed successfully' });
  } catch (error) {
    console.error('Delete sub-admin error:', error);
    res.status(500).json({ success: false, message: 'Failed to remove sub-admin' });
  }
});

export default router;
