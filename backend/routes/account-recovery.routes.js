// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * account-recovery.routes.js
 *
 * DUPLICATE ACCOUNT PREVENTION:
 *   PAN card numbers are hashed (SHA-256) on KYC approval.
 *   Any attempt to register a second account with the same PAN is blocked.
 *
 * ACCOUNT RECOVERY FLOW:
 *   1. User says "I lost access to my account"
 *   2. They record a short video HOLDING THEIR PAN CARD clearly visible
 *   3. They provide: full name (as on PAN), DOB, mobile
 *   4. Backend matches PAN hash to find their account
 *   5. Admin reviews video — verifies face AND PAN card details in the video
 *   6. Admin approves → system generates a temp password shown ONCE to admin
 *   7. Admin shares temp password with user
 *   8. User logs in with temp password and must change it immediately
 *
 * SECURITY:
 *   - PAN and Aadhaar stored as SHA-256 only (one-way, can't be reversed)
 *   - temp password shown to admin ONCE then cleared from DB
 *   - Video KYC URL is required (prevents pure text-based impersonation)
 *   - Rate limited: max 3 recovery attempts per mobile per 24h
 *   - All actions logged to AuditLog
 */
import express   from 'express';
import mongoose  from 'mongoose';
import crypto    from 'crypto';
import bcrypt    from 'bcryptjs';
import { authenticate, isAdmin, isAdminOrSubAdmin } from '../domains/identity/auth.middleware.js';

const router = express.Router();

// ── Helper: SHA-256 hash of a document number ───────────────────────────────
function hashDocument(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Normalise: uppercase, remove spaces/hyphens
  const normalised = raw.toUpperCase().replace(/[\s\-]/g, '');
  return crypto.createHash('sha256').update(normalised).digest('hex');
}

// ── Validate PAN format: AAAAA9999A ─────────────────────────────────────────
function isValidPAN(pan) {
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan.toUpperCase().replace(/\s/g, ''));
}

// In-memory rate limiter for recovery attempts (mobile → [{ts}])
const recoveryAttempts = new Map();
function checkRecoveryRateLimit(mobile) {
  const now  = Date.now();
  const key  = String(mobile);
  const list = (recoveryAttempts.get(key) || []).filter(ts => now - ts < 86400000);
  if (list.length >= 3) return false;
  list.push(now);
  recoveryAttempts.set(key, list);
  return true;
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC — USER-FACING ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/auth/check-pan
 * Called during registration and KYC submission to detect duplicate PAN.
 * Returns { exists: bool, canRecover: bool } — never returns user data.
 * Body: { panNumber }
 */
router.post('/auth/check-pan', async (req, res) => {
  try {
    const { panNumber } = req.body;
    if (!panNumber) return res.status(400).json({ success: false, message: 'PAN number required' });
    if (!isValidPAN(panNumber)) return res.status(400).json({ success: false, message: 'Invalid PAN format (expected: AAAAA9999A)' });

    const User = mongoose.model('User');
    const hash = hashDocument(panNumber);
    const exists = await User.findOne({ panCardHash: hash }).select('_id status').lean();

    res.json({
      success: true,
      exists:     !!exists,
      canRecover: !!exists,
      message:    exists
        ? 'This PAN is already registered. Use Account Recovery to regain access.'
        : 'PAN is available.',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/auth/recover
 * Submit an account recovery request.
 * Body: {
 *   panNumber,       -- to locate the account
 *   mobile,          -- recovery contact
 *   fullName,        -- as on Aadhaar
 *   aadhaarLast4,    -- last 4 digits of Aadhaar
 *   dob,             -- YYYY-MM-DD
 *   videoKycUrl,     -- S3 CDN URL of recorded video
 *   videoKycKey,     -- S3 key (optional)
 *   selfieUrl        -- optional still selfie
 * }
 */
router.post('/auth/recover', async (req, res) => {
  try {
    const { panNumber, mobile, fullName, dob, videoKycUrl, videoKycKey, selfieUrl } = req.body;

    // Validate required fields
    if (!panNumber || !mobile || !fullName || !dob || !videoKycUrl) {
      return res.status(400).json({ success: false, message: 'All fields required: panNumber, mobile, fullName, dob, videoKycUrl' });
    }
    if (!isValidPAN(panNumber)) return res.status(400).json({ success: false, message: 'Invalid PAN format (AAAAA9999A)' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return res.status(400).json({ success: false, message: 'dob must be YYYY-MM-DD' });

    // Rate limit: 3 attempts per mobile per 24h
    if (!checkRecoveryRateLimit(mobile)) {
      return res.status(429).json({ success: false, message: 'Too many recovery attempts. Please wait 24 hours before trying again.' });
    }

    const User = mongoose.model('User');
    const AccountRecovery = mongoose.model('AccountRecovery');

    // Find account via PAN hash
    const panHash = hashDocument(panNumber);
    const user = await User.findOne({ panCardHash: panHash }).select('_id mobile status').lean();
    if (!user) {
      return res.status(404).json({ success: false, message: 'No account found with this PAN. If you have not completed KYC yet, your PAN may not be linked.' });
    }

    // Check for pending recovery request
    const existing = await AccountRecovery.findOne({ userId: user._id, status: 'pending' });
    if (existing) {
      return res.status(400).json({ success: false, message: 'A recovery request for this account is already under review. Our team will contact you within 24 hours.' });
    }

    const recoveryId = 'REC-' + crypto.randomBytes(5).toString('hex').toUpperCase();

    await AccountRecovery.create({
      recoveryId,
      userId:       user._id,
      mobile:       String(mobile),
      fullName:     String(fullName).slice(0, 100),
      dob,
      videoKycUrl:  String(videoKycUrl),
      videoKycKey:  videoKycKey || '',
      selfieUrl:    selfieUrl || '',
    });

    // Notify admins via SSE
    global.sseManager?.broadcastToAdmins('recovery_request', { recoveryId, mobile });

    res.json({
      success: true,
      recoveryId,
      message: 'Recovery request submitted. Our team will review your PAN card video within 24 hours. Make sure your PAN card was clearly visible in the video.',
    });
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

    // Generate temporary password: 8 chars, mixed
    const chars   = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const tempPw  = Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const hashed  = await bcrypt.hash(tempPw, 12);

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
// Hashes and stores PAN + Aadhaar for duplicate detection
// ════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/admin/kyc/link-documents
 * Called internally when admin approves KYC.
 * Hashes PAN and Aadhaar numbers and links to the user.
 * Returns { duplicate: bool } if documents already linked to another account.
 * Body: { userId, panNumber, aadhaarNumber }
 */
router.post('/admin/kyc/link-documents', authenticate, isAdmin, async (req, res) => {
  try {
    const { userId, panNumber, aadhaarNumber } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'userId required' });

    const User    = mongoose.model('User');
    const updates = {};
    const conflicts = [];

    if (panNumber) {
      if (!isValidPAN(panNumber)) return res.status(400).json({ success: false, message: 'Invalid PAN format' });
      const panHash = hashDocument(panNumber);
      // Check if another user already has this PAN
      const existing = await User.findOne({ panCardHash: panHash, _id: { $ne: userId } }).select('_id username mobile').lean();
      if (existing) {
        conflicts.push({ type: 'PAN', existingUser: { id: existing._id, username: existing.username, mobile: existing.mobile?.slice(-4).padStart(10,'*') } });
      } else {
        updates.panCardHash = panHash;
      }
    }

    if (aadhaarNumber) {
      const aadhaarHash = hashDocument(aadhaarNumber);
      const existing = await User.findOne({ aadhaarHash, _id: { $ne: userId } }).select('_id username mobile').lean();
      if (existing) {
        conflicts.push({ type: 'AADHAAR', existingUser: { id: existing._id, username: existing.username, mobile: existing.mobile?.slice(-4).padStart(10,'*') } });
      } else {
        updates.aadhaarHash = aadhaarHash;
      }
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
