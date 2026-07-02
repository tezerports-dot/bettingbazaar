// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ════════════════════════════════════════════════════════════════════════════
 * 🔐 AUTHENTICATION & AUTHORIZATION MIDDLEWARE
 * ════════════════════════════════════════════════════════════════════════════
 * 
 * Complete authentication and authorization middleware for the betting platform.
 * Handles JWT verification, role-based access control, and permission checks.
 * 
 * Features:
 * - JWT token verification with expiry checks
 * - User activation status verification
 * - Admin and sub-admin role checks
 * - Granular permission system
 * - Merchant authentication
 * - Request rate limiting prep
 * - Audit logging hooks
 * 
 * @module auth.middleware
 * @requires jsonwebtoken
 * @requires ../models
 */

import jwt from 'jsonwebtoken';
import { User } from '../models/index.js';

/**
 * JWT Secret (should be in environment variables)
 * In production, use: process.env.JWT_SECRET
 */
// ✅ FIX: Never fall back to a hardcoded string — that lets anyone forge tokens.
// If JWT_SECRET is missing, crash loudly at startup rather than silently accept forgeries.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is not set. Refusing to start.');
}
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 🔑 CORE AUTHENTICATION MIDDLEWARE
 * ════════════════════════════════════════════════════════════════════════════
 */

/**
 * Main authentication middleware - Verifies JWT token and attaches user to request
 * 
 * This middleware:
 * 1. Extracts JWT from Authorization header
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

    // Verify JWT token
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({ 
          success: false,
          message: 'Token has expired. Please login again.' 
        });
      }
      if (jwtError.name === 'JsonWebTokenError') {
        return res.status(401).json({ 
          success: false,
          message: 'Invalid token signature' 
        });
      }
      throw jwtError; // Re-throw unexpected errors
    }

    // Check token blacklist (logout invalidation)
    try {
      const TokenBlacklist = (await import('mongoose')).default.model('TokenBlacklist');
      const blacklisted = await TokenBlacklist.findOne({ token }).lean();
      if (blacklisted) {
        return res.status(401).json({ success: false, message: 'Token has been invalidated. Please login again.' });
      }
    } catch { /* model may not exist yet on first boot — skip silently */ }

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
    // HIGH-06 FIX: also check isAccountLocked — a locked user with a valid JWT
    // could bypass the login-time check without this middleware guard.
    if (user.isAccountLocked) {
      return res.status(403).json({
        success: false,
        message: 'Account locked — recovery request pending. Contact support.'
      });
    }

    // Attach user to request object for use in subsequent middleware/routes
    req.user = user;
    req.userId = user._id;

    
    // Merchant JWT contains { merchantId, isMerchant: true } — set by domains/merchant/merchant.routes.js /auth/login.
    // isMerchant is a JWT claim, NOT a User schema field. merchantAuth middleware handles Merchant JWTs.
    // This authenticate middleware is for User JWTs only (players, admin, sub-admin, queue manager).
    
    
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
      decoded = jwt.verify(token, JWT_SECRET);
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
 * Generate JWT token for user
 * 
 * @param {Object} user - User object from database
 * @param {Object} options - Additional options (expiresIn, etc.)
 * @returns {string} JWT token
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

  return jwt.sign(payload, JWT_SECRET, tokenOptions);
};

/**
 * Generate JWT token for merchant
 * 
 * @param {Object} merchant - Merchant object from database
 * @param {Object} options - Additional options
 * @returns {string} JWT token
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

  return jwt.sign(payload, JWT_SECRET, tokenOptions);
};

/**
 * Verify token without attaching to request (useful for API calls)
 * 
 * @param {string} token - JWT token string
 * @returns {Object|null} Decoded token payload or null if invalid
 */
const verifyToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
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
      const decoded = jwt.verify(token, JWT_SECRET);
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
 * Must be used AFTER merchantAuth (which already verifies the Merchant JWT and
 * checks merchantApprovalStatus === 'APPROVED'). This is therefore just a
 * safety check that merchantAuth ran first.
 *
 * NOTE: isMerchant is a JWT *claim* in the Merchant JWT, NOT a User schema field.
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
