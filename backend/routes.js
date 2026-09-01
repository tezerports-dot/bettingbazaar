// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * routes.js — session lifecycle, and the STAFF password login.
 *
 * ── Players do not have passwords ───────────────────────────────────────────
 * Player signup and login run entirely through Telegram
 * (domains/telegram/*): the bot proves the phone number via a contact share,
 * hands out a one-time link, and POST /api/telegram/exchange trades that link
 * for a session by calling `issueSession` below. There is no player password
 * to guess, reset, phish, or reuse from another breach, so there is no player
 * `/register`, `/login`, or password-reset surface — those were removed rather
 * than left mounted, because a second way in is a second thing to defend.
 *
 * What remains here:
 *   • `issueSession`  — the ONE place a session is minted, for staff and for
 *                       Telegram players alike.
 *   • `loginHandler` / `loginTwoFactorHandler`
 *                     — STAFF ONLY (admin, sub-admin, queue manager, mediator),
 *                       mounted by server.js at /api/admin/login. Merchants have
 *                       their own equivalent under /api/merchant/auth.
 *   • `/me`, `/logout`, `/health` — used by every panel on every page load.
 */
import express     from 'express';
// AQ-2: sign/verify via the single PASETO authority (PASETO/Ed25519, iss/aud stamped).
import { signToken, verifyJwt, decodeTokenClaims } from './domains/identity/jwt.util.js';
// AQ-8: password hashing authority (argon2id + bcrypt verify-fallback).
import { hashPassword, verifyPassword } from './domains/identity/password.util.js';
import mongoose    from 'mongoose';
import { buildPublicKycData } from './domains/user/kycPublicData.js';
import { isTokenRevoked, revokeToken } from './postgres/identityPg.js';
import { issueChallenge, verifyChallenge, CHALLENGE_AUDIENCE } from './domains/identity/twoFactorChallenge.js';
import { verifySecondFactor, SECOND_FACTOR_RESULT } from './domains/identity/verifySecondFactor.js';

const router = express.Router();

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

/**
 * True for an account that is allowed to use the password door at all.
 *
 * Since players moved to Telegram this is the whole guest list. It matters more
 * than it looks: legacy player rows still carry a `passwordHash`, and without
 * this check a caller could post `loginType: 'user'` to /api/admin/login and
 * walk in on one of them — none of the three role checks below would fire,
 * because each only tests the role it names.
 */
function isStaffAccount(user) {
  return Boolean(user?.isAdmin || user?.isSubAdmin || user?.isQueueManager || user?.isMediator);
}

// ── POST /api/admin/login (staff only) ───────────────────────────────────────
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

    // Checked AFTER the password, so a wrong password and a non-staff account
    // are indistinguishable to a caller probing for which numbers are staff.
    if (!isStaffAccount(user)) {
      console.warn(`[auth] password login refused for non-staff account ${user._id}`);
      return res.status(403).json({ success: false, message: 'This account signs in through Telegram.' });
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
 * The ONE place a session comes into existence. Three callers reach it — the
 * staff password leg, the staff post-OTP leg, and the Telegram exchange — and
 * they share this function rather than each building their own, because
 * proving who you are must change WHEN you get a session, never WHAT it
 * contains. Three copies of this would be a standing invitation for one door
 * to quietly grant claims the others refuse.
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
    // Sent separately, and never folded into walletBalance. The reserve is NOT
    // freely spendable — only `betReservePercent` of a stake may come from it —
    // so adding it to a headline "available" figure is what made players try
    // bets the engine then refused. GET /api/user/bet-limits publishes the true
    // ceiling, computed by the same rule the bet route enforces.
    reserveBalance: user.reserveBalance || 0,
    walletBalance: dep + win, kycStatus: user.kycStatus,
    kycData: buildPublicKycData(user),
    bankDetails: user.bankDetails || null, profilePic: user.profilePic || '',
    status: user.status || 'ACTIVE', joinedAt: user.joinedAt || null,
    lastLogin: user.lastLogin, phantomAccess: user.phantomAccess || 'NONE',
    twoFactorEnabled: user.twoFactorEnabled || false,
  };

  res.cookie('auth_token', token, COOKIE_OPTS);
  return res.json({ success: true, token, user: userPayload });
}

/**
 * POST /api/admin/login/2fa — redeem a challenge with an OTP or a recovery code.
 *
 * Re-loads and re-checks the account rather than trusting anything cached in
 * the challenge: between the two legs an admin may have been blocked, or have
 * had their staff role taken away. The challenge proves the password was right
 * five minutes ago, nothing more.
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
    if (user.status === 'BLOCKED' || user.isBlocked)
      return res.status(403).json({ success: false, message: 'Account blocked. Contact support.' });
    if (!isStaffAccount(user))
      return res.status(403).json({ success: false, message: 'This account signs in through Telegram.' });

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

// The two handlers above are NOT registered on this router. They are mounted by
// server.js at /api/admin/login and /api/admin/login/2fa, on the admin rate
// limit tier. /api/v1/auth/login and /api/v1/auth/register used to exist here
// for players and are gone: a player's only door is the Telegram bot.

// ── GET /me — session restore on every page load ─────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ success: false, message: 'No token provided' });

    const decoded = verifyJwt(token);

    // Check the revocation list. NOT wrapped in a swallow: this used to ignore
    // its own failure and continue, which meant a revoked token was accepted
    // whenever the check broke. isTokenRevoked fails closed for the same reason.
    if (await isTokenRevoked(token)) {
      return res.status(401).json({ success: false, message: 'Token invalidated. Please login again.' });
    }

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
        reserveBalance: user.reserveBalance || 0,
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

// ── POST /logout ─────────────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  try {
    const token = extractToken(req);
    if (token) {
      // A failed revocation used to be swallowed, and the response still said
      // "Logged out successfully" — so somebody signing out on a shared device
      // was told their session was dead while the token kept working until it
      // expired. Report the failure instead: the cookie is cleared either way,
      // but the caller must not be told the token is dead when it is not.
      try {
        const decoded = decodeTokenClaims(token);
        const exp = decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + 7 * 86400000);
        await revokeToken(token, { ttlSeconds: Math.max(1, Math.ceil((exp - Date.now()) / 1000)) });
      } catch (e) {
        console.error('[auth] logout could not revoke the token:', e.message);
        res.clearCookie('auth_token', { path: '/' });
        return res.status(500).json({
          success: false,
          message: 'Signed out on this device, but the session could not be revoked. '
                 + 'Please try again — the token is still valid until you do.',
        });
      }
    }
    res.clearCookie('auth_token', { path: '/' });
    res.json({ success: true, message: 'Logged out successfully' });
  } catch {
    res.json({ success: true, message: 'Logged out successfully' });
  }
});

router.get('/health', (_, res) => res.json({ success: true, status: 'ok', timestamp: new Date().toISOString() }));

export default router;
