// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * kyc.admin.routes.js — the KYC queue and the per-user override.
 *
 * ── What changed, and why there is no document viewer any more ───────────────
 * KYC used to mean an uploaded Aadhaar card and a selfie, presigned into a
 * private bucket and reviewed by eye. That whole path is gone. The Telegram bot
 * now captures the Aadhaar NUMBER, holds it encrypted, and verification runs in
 * bulk against the issuing authority (domains/identity/kycBulk.service.js).
 * There is nothing to look at, which is the point: the safest identity document
 * is the one never collected, and an operator who cannot open an Aadhaar card
 * cannot leak one.
 *
 * ── Why approve/reject survive the batch ────────────────────────────────────
 * The batch decides the overwhelming majority. These two remain as the
 * exception path an operator needs when a batch got one wrong or a case has to
 * be settled before the next run — the same posture licensed operators take,
 * with the manual action audited precisely because it is the unusual one. Both
 * go through the same state machine the batch does, so there is exactly one
 * place a KYC status can change.
 */
import { express, authenticate, hasPermission } from './_adminShared.js';
import { db } from '#db';
// The KYC state machine. Every decision goes through here, so an illegal one is
// refused by the database rather than by whichever request finished last — and
// the reason and reviewer land in the fields that are actually read.
import { approveKyc, rejectKyc } from '../../domains/user/kycDecision.service.js';

const router = express.Router();

/**
 * GET /api/admin/kyc/queue — who is still waiting on a verdict.
 *
 * Joined to the verification row so a reviewer can see WHY someone is
 * waiting — never submitted, exported and awaiting the verifier, or failed and
 * needing a second look — which is the only question this screen can answer now
 * that there is no document to inspect.
 *
 * The Aadhaar itself is NOT here: the query names its columns and neither the
 * ciphertext nor the hash is among them. A queue of hundreds of users is the
 * last place a national identity number should be shipped to a browser, and the
 * audited bulk export is the one path that releases them.
 */
router.get('/kyc/queue', authenticate, hasPermission('canVerifyKYC'), async (req, res) => {
  try {
    // One statement: the users awaiting a verdict, each already joined to the
    // verification row that explains why, and the total counted over the same
    // scan. It was three round trips — a user query, a verification query, and
    // a separate count — and the count described a different instant from the
    // list it labelled.
    const { queue, pendingTotal } = await db.kyc.listKycQueue({ limit: 500 });
    res.json({ success: true, queue, pendingTotal });
  } catch (error) {
    console.error('KYC queue error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch KYC queue' });
  }
});

// Approve KYC
router.post('/kyc/:userId/approve', authenticate, hasPermission('canVerifyKYC'), async (req, res) => {
  try {
    const user = await db.users.getUser(req.params.userId);
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
    const decided = await approveKyc(user.userId, { actor: req.user.userId });
    if (!decided.ok) {
      return res.status(409).json({
        success: false,
        message: `Cannot approve KYC from ${decided.status ?? 'unknown'} status`,
      });
    }

    // REALTIME: Notify admin room and user
    if (global.io) {
      const pendingCount = await db.kyc.countKycQueue();
      global.io.to('admin-room').emit('kyc_update', {
        userId: user.userId,
        newStatus: 'APPROVED',
        pendingCount,
        server_ts: Date.now()
      });
      global.io.to(`user-${user.userId}`).emit('user_update', {
        kycStatus: 'APPROVED',
        server_ts: Date.now()
      });
    }

    // MED-08 FIX: write audit log for KYC approval
    try {
      await db.audit.recordDetailed({
        performedBy:     req.user.userId,
        performedByName: req.user.username || req.user.mobile || 'admin',
        performedByRole: req.user.isAdmin ? 'admin' : 'subadmin',
        action:          'KYC_APPROVED',
        category:        'USER_MANAGEMENT',
        targetId:        user.userId,
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
    const { reason } = req.body;

    const user = await db.users.getUser(req.params.userId);
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
    const decided = await rejectKyc(user.userId, { actor: req.user.userId, reason: reason.trim() });
    if (!decided.ok) {
      return res.status(409).json({
        success: false,
        message: `Cannot reject KYC from ${decided.status ?? 'unknown'} status`,
      });
    }

    // REALTIME: Notify admin room and user
    if (global.io) {
      const pendingCount = await db.kyc.countKycQueue();
      global.io.to('admin-room').emit('kyc_update', {
        userId: user.userId,
        newStatus: 'REJECTED',
        pendingCount,
        server_ts: Date.now()
      });
      global.io.to(`user-${user.userId}`).emit('user_update', {
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
