// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** kyc.admin.routes.js — KYC queue, approve, reject */
import { express, mongoose, authenticate, isAdmin, isAdminOrSubAdmin, hasPermission, getModels } from './_adminShared.js';
// The KYC state machine. Every decision goes through here, so an illegal one is
// refused by the database rather than by whichever request finished last — and
// the reason and reviewer land in the fields that are actually read.
import { approveKyc, rejectKyc } from '../../domains/user/kycDecision.service.js';
import * as kycDocuments from '../../services/kycDocuments.service.js';

const router = express.Router();

router.get('/kyc/queue', authenticate, hasPermission('canVerifyKYC'), async (req, res) => {
  try {
    const { User } = getModels();

    // FIX 9: New users start with kycStatus='PENDING_SUBMISSION'. The queue was
    // filtering only PENDING_APPROVAL — so the queue always appeared empty.
    // Now we include both so admins can see all users awaiting KYC review.
    //
    // The document fields are NOT in this response. `idProofKey`/`photoKey` are
    // `select: false` on the schema so they never arrive here by default, and
    // the queue lists dozens of users at a time — shipping every reference to
    // every reviewer's browser to render two thumbnails is the shape of the
    // problem this replaced. A reviewer asks for one document, for one user,
    // and gets a grant that expires; see the review route below.
    const pendingKYC = await User.find({
      kycStatus: { $in: ['PENDING_SUBMISSION', 'PENDING_APPROVAL'] }
    })
      .select('-passwordHash -twoFactorSecret -kycData.idProofUrl -kycData.photoUrl')
      .sort({ 'kyc.submittedAt': 1, createdAt: 1 });

    res.json({ success: true, queue: pendingKYC });
  } catch (error) {
    console.error('KYC queue error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch KYC queue' });
  }
});

/**
 * GET /api/admin/kyc/:userId/document/:docType — view ONE document, once.
 *
 * The whole point of the private store. Access to an identity document is a
 * decision taken here, at review time, by an authenticated admin holding
 * `canVerifyKYC` — auditable, attributable and expiring in two minutes —
 * instead of a permanent property of a URL written into two databases.
 *
 * The grant is minted per request and never persisted, never mirrored and never
 * logged. The response carries `expiresIn` so the panel can drop the image when
 * it goes stale rather than showing a reviewer a broken tile.
 */
router.get('/kyc/:userId/document/:docType', authenticate, hasPermission('canVerifyKYC'), async (req, res) => {
  try {
    const { userId, docType } = req.params;
    if (!['id-proof', 'selfie'].includes(docType)) {
      return res.status(400).json({ success: false, message: 'Invalid KYC document type' });
    }
    if (!kycDocuments.configured()) {
      return res.status(503).json({ success: false, message: 'KYC document storage is not configured' });
    }

    const { User } = getModels();
    // Explicit opt-in: the keys are `select: false` precisely so that no other
    // route can return them by accident.
    const user = await User.findById(userId)
      .select('kycData.idProofKey kycData.photoKey +kycData.idProofKey +kycData.photoKey')
      .lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const key = docType === 'id-proof' ? user.kycData?.idProofKey : user.kycData?.photoKey;
    if (!key) {
      // A record written before the private store existed has no key. Say so
      // plainly — a reviewer who sees "not found" would otherwise assume the
      // upload failed and reject a submission that was fine.
      return res.status(404).json({
        success: false,
        message: 'No document is stored for this user. It predates the private KYC store and must be re-submitted.',
      });
    }

    // `expectedUserId` re-checks that the key read out of THIS user's record
    // really is theirs. If a mirror or a migration ever crossed two records,
    // the right answer is to refuse rather than show a reviewer the wrong ID.
    const grant = await kycDocuments.presignReview({ key, expectedUserId: String(userId) });

    try {
      await mongoose.model('EnhancedAuditLog').create({
        performedBy:     req.user._id,
        performedByName: req.user.username || req.user.mobile || 'admin',
        performedByRole: req.user.isAdmin ? 'admin' : 'subadmin',
        action:          'KYC_DOCUMENT_VIEWED',
        category:        'USER_MANAGEMENT',
        targetId:        userId,
        targetModel:     'User',
        // The key, not the grant. Recording the URL would put a live (if
        // short-lived) credential in the audit log, which is a store that by
        // design nobody deletes from.
        metadata:        { docType, key },
        success:         true,
        timestamp:       new Date(),
      });
    } catch (auditErr) {
      console.error('[KYC audit] Failed to log document view:', auditErr.message);
    }

    res.json({ success: true, url: grant.url, expiresIn: grant.expiresIn });
  } catch (error) {
    console.error('KYC document view error:', error.message);
    res.status(error.status || 500).json({ success: false, message: error.message || 'Failed to open document' });
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

    // THE DECISION IS THE GATE. This used to read the user, assign the status
    // and save — a read-modify-write on a stale read, so two reviewers acting
    // at once both passed and the last save won with no record of the other.
    //
    // The reviewer is now recorded, which it was not: `user.kyc` is not a path
    // on the User schema (only `kycData` is), so the block that set reviewedBy
    // never executed and every approval on this route was anonymous.
    const decided = await approveKyc(user._id, { actor: req.user._id });
    if (!decided.ok) {
      return res.status(409).json({
        success: false,
        message: `Cannot approve KYC from ${decided.status ?? 'unknown'} status`,
      });
    }

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
    res.json({ success: true, message: 'KYC approved successfully', user: decided.user ?? user });
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

    // The reason is REQUIRED and is written to `kycData.rejectionReason` — the
    // field domains/user/kycPublicData.js actually shows the user.
    //
    // It was assigned to `user.kyc.rejectionReason`, and the User schema has no
    // `kyc` subdocument, so the guarded block never ran and the reason was
    // dropped. Every rejected user was told they were rejected and never told
    // why, which left them unable to fix the submission and resubmit.
    if (!reason?.trim()) {
      return res.status(400).json({ success: false, message: 'A rejection reason is required — it is what the user is shown.' });
    }
    const decided = await rejectKyc(user._id, { actor: req.user._id, reason: reason.trim() });
    if (!decided.ok) {
      return res.status(409).json({
        success: false,
        message: `Cannot reject KYC from ${decided.status ?? 'unknown'} status`,
      });
    }

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

    res.json({ success: true, message: 'KYC rejected', user: decided.user ?? user });
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
