// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import express     from 'express';
// AQ-2: sign/verify via the single PASETO authority (PASETO/Ed25519, iss/aud stamped).
import { signToken, verifyJwt, decodeTokenClaims } from './domains/identity/jwt.util.js';
// AQ-8: password hashing authority (argon2id + bcrypt verify-fallback).
import { hashPassword, verifyPassword } from './domains/identity/password.util.js';
import mongoose    from 'mongoose';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
// F-3 (2026-07-10): Redis-shared counters with per-instance fallback.
import { createRateLimitStore } from './middleware/redisRateLimitStore.js';

const router = express.Router();

const registerLimiter = rateLimit({
  store: createRateLimitStore('rl:register:'),
  windowMs: 60 * 60 * 1000, max: 5,
  message: { success: false, message: 'Too many registration attempts. Try again in 1 hour.' },
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip), // AQ-6: IPv6-safe key (v8)
});

// PASETO secret + expiry are owned by paseto.util.js (imported above); importing it
// already fail-fasts on a missing secret, so no local re-declaration is needed.

// httpOnly cookie options — secure in production, lax in dev
const COOKIE_OPTS = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  maxAge:   7 * 24 * 60 * 60 * 1000,
  path:     '/',
};

// Helper — extract token from cookie OR Authorization header
function extractToken(req) {
  return req.cookies?.auth_token
    || req.headers.authorization?.replace('Bearer ', '')
    || null;
}

// ── POST /login ──────────────────────────────────────────────────────────────
export async function loginHandler(req, res) {
  // Extracted as named export — allows server.js to import directly
  // instead of splicing Express internal router stack (CRIT-05 fix).
  try {
    const { mobile, password, loginType } = req.body;
    if (!mobile || !password)
      return res.status(400).json({ success: false, message: 'Mobile and password are required' });

    const User = mongoose.model('User');
    const user = await User.findOne({ mobile: String(mobile) }).select('+passwordHash +phantomAccess');
    if (!user)
      return res.status(401).json({ success: false, message: 'Invalid credentials' });

    if (user.isAccountLocked)
      return res.status(403).json({ success: false, message: 'Account locked — recovery request pending. Contact support.' });
    if (user.status === 'BLOCKED' || user.isBlocked)
      return res.status(403).json({ success: false, message: 'Account blocked. Contact support.' });

    const { valid, needsRehash } = await verifyPassword(user.passwordHash, password);
    if (!valid)
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    // AQ-8: transparently upgrade a legacy bcrypt hash to argon2id on successful
    // login. Persisted by the existing user.save() below (lastLogin update).
    if (needsRehash) {
      try { user.passwordHash = await hashPassword(password); } catch { /* best-effort upgrade */ }
    }

    if (loginType === 'admin'         && !user.isAdmin)        return res.status(403).json({ success: false, message: 'Admin access required' });
    if (loginType === 'subadmin'      && !user.isSubAdmin)     return res.status(403).json({ success: false, message: 'Sub-admin access required' });
    if (loginType === 'queue_manager' && !user.isQueueManager) return res.status(403).json({ success: false, message: 'Queue manager access required' });

    let role = 'user';
    if (user.isAdmin)          role = 'admin';
    else if (user.isSubAdmin)  role = 'subadmin';
    else if (user.isQueueManager) role = 'queue_manager';
    else if (user.isMediator)  role = 'mediator';

    const token = signToken(
      { userId: user._id, mobile: user.mobile, role,
        isAdmin: user.isAdmin || false, isSubAdmin: user.isSubAdmin || false,
        isQueueManager: user.isQueueManager || false,
        permissions: user.subAdminPermissions || {} }
    );

    user.lastLogin = new Date();
    await user.save();

    const dep = user.depositBalance  || 0;
    const win = user.winningsBalance || 0;
    const userPayload = {
      id: user._id, _id: user._id, username: user.username, mobile: user.mobile,
      role, isAdmin: user.isAdmin || false, isSubAdmin: user.isSubAdmin || false,
      isQueueManager: user.isQueueManager || false, permissions: user.subAdminPermissions || {},
      depositBalance: dep, winningsBalance: win, lockedBalance: user.lockedBalance || 0,
      walletBalance: dep + win, kycStatus: user.kycStatus, kycData: user.kycData || null,
      bankDetails: user.bankDetails || null, profilePic: user.profilePic || '',
      status: user.status || 'ACTIVE', joinedAt: user.joinedAt || null,
      lastLogin: user.lastLogin, phantomAccess: user.phantomAccess || 'NONE',
      mustChangePassword: user.mustChangePassword || false,
    };

    res.cookie('auth_token', token, COOKIE_OPTS);
    res.json({ success: true, token, user: userPayload });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
  }
}

// Register on the router (handler is also exported for server.js admin login)
router.post('/login', loginHandler);

// ── GET /me — session restore on every page load ─────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ success: false, message: 'No token provided' });

    const decoded = verifyJwt(token);

    // Check blacklist
    try {
      const TokenBlacklist = mongoose.model('TokenBlacklist');
      const bl = await TokenBlacklist.findOne({ token }).lean();
      if (bl) return res.status(401).json({ success: false, message: 'Token invalidated. Please login again.' });
    } catch { /* model may not exist on first boot */ }

    const User = mongoose.model('User');
    const user = await User.findById(decoded.userId).select('-passwordHash');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (user.isBlocked || user.status === 'BLOCKED')
      return res.status(403).json({ success: false, message: 'Account blocked' });

    const dep = user.depositBalance  || 0;
    const win = user.winningsBalance || 0;
    res.json({
      success: true,
      user: {
        id: user._id, _id: user._id, username: user.username, mobile: user.mobile,
        role: decoded.role, isAdmin: user.isAdmin || false, isSubAdmin: user.isSubAdmin || false,
        isQueueManager: user.isQueueManager || false, permissions: user.subAdminPermissions || {},
        depositBalance: dep, winningsBalance: win, lockedBalance: user.lockedBalance || 0,
        walletBalance: dep + win, kycStatus: user.kycStatus, kycData: user.kycData || null,
        bankDetails: user.bankDetails || null, profilePic: user.profilePic || '',
        status: user.status || 'ACTIVE', joinedAt: user.joinedAt || null,
        lastLogin: user.lastLogin || null, phantomAccess: user.phantomAccess || 'NONE',
      }
    });
  } catch (e) {
    console.error('Auth check error:', e);
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
});

// ── POST /register ───────────────────────────────────────────────────────────
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { username, mobile, password, referralCode } = req.body;
    if (!username || !mobile || !password)
      return res.status(400).json({ success: false, message: 'username, mobile and password are required' });
    const cleanUsername = username.trim();
    if (cleanUsername.length < 3 || cleanUsername.length > 20)
      return res.status(400).json({ success: false, message: 'Username must be 3–20 characters' });
    if (!/^[a-zA-Z0-9_]+$/.test(cleanUsername))
      return res.status(400).json({ success: false, message: 'Username may only contain letters, numbers, and underscores' });
    if (!/^[6-9]\d{9}$/.test(mobile))
      return res.status(400).json({ success: false, message: 'Enter a valid 10-digit Indian mobile number' });
    if (password.length < 8)
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });

    const User = mongoose.model('User');
    const existing = await User.findOne({ mobile: String(mobile) });
    if (existing) return res.status(409).json({ success: false, message: 'Mobile number already registered' });

    const passwordHash = await hashPassword(password);
    const user = await User.create({ username: cleanUsername, mobile, passwordHash, status: 'ACTIVE', kycStatus: 'PENDING_SUBMISSION', roles: ['user'], referralCode: null });
    // Auto-apply referral after account created
    if (referralCode) {
      try {
        const Referral = mongoose.model('Referral');
        const crypto = await import('crypto');
        const myCode = crypto.default.createHash('sha256').update(String(user._id) + Date.now()).digest('hex').slice(0,8).toUpperCase();
        const referrerRef = await Referral.findOne({ inviteCode: referralCode.toUpperCase() });
        if (referrerRef && String(referrerRef.userId) !== String(user._id)) {
          await Referral.create({ userId: user._id, inviteCode: myCode, referredBy: referrerRef.userId, appliedCode: referralCode.toUpperCase(), appliedAt: new Date() });
          await Referral.findByIdAndUpdate(referrerRef._id, { $inc: { totalReferrals: 1 } });
        } else {
          await Referral.create({ userId: user._id, inviteCode: myCode });
        }
      } catch(refErr) { console.error('Referral apply failed:', refErr.message); }
    }

    const token = signToken(
      { userId: user._id, mobile: user.mobile, role: 'user', isAdmin: false }
    );

    const userPayload = {
      id: user._id, _id: user._id, username: cleanUsername, mobile, role: 'user',
      isAdmin: false, isSubAdmin: false, isQueueManager: false, permissions: {},
      depositBalance: 0, winningsBalance: 0, lockedBalance: 0, walletBalance: 0,
      kycStatus: user.kycStatus, kycData: null, bankDetails: null, profilePic: '',
      status: 'ACTIVE', joinedAt: user.joinedAt || null, lastLogin: null, phantomAccess: 'NONE',
    };

    res.cookie('auth_token', token, COOKIE_OPTS);
    res.json({ success: true, token, user: userPayload });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ success: false, message: 'Registration failed. Please try again.' });
  }
});

// ── POST /logout ─────────────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  try {
    const token = extractToken(req);
    if (token) {
      try {
        const TokenBlacklist = mongoose.model('TokenBlacklist');
        const decoded = decodeTokenClaims(token);
        const exp = decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 7 * 86400000);
        await TokenBlacklist.create({ token, expiresAt: exp }).catch(() => {});
      } catch { /* ignore */ }
    }
    res.clearCookie('auth_token', { path: '/' });
    res.json({ success: true, message: 'Logged out successfully' });
  } catch {
    res.json({ success: true, message: 'Logged out successfully' });
  }
});

router.get('/health', (_, res) => res.json({ success: true, status: 'ok', timestamp: new Date().toISOString() }));

export default router;
