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
import { buildPublicKycData } from './domains/user/kycPublicData.js';
import { issueChallenge, verifyChallenge, CHALLENGE_AUDIENCE } from './domains/identity/twoFactorChallenge.js';
import { verifySecondFactor, SECOND_FACTOR_RESULT } from './domains/identity/verifySecondFactor.js';
import { generateSecret, encryptSecret, buildOtpauthUri } from './domains/identity/totp.service.js';
import { twoFactorLimiter } from './middleware/security.js';
// Bot-mitigation challenge. Applied to the credential-submitting routes only —
// never to /me or /logout, which every page load and sign-out depend on.
import { requireCaptcha } from './middleware/captcha.js';

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

    // ── Second factor ────────────────────────────────────────────────────
    // The password is correct, but for an enrolled account that is only half
    // the login. Issue a short-lived challenge INSTEAD of a session token and
    // stop here. `issueSession` below is unreachable until /login/2fa
    // redeems that challenge with a valid code.
    if (user.twoFactorEnabled) {
      return res.status(200).json({
        success: false,               // deliberately NOT a logged-in success
        twoFactorRequired: true,
        challengeToken: issueChallenge({
          id: user._id,
          audience: CHALLENGE_AUDIENCE.USER,
          loginType: loginType || null,   // re-applied on redemption
        }),
        message: 'Enter the code from your authenticator app.',
      });
    }

    return issueSession(user, res);
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
  }
}

/**
 * Mint the session and build the client payload.
 *
 * Extracted so the password-only path and the post-OTP path cannot drift:
 * a second factor must change WHEN you get a session, never WHAT it contains.
 * Two copies of this would be a standing invitation for the 2FA branch to
 * quietly grant different claims than the normal one.
 */
export async function issueSession(user, res) {
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
    walletBalance: dep + win, kycStatus: user.kycStatus,
    kycData: buildPublicKycData(user),
    bankDetails: user.bankDetails || null, profilePic: user.profilePic || '',
    status: user.status || 'ACTIVE', joinedAt: user.joinedAt || null,
    lastLogin: user.lastLogin, phantomAccess: user.phantomAccess || 'NONE',
    mustChangePassword: user.mustChangePassword || false,
    twoFactorEnabled: user.twoFactorEnabled || false,
  };

  res.cookie('auth_token', token, COOKIE_OPTS);
  return res.json({ success: true, token, user: userPayload });
}

/**
 * POST /login/2fa — redeem a challenge with an OTP or a recovery code.
 *
 * Re-loads and re-checks the account rather than trusting anything cached in
 * the challenge: between the two legs an admin may have blocked the user, or
 * the account may have been locked. The challenge proves the password was
 * right five minutes ago, nothing more.
 */
export async function loginTwoFactorHandler(req, res) {
  try {
    const { challengeToken, code } = req.body;
    if (!challengeToken || !code) {
      return res.status(400).json({ success: false, message: 'Challenge token and code are required' });
    }

    const challenge = verifyChallenge(challengeToken, CHALLENGE_AUDIENCE.USER);
    if (!challenge) {
      return res.status(401).json({ success: false, twoFactorExpired: true,
        message: 'Login session expired. Please sign in again.' });
    }

    const User = mongoose.model('User');
    const user = await User.findById(challenge.id)
      .select('+twoFactorSecret +twoFactorLastCounter +backupCodes +phantomAccess');
    if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    // Re-check the same gates the password leg applied — state can change
    // between the two requests.
    if (user.isAccountLocked)
      return res.status(403).json({ success: false, message: 'Account locked — recovery request pending. Contact support.' });
    if (user.status === 'BLOCKED' || user.isBlocked)
      return res.status(403).json({ success: false, message: 'Account blocked. Contact support.' });

    const t = challenge.loginType;
    if (t === 'admin'         && !user.isAdmin)        return res.status(403).json({ success: false, message: 'Admin access required' });
    if (t === 'subadmin'      && !user.isSubAdmin)     return res.status(403).json({ success: false, message: 'Sub-admin access required' });
    if (t === 'queue_manager' && !user.isQueueManager) return res.status(403).json({ success: false, message: 'Queue manager access required' });

    const verdict = await verifySecondFactor(user, code);
    if (!verdict.ok) {
      if (verdict.result === SECOND_FACTOR_RESULT.MALFORMED_SECRET) {
        // Nothing the user types can succeed — do not send them in circles.
        console.error(`🚨 2FA secret undecryptable for user ${user._id} — check TOTP_ENCRYPTION_KEY`);
        return res.status(500).json({ success: false,
          message: 'Two-factor verification is misconfigured on the server. Contact support.' });
      }
      return res.status(401).json({ success: false, message: 'Invalid authentication code' });
    }

    if (verdict.usedBackupCode) {
      console.warn(`🔐 Recovery code used for user ${user._id} — ${verdict.backupCodesRemaining} remaining`);
    }
    const response = await issueSession(user, res);
    return response;
  } catch (e) {
    console.error('2FA login error:', e);
    res.status(500).json({ success: false, message: 'Login failed. Please try again.' });
  }
}

// Register on the router (handlers are also exported for server.js admin login)
router.post('/login', requireCaptcha('login'), loginHandler);
router.post('/login/2fa', twoFactorLimiter, loginTwoFactorHandler);

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
        walletBalance: dep + win, kycStatus: user.kycStatus,
        kycData: buildPublicKycData(user),
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
router.post('/register', registerLimiter, requireCaptcha('register'), async (req, res) => {
  try {
    const { username, mobile, password, enable2FA } = req.body;
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
    const user = await User.create({ username: cleanUsername, mobile, passwordHash, status: 'ACTIVE', kycStatus: 'PENDING_SUBMISSION', roles: ['user'] });
    const token = signToken(
      { userId: user._id, mobile: user.mobile, role: 'user', isAdmin: false }
    );

    const userPayload = {
      id: user._id, _id: user._id, username: cleanUsername, mobile, role: 'user',
      isAdmin: false, isSubAdmin: false, isQueueManager: false, permissions: {},
      depositBalance: 0, winningsBalance: 0, lockedBalance: 0, walletBalance: 0,
      kycStatus: user.kycStatus, kycData: null, bankDetails: null, profilePic: '',
      status: 'ACTIVE', joinedAt: user.joinedAt || null, lastLogin: null, phantomAccess: 'NONE',
      twoFactorEnabled: false,
    };

    // ── Optional 2FA opt-in at signup ────────────────────────────────────
    // For players 2FA is a choice, not a requirement. Opting in here mints a
    // PENDING secret and returns the otpauth URI so the panel can show the QR
    // straight away, while the account stays fully usable. It only becomes
    // live — and only then is a code demanded at every login — once the user
    // proves they scanned it via POST /api/2fa/activate.
    //
    // Enabling it here instead would be the lockout trap the enrolment
    // handshake exists to avoid: a player who closes the tab before scanning
    // would own an account demanding codes from an authenticator entry that
    // was never created, on their very first session.
    let twoFactorSetup = null;
    if (enable2FA) {
      try {
        const secret = generateSecret();
        user.twoFactorPendingSecret = encryptSecret(secret);
        await user.save();
        twoFactorSetup = {
          secret,
          otpauthUri: buildOtpauthUri({ secret, label: user.mobile || String(user._id) }),
        };
      } catch (e) {
        // Never fail a registration over the optional extra — the account
        // exists and works; the user can enrol later from settings.
        console.error('Signup 2FA opt-in failed (account still created):', e.message);
      }
    }

    res.cookie('auth_token', token, COOKIE_OPTS);
    res.json({ success: true, token, user: userPayload, twoFactorSetup });
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
