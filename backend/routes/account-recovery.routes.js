// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * account-recovery.routes.js
 *
 * DUPLICATE ACCOUNT PREVENTION:
 *   Aadhaar card numbers are keyed HMAC-SHA-256 hashes on KYC approval.
 *   Any attempt to register a second account with the same Aadhaar is blocked.
 *
 * ACCOUNT RECOVERY FLOW:
 *   1. User says "I lost access to my account"
 *   2. They record a short video HOLDING THEIR AADHAAR CARD clearly visible
 *   3. They provide: full name (as on Aadhaar), DOB, mobile
 *   4. Backend matches Aadhaar hash to find their account
 *   5. Admin reviews video — verifies face AND Aadhaar card details in the video
 *   6. Admin approves → system generates a temp password shown ONCE to admin
 *   7. Admin shares temp password with user
 *   8. User logs in with temp password and must change it immediately
 *
 * SECURITY:
 *   - Aadhaar stored as HMAC-SHA-256 only (one-way, can't be reversed)
 *   - temp password shown to admin ONCE then cleared from DB
 *   - Video KYC URL is required (prevents pure text-based impersonation)
 *   - Rate limited PER IP via the shared Redis store (accountRecoveryLimiter)
 *   - Responses never reveal whether an Aadhaar is registered here
 *   - All actions logged to AuditLog
 */
import express   from 'express';
import mongoose  from 'mongoose';
import crypto    from 'crypto';
import { hashAadhaar, hashAadhaarCandidates } from '../domains/identity/aadhaarHash.util.js';
// AQ-8: hash via the password authority (argon2id).
import { hashPassword } from '../domains/identity/password.util.js';
import { authenticate, isAdmin, isAdminOrSubAdmin } from '../domains/identity/auth.middleware.js';
// IP-keyed, Redis-backed limiter shared by every process on the box.
import { accountRecoveryLimiter } from '../middleware/security.js';

const router = express.Router();

// ── Helper: keyed HMAC-SHA-256 hash of a document number ─────────────────────
function hashDocument(raw) {
  return hashAadhaar(raw);
}

// ── Validate Aadhaar format: 12 digits ─────────────────────────────────────────
function isValidAadhaar(aadhaar) {
  return /^\d{12}$/.test(String(aadhaar || '').replace(/[\s-]/g, ''));
}

function generateTemporaryPassword(length = 16) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*';
  return Array.from({ length }, () => chars[crypto.randomInt(0, chars.length)]).join('');
}

// Rate limiting for these endpoints is the shared, IP-keyed
// `accountRecoveryLimiter` (middleware/security.js), applied as route
// middleware below.
//
// It replaces an in-process Map keyed on the `mobile` field FROM THE REQUEST
// BODY. That guard could be stepped around by simply varying the mobile value
// between calls — the caller picked their own counter — and it was invisible to
// the other PM2 workers and reset on every restart. It also grew without bound,
// one entry per distinct value a caller cared to send.

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC — USER-FACING ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/auth/check-aadhaar
 * Called during registration and KYC submission to detect duplicate Aadhaar.
 * Returns { exists: bool, canRecover: bool } — never returns user data.
 * Body: { aadhaarNumber }
 */
async function checkAadhaarRecovery(req, res) {
  try {
    const { aadhaarNumber } = req.body;
    if (!aadhaarNumber) return res.status(400).json({ success: false, message: 'Aadhaar number required' });
    if (!isValidAadhaar(aadhaarNumber)) return res.status(400).json({ success: false, message: 'Invalid Aadhaar format (expected: 12 digits)' });

    // Rate limiting is applied as route middleware (accountRecoveryLimiter).

    // Return neutral response regardless of account existence
    res.json({
      success: true,
      message: 'Please proceed to record your identity verification video.',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

router.post('/auth/check-aadhaar', accountRecoveryLimiter, checkAadhaarRecovery);

/**
 * POST /api/auth/recover
 * Submit an account recovery request.
 * Body: {
 *   aadhaarNumber,   -- to locate the account
 *   mobile,          -- recovery contact
 *   fullName,        -- as on Aadhaar
 *   dob,             -- YYYY-MM-DD
 *   videoKycUrl,     -- S3 CDN URL of recorded video
 *   videoKycKey,     -- S3 key (optional)
 *   selfieUrl        -- optional still selfie
 * }
 */
router.post('/auth/recover', accountRecoveryLimiter, async (req, res) => {
  try {
    const { aadhaarNumber } = req.body;
    const { mobile, fullName, dob, videoKycUrl, videoKycKey, selfieUrl } = req.body;

    // Validate required fields
    if (!aadhaarNumber || !mobile || !fullName || !dob || !videoKycUrl) {
      return res.status(400).json({ success: false, message: 'All fields required: aadhaarNumber, mobile, fullName, dob, videoKycUrl' });
    }
    if (!isValidAadhaar(aadhaarNumber)) return res.status(400).json({ success: false, message: 'Invalid Aadhaar format (12 digits)' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return res.status(400).json({ success: false, message: 'dob must be YYYY-MM-DD' });

    // Rate limiting is applied as route middleware (accountRecoveryLimiter),
    // keyed on the IP rather than on a field the caller controls.

    const User = mongoose.model('User');
    const AccountRecovery = mongoose.model('AccountRecovery');

    // Find account via Aadhaar hash. Whether this matches is NEVER revealed to
    // the caller — see the neutral response below.
    const aadhaarHashes = hashAadhaarCandidates(aadhaarNumber);
    const user = await User.findOne({ aadhaarHash: { $in: aadhaarHashes } }).select('_id mobile status').lean();

    const recoveryId = 'REC-' + crypto.randomBytes(5).toString('hex').toUpperCase();

    // ── ONE ANSWER FOR EVERY CALLER ────────────────────────────────────────
    // This endpoint takes a national identity number and used to answer
    // "no account found with this Aadhaar" — turning it into an oracle for the
    // question *does this person gamble here*, which is sensitive on its own and
    // is exactly the sort of profiling India's DPDP Act exists to prevent. The
    // reply is now identical whether or not the Aadhaar matches, whether or not
    // a review is already open, and whether or not the submission is a duplicate.
    //
    // An unmatched submission is still RECORDED (userId simply stays unset), so
    // someone who mistyped their Aadhaar reaches a human instead of vanishing
    // into a silent success — and the operator, not the endpoint, is what
    // distinguishes the cases.
    const neutral = {
      success: true,
      recoveryId,
      message: 'Recovery request submitted. If the details match an account, our team will review your Aadhaar card video within 24 hours. Make sure your Aadhaar card was clearly visible in the video.',
    };

    try {
      await AccountRecovery.create({
        recoveryId,
        userId:       user?._id,          // unset when nothing matched
        mobile:       String(mobile),
        fullName:     String(fullName).slice(0, 100),
        dob,
        aadhaarLast4: String(aadhaarNumber).slice(-4),
        videoKycUrl:  String(videoKycUrl),
        videoKycKey:  videoKycKey || '',
        selfieUrl:    selfieUrl || '',
        requestIp:    req.ip || '',
      });
    } catch (createErr) {
      // A review is already open for this account (the partial unique index).
      // That is not an error the CALLER may learn about — telling them would
      // re-open the oracle from a different angle — so it answers exactly as a
      // fresh submission does.
      if (createErr?.code !== 11000) throw createErr;
      return res.json(neutral);
    }

    // Notify admins via SSE
    global.sseManager?.broadcastToAdmins('recovery_request', { recoveryId, mobile });

    res.json(neutral);
  } catch (err) {
    console.error('Account recovery submit error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/auth/recover/status?recoveryId=REC-XXXXX
 * User can check status of their recovery request.
 */
router.get('/auth/recover/status', async (req, res) => {
  try {
    const { recoveryId } = req.query;
    if (!recoveryId) return res.status(400).json({ success: false, message: 'recoveryId required' });
    const AccountRecovery = mongoose.model('AccountRecovery');
    const req_ = await AccountRecovery.findOne({ recoveryId })
      .select('recoveryId status adminNote createdAt processedAt')
      .lean();
    if (!req_) return res.status(404).json({ success: false, message: 'Recovery request not found' });
    res.json({ success: true, request: req_ });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN — RECOVERY MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/account-recovery
 * List all recovery requests.
 */
router.get('/admin/account-recovery', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const AccountRecovery = mongoose.model('AccountRecovery');
    const { status = 'pending', page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const [requests, total] = await Promise.all([
      AccountRecovery.find({ status })
        .sort({ createdAt: -1 }).skip(skip).limit(Number(limit))
        .populate('userId', 'username mobile kycStatus')
        .populate('processedBy', 'username')
        .lean(),
      AccountRecovery.countDocuments({ status }),
    ]);
    res.json({ success: true, requests, total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/admin/account-recovery/:id/approve
 * Admin approves recovery after reviewing the video KYC.
 * System generates a temporary password and returns it ONCE.
 * Admin shares it with the user — it is never stored in plain text after this response.
 */
router.post('/admin/account-recovery/:id/approve', authenticate, isAdmin, async (req, res) => {
  try {
    const AccountRecovery = mongoose.model('AccountRecovery');
    const User            = mongoose.model('User');
    const { adminNote }   = req.body;

    // Use .select('+tempPassword') for this special route
    const recovery = await AccountRecovery.findById(req.params.id).select('+tempPassword');
    if (!recovery) return res.status(404).json({ success: false, message: 'Request not found' });
    if (recovery.status !== 'pending') return res.status(400).json({ success: false, message: 'Request is not pending' });

    // Generate a high-entropy temporary password with CSPRNG only. Math.random()
    // is not suitable for account-recovery credentials.
    const tempPw  = generateTemporaryPassword();
    const hashed  = await hashPassword(tempPw);

    // Update user: reset password, unlock account, set flag to force password change
    const user = await User.findByIdAndUpdate(
      recovery.userId,
      {
        passwordHash:        hashed,
        isAccountLocked:     false,
        status:              'ACTIVE',
        mustChangePassword:  true,    // Force password change on next login
      },
      { new: true }
    ).select('username mobile');

    if (!user) return res.status(404).json({ success: false, message: 'User account not found' });

    // Mark recovery approved — store hashed temp pw briefly for audit, clear plain text
    await AccountRecovery.findByIdAndUpdate(recovery._id, {
      status:      'approved',
      adminNote:   adminNote || 'Identity verified via video KYC',
      processedBy: req.user._id,
      processedAt: new Date(),
      // Store hash only — plain text returned in this response only, never again
      tempPassword: hashed,
    });

    // Log to audit
    try {
      const AuditLog = mongoose.model('AuditLog');
      await AuditLog.create({
        adminId:   req.user._id,
        action:    'ACCOUNT_RECOVERY_APPROVED',
        targetId:  recovery.userId,
        details:   `Recovery ${recovery.recoveryId} approved. Temp password issued.`,
      });
    } catch (_) {}

    // Return temp password — shown once to admin, then gone
    res.json({
      success:     true,
      message:     'Account recovery approved. Share the temporary password with the user.',
      username:    user.username,
      mobile:      user.mobile,
      tempPassword: tempPw,   // ← PLAIN TEXT RETURNED ONCE ONLY
      instruction: 'This temporary password is shown ONCE and not stored in plain text. Share it with the user securely and ask them to change it immediately after login.',
    });
  } catch (err) {
    console.error('Recovery approve error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/admin/account-recovery/:id/reject
 * Admin rejects recovery request — identity could not be verified.
 */
router.post('/admin/account-recovery/:id/reject', authenticate, isAdmin, async (req, res) => {
  try {
    const AccountRecovery = mongoose.model('AccountRecovery');
    const { adminNote }   = req.body;
    if (!adminNote) return res.status(400).json({ success: false, message: 'Rejection reason is required' });

    const recovery = await AccountRecovery.findById(req.params.id);
    if (!recovery) return res.status(404).json({ success: false, message: 'Not found' });
    if (recovery.status !== 'pending') return res.status(400).json({ success: false, message: 'Request is not pending' });

    await AccountRecovery.findByIdAndUpdate(recovery._id, {
      status:      'rejected',
      adminNote,
      processedBy: req.user._id,
      processedAt: new Date(),
    });

    res.json({ success: true, message: 'Recovery request rejected' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// KYC INTEGRATION — called when admin approves a user's KYC
// Hashes and stores Aadhaar for duplicate detection
// ════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/admin/kyc/link-documents
 * Called internally when admin approves KYC.
 * Hashes Aadhaar numbers and links to the user.
 * Returns { duplicate: bool } if documents already linked to another account.
 * Body: { userId, aadhaarNumber }
 */
router.post('/admin/kyc/link-documents', authenticate, isAdmin, async (req, res) => {
  try {
    const { userId, aadhaarNumber } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'userId required' });

    const User    = mongoose.model('User');
    const updates = {};
    const conflicts = [];

    if (!aadhaarNumber || !String(aadhaarNumber).trim()) {
      return res.status(400).json({ success: false, message: 'aadhaarNumber required' });
    }
    if (!isValidAadhaar(aadhaarNumber)) return res.status(400).json({ success: false, message: 'Invalid Aadhaar format' });
    const aadhaarHash = hashDocument(aadhaarNumber);
    const existing = await User.findOne({ aadhaarHash: { $in: hashAadhaarCandidates(aadhaarNumber) }, _id: { $ne: userId } }).select('_id username mobile').lean();
    if (existing) {
      conflicts.push({ type: 'AADHAAR', existingUser: { id: existing._id, username: existing.username, mobile: existing.mobile?.slice(-4).padStart(10,'*') } });
    } else {
      updates.aadhaarHash = aadhaarHash;
    }

    if (conflicts.length > 0) {
      return res.status(409).json({
        success: false,
        duplicate: true,
        conflicts,
        message: `Duplicate document detected: ${conflicts.map(c => c.type).join(', ')} already registered to another account.`,
      });
    }

    if (Object.keys(updates).length > 0) {
      await User.findByIdAndUpdate(userId, updates);
    }

    res.json({ success: true, duplicate: false, message: 'Documents linked successfully' });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, duplicate: true, message: 'This document is already linked to another account.' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
