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

// The KYC vocabulary has one owner, and it is not this file — the payment
// service needs the same rule without booting the token layer to get it.
import { isTokenRevoked as pgIsTokenRevoked } from '#db/repositories/identity.js';
import { getUser } from '#db/repositories/users.js';
import { setContextUser } from '../../middleware/requestContext.js'; // X-6
// AQ-2 (2026-07-13): every sign/verify goes through the single PASETO authority —
// Ed25519 signature verification, iss/aud stamped on sign. No raw token-library calls remain here.
import { verifyJwt } from './jwt.util.js';
import { isChallengeToken } from './twoFactorChallenge.js';
// The one bot: whether it exists decides the staff bootstrap exemption (§33).
import { miniAppBot } from '../telegram/telegramClient.js';
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
  if (isChallengeToken(decoded)) return false;
  if (sessionSuperseded(login, decoded)) return false;
  const accountType = login?.accountType ?? (decoded?.isMerchant ? 'MERCHANT' : null);
  return !(await secondFactorMissing(accountType, decoded));
}

/**
 * Is the platform still in its STAFF BOOTSTRAP (CLAUDE.md §33)?
 *
 * True while no Mini App bot is configured. A staff account then signs in with
 * its password alone, because the screen where an admin saves the bot sits
 * behind the staff sign-in, and Telegram cannot approve anything before there
 * is a bot to carry the approval. Every staff response says so (`bootstrap`),
 * and the moment a bot is saved this is false on every path below — within the
 * bot cache's 30 seconds on other instances.
 */
export async function staffBootstrap() {
  return !(await miniAppBot());
}

/**
 * Does this session lack the Telegram approval its account type owes?
 *
 * Step 3 (owner, 2026-10-07): a staff or merchant sign-in is a password AND the
 * account's own Telegram, and the token SAYS which it proved (`amr`, minted
 * only by `issueSession` / `issueMerchantSession`). Asked on every path that
 * honours a session — `authenticate`, `/me`, `merchantAuth`, both private SSE
 * streams and the socket room joins (through `sessionIsLive`) — so no path
 * admits a password-only staff or merchant session the login would not have
 * minted (§32 S32).
 *
 * Telegram is the only second factor (owner, 2026-10-07: "Telegram only"; the
 * authenticator app is gone). A player's session never owes one: a player
 * signs in with a password, or with Telegram, and a player who switched
 * approval on is asked for it AT the login.
 *
 * @param {'PLAYER'|'STAFF'|'MERCHANT'|null} accountType
 * @param {object} decoded  the verified claims
 */
export async function secondFactorMissing(accountType, decoded) {
  if (accountType !== 'STAFF' && accountType !== 'MERCHANT') return false;
  const amr = Array.isArray(decoded?.amr) ? decoded.amr : [];
  if (amr.includes('tg')) return false;
  if (accountType === 'STAFF' && await staffBootstrap()) return false;
  return true;
}

/** One refusal, so every path says the same thing to the same panel. */
export function refuseMissingSecondFactor(res) {
  return res.status(403).json({
    success: false,
    code: 'TWO_FACTOR_REQUIRED',
    message: 'This sign-in has not been approved in Telegram. Sign in again and approve it in the Telegram app.',
  });
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
 * @param {string[]} [opts.accountTypes]  the populations this door admits. The
 *   shared door admits PLAYER and STAFF (the staff routes then ask for an AREA,
 *   which only a STAFF row can hold); `authenticatePlayer` admits PLAYER alone.
 *   MERCHANT is never admitted here — merchants have their own door,
 *   `merchantAuth`, and no merchant-facing route relies on this one.
 */
const makeAuthenticate = ({ accountTypes = ['PLAYER', 'STAFF'] } = {}) => async (req, res, next) => {
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
    // request, and a password hash on `req.user` is a secret one careless
    // `res.json(req.user)` puts in a response body. The login asks for it by
    // name.
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
    if (await secondFactorMissing(user.accountType, decoded)) return refuseMissingSecondFactor(res);

    // Check if user account is active
    if (user.isBlocked) {
      return res.status(403).json({ 
        success: false,
        message: 'Your account has been blocked. Please contact support.' 
      });
    }

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

/** Every authenticated route of the player app and the admin panel. */
const authenticate = makeAuthenticate();

/**
 * The PLAYER's routes — money, bets, orders, profile, support tickets. A staff
 * or merchant session is refused with the panel it belongs to.
 */
const authenticatePlayer = makeAuthenticate({ accountTypes: ['PLAYER'] });

/**
 * A STAFF account's own routes — its Telegram link (accountTelegram.js). A
 * player's session is refused with the panel it belongs to.
 */
const authenticateStaff = makeAuthenticate({ accountTypes: ['STAFF'] });



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


// The KYC gates (`requireLinkedKyc`, `requireApprovedKyc`) were removed
// 2026-10-02 with KYC itself (owner): the Telegram contact share is the only
// identity check now.

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
  authenticateStaff,
  isAdmin,
};
