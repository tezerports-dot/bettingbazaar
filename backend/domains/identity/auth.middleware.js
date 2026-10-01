// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * ════════════════════════════════════════════════════════════════════════════
 * 🔐 AUTHENTICATION & AUTHORIZATION MIDDLEWARE
 * ════════════════════════════════════════════════════════════════════════════
 * 
 * Complete authentication and authorization middleware for the betting platform.
 * Handles PASETO verification, role-based access control, and permission checks.
 * 
 * Features:
 * - PASETO token verification with expiry checks
 * - User activation status verification
 * - Admin and sub-admin role checks
 * - Granular permission system
 * - Merchant authentication
 * - Request rate limiting prep
 * - Audit logging hooks
 * 
 * @module auth.middleware
 * @requires ./paseto.util.js
 * @requires ../models
 */

import { db } from '#db';
// The KYC vocabulary has one owner, and it is not this file — the payment
// service needs the same rule without booting the token layer to get it.
import { isKycLinked, isKycApproved, kycRefusalFor } from './kycGates.js';
import { isTokenRevoked as pgIsTokenRevoked } from '#db/repositories/identity.js';
import { getUser } from '#db/repositories/users.js';
import { setContextUser } from '../../middleware/requestContext.js'; // X-6
// AQ-2 (2026-07-13): every sign/verify goes through the single PASETO authority —
// Ed25519 signature verification, iss/aud stamped on sign. No raw token-library calls remain here.
import { verifyJwt } from './jwt.util.js';
import { isChallengeToken } from './twoFactorChallenge.js';
// WHO must hold a second factor — its own module, because importing the 2FA
// ROUTES here would be a cycle: they import this file.
import { requires2FA } from './twoFactorPolicy.js';
import { getSystemConfig } from '#db/repositories/config.js';
import { isPermissionKey, permissionLabel, staffCan } from './staffPermissions.js';
import { PANEL_NAME } from './audiences.js';


/**
 * ════════════════════════════════════════════════════════════════════════════
 * 🔑 CORE AUTHENTICATION MIDDLEWARE
 * ════════════════════════════════════════════════════════════════════════════
 */

/**
 * Main authentication middleware - Verifies PASETO token and attaches user to request
 * 
 * This middleware:
 * 1. Extracts PASETO from Authorization header
 * 2. Verifies token signature and expiry
 * 3. Fetches user from database
 * 4. Checks if user account is active
 * 5. Attaches user object to req.user
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void}
 */
/**
 * Has this token been revoked? Checked on every authenticated request.
 *
 * FAILS CLOSED. The previous implementation returned `false` when the lookup
 * threw — so a signed-out session stayed valid for as long as the check was
 * broken, which is the failure mode a revocation list exists to prevent. It
 * cost nothing to be correct here: the platform has one datastore and refuses
 * to boot without it, so "the database is unreachable" is not a state in which
 * this process should be answering authenticated requests anyway.
 *
 * A caller that genuinely cannot tolerate a 401 on a database blip should be
 * fixing the blip, not weakening the check.
 */
/**
 * Was this token issued BEFORE the account said all its sessions were dead?
 *
 * ── Why this is a function and not two copies of an `if` ──────────────────
 * It has to run on every authenticated path, and there are TWO: this
 * middleware, and `GET /api/v1/auth/me`, which verifies the token inline in
 * routes.js and never calls `authenticate`.
 *
 * It was written in the middleware only. Measured on a running server: a
 * password reset changed the password, refused the old one at the login form,
 * and the session held from BEFORE the reset kept answering 200 on `/me` — the
 * single most-used authenticated endpoint on the platform, and the one a panel
 * restores a session from on every page load. So the reset changed a password
 * and evicted nobody, which is the whole thing it exists to do. §5, on a
 * security check.
 *
 * `iat` is stamped by the signer on every token. A token that somehow carries
 * none is treated as older than any cutoff — refused, not admitted: the failure
 * mode of "cannot tell how old this is" must be the safe one.
 */
export function sessionSuperseded(user, decoded) {
  if (!user?.sessionsValidFrom) return false;
  const issued = decoded?.iat ? Date.parse(decoded.iat) : NaN;
  return !Number.isFinite(issued)
    || issued < new Date(user.sessionsValidFrom).getTime();
}

/**
 * Has an admin closed this account?
 *
 * A soft-deleted account keeps its row, its bets and its ledger, because its
 * money still has to reconcile — so a read by id or by mobile still FINDS it.
 * Before 2026-10-01 nothing asked: the login refused BLOCKED only, so a
 * deleted player signed in and transacted as before, and "Delete" removed the
 * row from nothing but the admin's list. `softDeleteUser` also moves
 * `sessions_valid_from`, which evicts every outstanding session on every path
 * that checks the cutoff (sockets and SSE included); this is the refusal the
 * REST paths and the login say out loud, so the person is told the account is
 * closed rather than that their password changed.
 */
export function accountClosed(user) {
  return user?.status === 'DELETED';
}

export function refuseClosedAccount(res) {
  return res.status(403).json({
    success: false,
    code: 'ACCOUNT_CLOSED',
    message: 'This account has been closed. Contact support.',
  });
}

/** One refusal, so both callers say the same thing to the same panel. */
export function refuseSupersededSession(res) {
  return res.status(401).json({
    success: false,
    code: 'SESSION_SUPERSEDED',
    message: 'Your password was changed. Please sign in again.',
  });
}

/**
 * Is this session one the platform still honours?
 *
 * THE question every path that verifies a token asks after the signature:
 * not revoked (a sign-out), and not issued before its account's
 * `sessions_valid_from` (a password reset). It is one function because it was
 * several copies, and the copies disagreed: `authenticate` and `/me` checked
 * the cutoff, while the socket room joins, both private SSE streams and the
 * merchant door checked it nowhere (R6, 2026-09-30) — so a reset evicted a
 * session from the REST API and left it receiving the live order feed.
 *
 * @param {string} token    the raw token, for the revocation list
 * @param {object} decoded  its verified claims
 * @param {object|null} login the `users` row the session belongs to — for a
 *                          merchant token, the merchant's LOGIN row
 *                          (`merchantLoginRow`), not the trading identity
 */
export async function sessionIsLive(token, decoded, login) {
  if (await isTokenRevoked(token)) return false;
  return !sessionSuperseded(login, decoded);
}

/** The `users` row a merchant session belongs to (§33.5), or null. */
export async function merchantLoginRow(merchant) {
  return merchant?.userId ? getUser(merchant.userId) : null;
}

export async function isTokenRevoked(token) {
  try {
    return await pgIsTokenRevoked(token);
  } catch (e) {
    console.error('[auth] revocation check failed — refusing the token:', e.message);
    return true;
  }
}

/**
 * Staff who must hold a second factor, and have not enrolled one, reach the
 * enrolment handshake and nothing else.
 *
 * ── What this closes ────────────────────────────────────────────────────────
 * `requires2FA(user)` decides who must hold a factor. `loginHandler` branches
 * on `user.twoFactorEnabled`, so the factor was demanded only of accounts that
 * ALREADY enrolled — an admin who never did held a password-only session over
 * the entire admin surface, permanently and silently, and `seedAdmin` puts the
 * bootstrapped admin in exactly that state from the first boot. F-011.
 *
 * ── Why it is not a lockout ─────────────────────────────────────────────────
 * The session is still ISSUED; what is refused is everything except enrolling.
 * The admin panel routes an account carrying `mustEnroll2FA` straight to the
 * enrolment screen, so an operator meets a form rather than a wall of 403s.
 * That panel half had to ship first, and did — switching this on before it
 * would have been a lockout with nothing on screen to explain it.
 *
 * The one way it can still bite is a missing TOTP_ENCRYPTION_KEY, without which
 * enrolment itself throws. `server.js` says so loudly at startup rather than
 * leaving the first admin to discover it.
 *
 * ── Why enrolment opts OUT by name instead of this file listing paths ───────
 * A path allowlist here is a second place the enrolment handshake is defined,
 * and it goes stale the first time a route moves or a step is added — the
 * drift shape §5 names. Instead `authenticateForEnrolment` is a distinct
 * export the enrolment routes use, so adding a step is a deliberate act at the
 * route, and this module never has to know their URLs.
 *
 * `disable` deliberately does NOT opt out: an account that has not enrolled has
 * nothing to disable, and the route already refuses it through `requires2FA`.
 */
function refuseUnenrolledStaff(req, res, user) {
  if (!requires2FA(user) || user.twoFactorEnabled) return false;
  res.status(403).json({
    success: false,
    code: 'TWO_FACTOR_ENROLMENT_REQUIRED',
    mustEnroll2FA: true,
    message: 'This account must be protected by two-factor authentication. '
      + 'Set up an authenticator app to continue.',
  });
  return true;
}

/**
 * A session at the wrong panel's door.
 *
 * Owner, 2026-10-01: a player account, a staff account and a merchant account
 * are separate, and "if he has his admin account that account can only be used
 * for admin activity". The LOGIN doors already scope by `account_type`; the
 * SESSION door did not. Measured before this existed: a full admin's and a
 * sub-admin's STAFF session each created a deposit through
 * `POST /api/payment/deposit/create` (200, an order in the staff account's
 * name), and a merchant's session read the PLAYER's projection of an order
 * assigned to them through `GET /api/payment/order/:orderId` (200). §32 S49,
 * at the session rather than the flag.
 *
 * The message names the panel the account belongs to, because the person who
 * meets it can act on that (§32 S14).
 */
export function belongsElsewhere(user, accountTypes) {
  return !accountTypes.includes(user?.accountType);
}

export function refuseWrongPanel(res, user) {
  const panel = PANEL_NAME[user?.accountType] ?? 'other';
  return res.status(403).json({
    success: false,
    code: 'WRONG_PANEL',
    message: `This account is for the ${panel} panel and cannot be used here. `
      + 'Sign in with the account you hold for this panel.',
  });
}

/**
 * @param {object}   [opts]
 * @param {boolean}  [opts.allowUnenrolledStaff]  the 2FA enrolment handshake only
 * @param {string[]} [opts.accountTypes]  the populations this door admits. The
 *   shared door admits PLAYER and STAFF (the staff routes then ask for an AREA,
 *   which only a STAFF row can hold); `authenticatePlayer` admits PLAYER alone.
 *   MERCHANT is never admitted here — merchants have their own door,
 *   `merchantAuth`, and no merchant-facing route relies on this one.
 */
const makeAuthenticate = ({ allowUnenrolledStaff = false, accountTypes = ['PLAYER', 'STAFF'] } = {}) => async (req, res, next) => {
  try {
    // Accept token from httpOnly cookie (user panel) OR Authorization header (admin/merchant panels)
    let token = req.cookies?.auth_token;
    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }
    }
    if (!token) {
      return res.status(401).json({ success: false, message: 'No authorization token provided' });
    }

    // Verify PASETO token
    let decoded;
    try {
      decoded = verifyJwt(token);
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({ 
          success: false,
          message: 'Token has expired. Please login again.' 
        });
      }
      if (jwtError.name === 'JsonWebTokenError' || jwtError.name === 'PasetoError') {
        return res.status(401).json({ 
          success: false,
          message: 'Invalid token signature' 
        });
      }
      throw jwtError; // Re-throw unexpected errors
    }

    // A 2FA challenge token proves ONLY that a password was accepted — the
    // second factor has not been presented yet. It is signed by the same key
    // as a session token, so without this check it would BE a session token
    // and 2FA would be bypassable by anyone holding just the password: the
    // exact attack it exists to stop, while appearing to be enforced.
    if (isChallengeToken(decoded)) {
      return res.status(401).json({
        success: false,
        message: 'Two-factor authentication required. Complete the login before using this token.',
        twoFactorRequired: true,
      });
    }

    // Check token blacklist (logout invalidation)
    if (await isTokenRevoked(token)) {
      return res.status(401).json({ success: false, message: 'Token has been invalidated. Please login again.' });
    }

    // The account, from the SAME table signup writes to. It used to come from
    // the document while `createAccountFromOnboarding` wrote the row — so a
    // player could sign up and then not log in: the write succeeded, this read
    // found nothing, and nothing errored anywhere.
    //
    // Credentials are NOT loaded here. This runs on every authenticated
    // request, and a TOTP secret on `req.user` is a secret one careless
    // `res.json(req.user)` puts in a response body. The paths that verify a
    // second factor ask for them by name.
    const user = await getUser(decoded.userId);
    
    if (!user) {
      return res.status(401).json({ 
        success: false,
        message: 'User not found. Token may be invalid.' 
      });
    }

    if (accountClosed(user)) return refuseClosedAccount(res);
    if (sessionSuperseded(user, decoded)) return refuseSupersededSession(res);
    if (belongsElsewhere(user, accountTypes)) return refuseWrongPanel(res, user);

    // Check if user account is active
    if (user.isBlocked) {
      return res.status(403).json({ 
        success: false,
        message: 'Your account has been blocked. Please contact support.' 
      });
    }

    // Last of the refusals, and after `isBlocked`: a blocked account is told it
    // is blocked rather than told to enrol in something it cannot use.
    if (!allowUnenrolledStaff && refuseUnenrolledStaff(req, res, user)) return;

    // Attach user to request object for use in subsequent middleware/routes
    req.user = user;
    req.userId = user.userId;
    // X-6: tag the request-context so structured logs in downstream services
    // (wallet, settlement, …) are attributable to this user by correlation id.
    try { setContextUser(user.userId); } catch { /* context is best-effort */ }

    // `req.merchantId` is NOT set here any more. It was copied from a merchant
    // token's claims, which is what let a merchant session reach the player's
    // order routes as "the assigned merchant". Merchant sessions are refused
    // above; `merchantAuth` is the only thing that establishes a merchant.

    // Continue to next middleware
    next();

  } catch (error) {
    console.error('Authentication Error:', error);
    return res.status(500).json({ 
      success: false,
      message: 'Authentication failed' 
    });
  }
};

/** Every authenticated route. Unenrolled staff are refused here. */
const authenticate = makeAuthenticate();

/**
 * The PLAYER's routes — money, bets, orders, profile, support tickets. A staff
 * or merchant session is refused with the panel it belongs to.
 */
const authenticatePlayer = makeAuthenticate({ accountTypes: ['PLAYER'] });

/**
 * The enrolment handshake only — identical in every other respect.
 *
 * Used by `/api/2fa/status`, `/setup` and `/activate`, which are the three
 * steps an unenrolled account has to reach in order to stop being one.
 */
const authenticateForEnrolment = makeAuthenticate({ allowUnenrolledStaff: true });


/**
 * Betting and the money paths require an APPROVED Aadhaar.
 *
 * ── Why the message depends on the status ───────────────────────────────────
 * This used to answer every refusal with "Please complete KYC verification to
 * use this action." Under the Telegram/Aadhaar model that instruction is
 * impossible to follow: the player already gave their Aadhaar to the bot, and
 * verification happens in BULK against the issuing authority on the operator's
 * schedule. There is nothing for them to complete. A player who has done
 * everything asked of them was being told to go and do something that does not
 * exist, and support has no better answer than "wait".
 *
 * So each status says what is actually true and what, if anything, the player
 * can do about it. `code` stays stable for the client; only the sentence moves.
 */


/**
 * The WEAKER gate: KYC details have been given, not necessarily cleared.
 *
 * ── Why two gates and not one ───────────────────────────────────────────────
 * Owner decision 2026-09-08: an approved Aadhaar is required to take money OUT
 * and nothing else. Depositing, buying tokens and placing a bet need only that
 * the player has actually linked their identity — the verification runs in
 * batches and can take a day, and holding a funded player at the door for it
 * loses the player without protecting anybody.
 *
 * Withdrawal keeps `requireApprovedKyc`, and that is the whole of the stricter
 * rule: every withdrawal on this platform draws from the WINNINGS balance —
 * `debitWinningsForWithdrawal` is the only debit path — so "approved KYC to
 * withdraw winnings" and "approved KYC to withdraw" are the same sentence here.
 *
 * ── REJECTED is refused, and that is the owner's decision ───────────────────
 * PENDING_APPROVAL passes: the details are linked and a verifier has simply not
 * reached them, which is a queue the player cannot do anything about.
 *
 * REJECTED does not pass, and stays refused while they re-submit (owner
 * confirmed 2026-09-08). An Aadhaar that came back not matching the issuing
 * authority means the details given were wrong, and somebody giving wrong
 * identity details on a money platform is a bot or a scammer often enough that
 * the benefit of the doubt is the wrong default. Getting it wrong in this
 * direction costs an honest player a delay; getting it wrong in the other
 * direction lets funds move against an identity that failed its check, and that
 * cannot be undone afterwards.
 */
export async function requireLinkedKyc(req, res, next) {
  try {
    const cfg = await getSystemConfig();
    if (cfg?.kycRequired === false) return next();

    const status = req.user?.kycStatus || 'PENDING_SUBMISSION';
    if (isKycLinked(status)) return next();

    return res.status(403).json({
      success: false,
      message: kycRefusalFor(status),
      // A DIFFERENT code from the approved gate. A panel that cannot tell the
      // two apart shows "your Aadhaar is being verified" to someone who never
      // submitted one, and the button it offers leads nowhere.
      code: 'KYC_NOT_LINKED',
      kycStatus: status,
      actionable: true,
    });
  } catch (error) {
    console.error('KYC link check error:', error);
    return res.status(500).json({ success: false, message: 'Failed to verify KYC settings.' });
  }
}

export async function requireApprovedKyc(req, res, next) {
  try {
    const cfg = await getSystemConfig();
    if (cfg?.kycRequired === false || isKycApproved(req.user?.kycStatus)) return next();

    const status = req.user?.kycStatus || 'PENDING_SUBMISSION';
    return res.status(403).json({
      success: false,
      message: kycRefusalFor(status),
      code: 'KYC_REQUIRED',
      kycStatus: status,
      // Whether the player can do anything at all. The panel uses this to
      // decide between "finish signing up" and a passive "we are working on it",
      // rather than showing an action button that leads nowhere.
      actionable: status !== 'PENDING_APPROVAL',
    });
  } catch (error) {
    console.error('KYC config check error:', error);
    return res.status(500).json({ success: false, message: 'Failed to verify KYC settings.' });
  }
}

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 👑 ADMIN ACCESS CONTROL
 * ════════════════════════════════════════════════════════════════════════════
 */

/**
 * Middleware to check if user is an administrator
 * Must be used after authenticate() middleware
 * 
 * @param {Object} req - Express request object (must have req.user)
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void}
 */
const isAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ 
      success: false,
      message: 'Authentication required' 
    });
  }

  if (!req.user.isAdmin) {
    return res.status(403).json({ 
      success: false,
      message: 'Admin access required. You do not have permission to perform this action.' 
    });
  }

  // User is admin, proceed
  next();
};
// Read by `check:staff-permissions`: a route gated this way must be one of the
// areas `staffPermissions.ADMIN_ONLY_AREAS` names.
isAdmin.adminOnly = true;

/**
 * `isAdminOrSubAdmin` was here: "are you staff at all". It admitted a sub-admin
 * holding nothing but chat moderation to any route it guarded, which is the
 * question F-001 and F-042 each found one more instance of. Every staff route
 * now names its area (`hasPermission`), and `check:staff-permissions` refuses
 * a route that does not (owner, 2026-10-01).
 */

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 🎯 PERMISSION-BASED ACCESS CONTROL
 * ════════════════════════════════════════════════════════════════════════════
 */

/**
 * The gate on every staff route: the caller works in this AREA, or is refused.
 *
 * The key must be one `staffPermissions.js` declares — checked when the route
 * file is IMPORTED, so a misspelt key stops the server booting instead of
 * shipping a route nobody can ever be given (the chat screen asked for
 * `canModerateChatPublic` while its routes asked for `canManageSupport`).
 *
 * Full admins pass. A sub-admin passes holding the key. Nobody else does. The
 * answer itself is `staffCan`, which both realtime transports also ask.
 *
 * The returned function carries `.permission`, which is how
 * `check:staff-permissions` reads a route's area off the live route stack.
 */
export const hasPermission = (permission) => {
  if (!isPermissionKey(permission)) {
    throw new Error(`hasPermission: '${permission}' is not in staffPermissions.js — add it there or use an existing key`);
  }
  const gate = (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    if (staffCan(req.user, permission)) return next();
    if (!req.user.isAdmin && !req.user.isSubAdmin) {
      return res.status(403).json({ success: false, message: 'Administrative privileges required' });
    }
    return res.status(403).json({
      success: false,
      code: 'PERMISSION_REQUIRED',
      // Names the area in the words the Sub-admins screen uses, so the person
      // refused knows exactly what to ask their admin for.
      message: `You do not have the "${permissionLabel(permission)}" permission. Ask an admin to grant it on the Sub-admins screen.`,
      requiredPermission: permission,
    });
  };
  gate.permission = permission;
  return gate;
};

/**
 * ── What used to be below, and why it is gone ────────────────────────────────
 * A second merchant verifier (`authenticateMerchant`), `optionalAuth`,
 * `generateToken`, `generateMerchantToken`, `verifyToken`, `auditLog`,
 * `checkResourcePermission` and `isMerchantApproved` were exported here and
 * called by nothing (R6, 2026-09-30). The merchant verifier was the dangerous
 * one: it checked neither the revocation list nor the session cutoff, so the
 * next route to reach for it would have honoured a signed-out or superseded
 * session. `middleware/merchantAuth.js` is the one merchant door.
 */
export {
  authenticate,
  authenticatePlayer,
  // The enrolment handshake only — see `makeAuthenticate`. Staff who owe a
  // second factor reach these three steps and nothing else.
  authenticateForEnrolment,
  isAdmin,
};
