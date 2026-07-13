// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** subadmins.admin.routes.js — Sub-admin CRUD and permissions */
import { express, mongoose, authenticate, isAdmin, getModels } from './_adminShared.js';
// AQ-8: hash via the password authority (argon2id).
import { hashPassword } from '../../domains/identity/password.util.js';

const router = express.Router();

router.get('/sub-admins', authenticate, isAdmin, async (req, res) => {
  try {
    const { User } = getModels();
    
    const subAdmins = await User.find({ isSubAdmin: true })
      .select('-passwordHash -twoFactorSecret');

    res.json({ success: true, subAdmins });
  } catch (error) {
    console.error('Get sub-admins error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch sub-admins' });
  }
});

// Create sub-admin
router.post('/sub-admins', authenticate, isAdmin, async (req, res) => {
  try {
    const { User } = getModels();
    const { username, mobile, password, permissions } = req.body;
    
    const existingUser = await User.findOne({ mobile });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'Mobile number already exists' });
    }

    const passwordHash = await hashPassword(password); // AQ-8: argon2id (was bcrypt cost 12)

    const subAdmin = await User.create({
      username,
      mobile,
      passwordHash,
      isSubAdmin: true,
      roles: ['subadmin'],
      subAdminPermissions: permissions || {},
      status: 'ACTIVE',
      kycStatus: 'APPROVED'
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
    const { User } = getModels();
    const { permissions } = req.body;
    
    const subAdmin = await User.findById(req.params.subAdminId);
    if (!subAdmin || !subAdmin.isSubAdmin) {
      return res.status(404).json({ success: false, message: 'Sub-admin not found' });
    }

    subAdmin.subAdminPermissions = permissions;
    await subAdmin.save();

    res.json({ success: true, subAdmin });
  } catch (error) {
    console.error('Update permissions error:', error);
    res.status(500).json({ success: false, message: 'Failed to update permissions' });
  }
});

// Delete sub-admin
router.delete('/sub-admins/:subAdminId', authenticate, isAdmin, async (req, res) => {
  try {
    const { User } = getModels();
    
    const subAdmin = await User.findById(req.params.subAdminId);
    if (!subAdmin || !subAdmin.isSubAdmin) {
      return res.status(404).json({ success: false, message: 'Sub-admin not found' });
    }

    subAdmin.isSubAdmin = false;
    subAdmin.roles = subAdmin.roles.filter(r => r !== 'subadmin');
    subAdmin.subAdminPermissions = {};
    await subAdmin.save();

    res.json({ success: true, message: 'Sub-admin removed successfully' });
  } catch (error) {
    console.error('Delete sub-admin error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete sub-admin' });
  }
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 🎨 BRANDING & CONTENT MANAGEMENT
 * ════════════════════════════════════════════════════════════════════════════
 */

// Get branding config
// branding routes handled in branding.admin.routes.js

export default router;
