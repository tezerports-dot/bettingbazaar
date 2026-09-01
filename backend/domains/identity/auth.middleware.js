// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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

import { SystemConfig, User } from '../../models/index.js';
import { isTokenRevoked as pgIsTokenRevoked } from '../../postgres/identityPg.js';
import { setContextUser } from '../../middleware/requestContext.js'; // X-6
// AQ-2 (2026-07-13): every sign/verify goes through the single PASETO authority —
// Ed25519 signature verification, iss/aud stamped on sign. No raw token-library calls remain here.
import { signToken, verifyJwt, JWT_SECRET, JWT_EXPIRES_IN } from './jwt.util.js';
import { isChallengeToken } from './twoFactorChallenge.js';

// JWT_SECRET / JWT_EXPIRES_IN now come from jwt.util.js (imported above), which
// fail-fasts on a missing secret and owns the 24h default. Re-exported at the
// bottom of this file for backward compatibility with any importer.

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
export async function isTokenRevoked(token) {
  try {
    return await pgIsTokenRevoked(token);
  } catch (e) {
    console.error('[auth] revocation check failed — refusing the token:', e.message);
    return true;
  }
}

const authenticate = async (req, res, next) => {
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

    // Fetch user from database
    const user = await User.findById(decoded.userId).select('+twoFactorSecret +twoFactorEnabled');
    
    if (!user) {
      return res.status(401).json({ 
        success: false,
        message: 'User not found. Token may be invalid.' 
      });
    }

    // Check if user account is active
    if (user.isBlocked) {
      return res.status(403).json({ 
        success: false,
        message: 'Your account has been blocked. Please contact support.' 
      });
    }

    // Attach user to request object for use in subsequent middleware/routes
    req.user = user;
    req.userId = user._id;
    // X-6: tag the request-context so structured logs in downstream services
    // (wallet, settlement, …) are attributable to this user by correlation id.
    try { setContextUser(user._id); } catch { /* context is best-effort */ }

    
    // Merchant PASETO contains { merchantId, isMerchant: true } — set by domains/merchant/merchant.routes.js /auth/login.
    // isMerchant is a PASETO claim, NOT a User schema field. merchantAuth middleware handles Merchant PASETOs.
    // This authenticate middleware is for User PASETOs only (players, admin, sub-admin, queue manager).
    
    
    if (decoded.merchantId) {
      req.merchantId = decoded.merchantId;
    }

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
const KYC_REFUSAL = {
  // Signed up through the bot: the Aadhaar is captured and queued. Nothing to do.
  PENDING_APPROVAL: 'Your Aadhaar is being verified. This is done in batches and needs nothing '
    + 'from you — you will be able to play as soon as it clears.',
  // No Aadhaar was ever captured. This is the only status a player can act on,
  // and the action is to finish signing up in the bot.
  PENDING_SUBMISSION: 'Finish signing up in our Telegram bot — we still need your Aadhaar number '
    + 'before you can play.',
  REJECTED: 'Your Aadhaar could not be verified against the issuing authority. Please contact '
    + 'support — this usually means a mismatch we can sort out for you.',
};

export async function requireApprovedKyc(req, res, next) {
  try {
    const cfg = await SystemConfig.findOne({ key: 'main' }).select('kycRequired').lean();
    if (cfg?.kycRequired === false || req.user?.kycStatus === 'APPROVED') return next();

    const status = req.user?.kycStatus || 'PENDING_SUBMISSION';
    return res.status(403).json({
      success: false,
      message: KYC_REFUSAL[status] || KYC_REFUSAL.PENDING_SUBMISSION,
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

/**
 * Middleware to check if user is admin OR sub-admin
 * Allows both full admins and sub-admins to access the route
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void}
 */
const isAdminOrSubAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ 
      success: false,
      message: 'Authentication required' 
    });
  }

  if (!req.user.isAdmin && !req.user.isSubAdmin) {
    return res.status(403).json({ 
      success: false,
      message: 'Admin or sub-admin access required' 
    });
  }

  next();
};

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 🎯 PERMISSION-BASED ACCESS CONTROL
 * ════════════════════════════════════════════════════════════════════════════
 */

/**
 * Higher-order function to create permission-checking middleware
 * 
 * Usage:
 *   router.post('/kyc/:id/approve', authenticate, hasPermission('canVerifyKYC'), approveKYC)
 * 
 * Logic:
 * - Full admins (isAdmin = true) always have all permissions
 * - Sub-admins need the specific permission to be true
 * 
 * @param {string} permission - Permission name (e.g., 'canVerifyKYC')
 * @returns {Function} Express middleware function
 */
export const hasPermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        success: false,
        message: 'Authentication required' 
      });
    }

    // Full admins have all permissions
    if (req.user.isAdmin) {
      return next();
    }

    // Check if user is a sub-admin
    if (!req.user.isSubAdmin) {
      return res.status(403).json({ 
        success: false,
        message: 'Administrative privileges required' 
      });
    }

    // Check if sub-admin has the specific permission
    const permissions = req.user.subAdminPermissions || {};
    
    if (!permissions[permission]) {
      return res.status(403).json({ 
        success: false,
        message: `Insufficient permissions. Required: ${permission}`,
        requiredPermission: permission
      });
    }

    // Sub-admin has the required permission
    next();
  };
};

/**
 * Middleware to check multiple permissions (user must have ALL)
 * 
 * Usage:
 *   router.delete('/user/:id', authenticate, hasAllPermissions(['canManageUsers', 'canDeleteAccounts']), deleteUser)
 * 
 * @param {Array<string>} permissions - Array of required permission names
 * @returns {Function} Express middleware function
 */
export const hasAllPermissions = (permissions) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        success: false,
        message: 'Authentication required' 
      });
    }

    // Full admins have all permissions
    if (req.user.isAdmin) {
      return next();
    }

    // Check if user is a sub-admin
    if (!req.user.isSubAdmin) {
      return res.status(403).json({ 
        success: false,
        message: 'Administrative privileges required' 
      });
    }

    // Check if sub-admin has ALL required permissions
    const userPermissions = req.user.subAdminPermissions || {};
    const missingPermissions = permissions.filter(perm => !userPermissions[perm]);
    
    if (missingPermissions.length > 0) {
      return res.status(403).json({ 
        success: false,
        message: 'Insufficient permissions',
        required: permissions,
        missing: missingPermissions
      });
    }

    // Sub-admin has all required permissions
    next();
  };
};

/**
 * Middleware to check if user has ANY of the specified permissions
 * 
 * Usage:
 *   router.get('/support/tickets', authenticate, hasAnyPermission(['canManageSupport', 'canViewTickets']), getTickets)
 * 
 * @param {Array<string>} permissions - Array of acceptable permission names
 * @returns {Function} Express middleware function
 */
export const hasAnyPermission = (permissions) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        success: false,
        message: 'Authentication required' 
      });
    }

    // Full admins have all permissions
    if (req.user.isAdmin) {
      return next();
    }

    // Check if user is a sub-admin
    if (!req.user.isSubAdmin) {
      return res.status(403).json({ 
        success: false,
        message: 'Administrative privileges required' 
      });
    }

    // Check if sub-admin has ANY of the required permissions
    const userPermissions = req.user.subAdminPermissions || {};
    const hasAtLeastOne = permissions.some(perm => userPermissions[perm]);
    
    if (!hasAtLeastOne) {
      return res.status(403).json({ 
        success: false,
        message: 'Insufficient permissions. At least one of these permissions required:',
        required: permissions
      });
    }

    // Sub-admin has at least one required permission
    next();
  };
};

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 🏪 MERCHANT AUTHENTICATION
 * ════════════════════════════════════════════════════════════════════════════
 */

/**
 * Middleware for merchant authentication
 * Merchants use a different authentication flow than regular users
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void}
 */
const authenticateMerchant = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false,
        message: 'Merchant authentication required' 
      });
    }

    const token = authHeader.substring(7);
    
    // Verify token
    let decoded;
    try {
      decoded = verifyJwt(token);
    } catch (jwtError) {
      return res.status(401).json({ 
        success: false,
        message: 'Invalid or expired merchant token' 
      });
    }

    // Fetch merchant from database
    // HIGH-01 FIX: use Merchant model (decoded.merchantId is Merchant._id, not User._id)
    const MerchantModel = mongoose.model('Merchant');
    const merchant = await MerchantModel.findById(decoded.merchantId);
    
    if (!merchant) {
      return res.status(401).json({ 
        success: false,
        message: 'Merchant not found' 
      });
    }

    // Check if merchant account is active
    if (merchant.isBlocked || merchant.isSuspended) {
      return res.status(403).json({ 
        success: false,
        message: 'Merchant account is suspended' 
      });
    }

    // Check if user has merchant role
    if (!merchant.roles || !merchant.roles.includes('merchant')) {
      return res.status(403).json({ 
        success: false,
        message: 'User does not have merchant privileges' 
      });
    }

    // Attach merchant to request
    req.merchant = merchant;
    req.merchantId = merchant._id;

    next();

  } catch (error) {
    console.error('Merchant Authentication Error:', error);
    return res.status(500).json({ 
      success: false,
      message: 'Merchant authentication failed' 
    });
  }
};

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 🛠️ UTILITY FUNCTIONS
 * ════════════════════════════════════════════════════════════════════════════
 */

/**
 * Generate PASETO token for user
 * 
 * @param {Object} user - User object from database
 * @param {Object} options - Additional options (expiresIn, etc.)
 * @returns {string} PASETO token
 */
const generateToken = (user, options = {}) => {
  const payload = {
    userId: user._id,
    mobile: user.mobile,
    isAdmin: user.isAdmin || false,
    isSubAdmin: user.isSubAdmin || false,
    roles: user.roles || []
  };

  const tokenOptions = {
    expiresIn: options.expiresIn || JWT_EXPIRES_IN
  };

  return signToken(payload, tokenOptions);
};

/**
 * Generate PASETO token for merchant
 * 
 * @param {Object} merchant - Merchant object from database
 * @param {Object} options - Additional options
 * @returns {string} PASETO token
 */
const generateMerchantToken = (merchant, options = {}) => {
  const payload = {
    merchantId: merchant._id,
    userId: merchant._id,
    mobile: merchant.mobile,
    roles: ['merchant']
  };

  const tokenOptions = {
    expiresIn: options.expiresIn || JWT_EXPIRES_IN
  };

  return signToken(payload, tokenOptions);
};

/**
 * Verify token without attaching to request (useful for API calls)
 * 
 * @param {string} token - PASETO token string
 * @returns {Object|null} Decoded token payload or null if invalid
 */
const verifyToken = (token) => {
  try {
    return verifyJwt(token);
  } catch (error) {
    return null;
  }
};

/**
 * Optional middleware - doesn't fail if no auth token
 * Useful for routes that work with or without authentication
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void}
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // No token provided, continue without user
      return next();
    }

    const token = authHeader.substring(7);
    
    try {
      const decoded = verifyJwt(token);
      const user = await User.findById(decoded.userId);
      
      if (user && !user.isBlocked) {
        req.user = user;
        req.userId = user._id;
      }
    } catch (jwtError) {
      // Invalid token, but we don't fail - just continue without user
      console.log('Optional auth token invalid:', jwtError.message);
    }

    next();
  } catch (error) {
    console.error('Optional Auth Error:', error);
    // Even on error, we continue without user
    next();
  }
};

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 📊 AUDIT LOG HELPER (for tracking admin actions)
 * ════════════════════════════════════════════════════════════════════════════
 */

/**
 * Middleware to log admin actions to audit trail
 * Should be used on sensitive routes
 * 
 * @param {string} action - Action description (e.g., 'USER_DELETED', 'KYC_APPROVED')
 * @returns {Function} Express middleware function
 */
const auditLog = (action) => {
  return async (req, res, next) => {
    // Store audit info in request for later logging
    req.auditAction = {
      action,
      performedBy: req.user?._id,
      performedByName: req.user?.name || req.user?.mobile,
      isAdmin: req.user?.isAdmin,
      isSubAdmin: req.user?.isSubAdmin,
      timestamp: new Date(),
      ip: req.ip,
      userAgent: req.headers['user-agent']
    };

    // Store original res.json to capture response
    const originalJson = res.json.bind(res);
    res.json = function(data) {
      req.auditAction.success = !data.error && data.success !== false;
      req.auditAction.response = data;
      
      // Log to database (implement AuditLog model if needed)
      // Example: AuditLog.create(req.auditAction).catch(err => console.error('Audit log failed:', err));
      
      return originalJson(data);
    };

    next();
  };
};

/**
 * NEW: Granular permission checking (resource-based)
 * Usage: router.post('/kyc/:id/approve', authenticate, checkResourcePermission('kyc', 'approve'), handler)
 * Note: This is a newer granular version. The main hasPermission is defined above.
 */
export const checkResourcePermission = (resource, action) => {
  return async (req, res, next) => {
    try {
      // Super admin bypasses all checks
      if (req.user.isAdmin) {
        return next();
      }
      
      // Check if sub-admin
      if (!req.user.isSubAdmin) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. Admin privileges required.'
        });
      }
      
      // Check specific permission
      const permissions = req.user.subAdminPermissions || {};
      const resourcePermissions = permissions[resource];
      
      if (!resourcePermissions || !resourcePermissions[action]) {
        return res.status(403).json({
          success: false,
          message: `Permission denied. Requires ${resource}.${action} permission.`
        });
      }
      
      next();
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  };
};

/**
/**
 * isMerchantApproved — guards routes that require a confirmed merchant session.
 * Must be used AFTER merchantAuth (which already verifies the Merchant PASETO and
 * checks merchantApprovalStatus === 'APPROVED'). This is therefore just a
 * safety check that merchantAuth ran first.
 *
 * NOTE: isMerchant is a PASETO *claim* in the Merchant PASETO, NOT a User schema field.
 * Never read req.user.isMerchant — the User model has no such field.
 */
export const isMerchantApproved = async (req, res, next) => {
  try {
    if (!req.merchant) {
      return res.status(403).json({
        success: false,
        message: 'Merchant authentication required. Use POST /api/merchant/auth/login.',
      });
    }
    // merchantAuth already verified status — just forward
    next();
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};



/**
 * ════════════════════════════════════════════════════════════════════════════
 * 📤 EXPORTS
 * ════════════════════════════════════════════════════════════════════════════
 */

export {
  // Core authentication
  authenticate,
  optionalAuth,
  
  // Admin access control
  isAdmin,
  isAdminOrSubAdmin,
  
  // Merchant authentication
  authenticateMerchant,
  
  // Token utilities
  generateToken,
  generateMerchantToken,
  verifyToken,
  
  // Audit logging
  auditLog,
  
  // Constants
  JWT_SECRET,
  JWT_EXPIRES_IN
};

export default {
  authenticate,
  optionalAuth,
  isAdmin,
  isAdminOrSubAdmin,
  authenticateMerchant,
  generateToken,
  generateMerchantToken,
  verifyToken,
  auditLog,
  JWT_SECRET,
  JWT_EXPIRES_IN
};
