// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** kyc.admin.routes.js — KYC queue, approve, reject */
import { express, mongoose, authenticate, isAdmin, isAdminOrSubAdmin, hasPermission, getModels } from './_adminShared.js';

const router = express.Router();

router.get('/kyc/queue', authenticate, hasPermission('canVerifyKYC'), async (req, res) => {
  try {
    const { User } = getModels();
    
    // FIX 9: New users start with kycStatus='PENDING_SUBMISSION'. The queue was
    // filtering only PENDING_APPROVAL — so the queue always appeared empty.
    // Now we include both so admins can see all users awaiting KYC review.
    const pendingKYC = await User.find({
      kycStatus: { $in: ['PENDING_SUBMISSION', 'PENDING_APPROVAL'] }
    })
      .select('-passwordHash -twoFactorSecret')
      .sort({ 'kyc.submittedAt': 1, createdAt: 1 });

    res.json({ success: true, queue: pendingKYC });
  } catch (error) {
    console.error('KYC queue error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch KYC queue' });
  }
});

// Approve KYC
router.post('/kyc/:userId/approve', authenticate, hasPermission('canVerifyKYC'), async (req, res) => {
  try {
    const { User } = getModels();
    
    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    user.kycStatus = 'APPROVED';
    if (user.kyc) {
      user.kyc.reviewedBy = req.user._id;
      user.kyc.reviewedAt = new Date();
    }
    await user.save();

    // REALTIME: Notify admin room and user
    if (global.io) {
      const pendingCount = await User.countDocuments({ kycStatus: { $in: ['PENDING_SUBMISSION', 'PENDING_APPROVAL'] } });
      global.io.to('admin-room').emit('kyc_update', {
        userId: user._id,
        newStatus: 'APPROVED',
        pendingCount,
        server_ts: Date.now()
      });
      global.io.to(`user-${user._id}`).emit('user_update', {
        kycStatus: 'APPROVED',
        server_ts: Date.now()
      });
    }

    // MED-08 FIX: write audit log for KYC approval
    try {
      const EnhancedAuditLog = mongoose.model('EnhancedAuditLog');
      await EnhancedAuditLog.create({
        performedBy:     req.user._id,
        performedByName: req.user.username || req.user.mobile || 'admin',
        performedByRole: req.user.isAdmin ? 'admin' : 'subadmin',
        action:          'KYC_APPROVED',
        category:        'USER_MANAGEMENT',
        targetId:        user._id,
        targetModel:     'User',
        success:         true,
        timestamp:       new Date(),
      });
    } catch (auditErr) {
      console.error('[KYC audit] Failed to write audit log:', auditErr.message);
    }
    res.json({ success: true, message: 'KYC approved successfully', user });
  } catch (error) {
    console.error('Approve KYC error:', error);
    res.status(500).json({ success: false, message: 'Failed to approve KYC' });
  }
});

// Reject KYC
router.post('/kyc/:userId/reject', authenticate, hasPermission('canVerifyKYC'), async (req, res) => {
  try {
    const { User } = getModels();
    const { reason } = req.body;
    
    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    user.kycStatus = 'REJECTED';
    if (user.kyc) {
      user.kyc.reviewedBy = req.user._id;
      user.kyc.reviewedAt = new Date();
      user.kyc.rejectionReason = reason;
    }
    await user.save();

    // REALTIME: Notify admin room and user
    if (global.io) {
      const pendingCount = await User.countDocuments({ kycStatus: { $in: ['PENDING_SUBMISSION', 'PENDING_APPROVAL'] } });
      global.io.to('admin-room').emit('kyc_update', {
        userId: user._id,
        newStatus: 'REJECTED',
        pendingCount,
        server_ts: Date.now()
      });
      global.io.to(`user-${user._id}`).emit('user_update', {
        kycStatus: 'REJECTED',
        server_ts: Date.now()
      });
    }

    res.json({ success: true, message: 'KYC rejected', user });
  } catch (error) {
    console.error('Reject KYC error:', error);
    res.status(500).json({ success: false, message: 'Failed to reject KYC' });
  }
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 💼 SUB-ADMIN MANAGEMENT
 * ════════════════════════════════════════════════════════════════════════════
 */

// Get all sub-admins

export default router;
