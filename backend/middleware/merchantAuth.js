// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ═══════════════════════════════════════════════════════════════════════
 * 🔐 MERCHANT AUTHENTICATION MIDDLEWARE
 * ═══════════════════════════════════════════════════════════════════════
 * 
 * Verifies:
 * 1. Valid PASETO token exists
 * 2. User has merchant role
 * 3. Merchant account is active
 * 4. Merchant is not suspended/blocked
 * 
 * Attaches to req:
 * - req.user: User document
 * - req.merchant: Merchant document
 * 
 * @module merchantAuth
 */

// AQ-2: verify via the single PASETO authority (Ed25519 signature + iss/aud stamped).
import { verifyJwt } from '../domains/identity/jwt.util.js';
import { isTokenRevoked } from '../domains/identity/auth.middleware.js';
import mongoose from 'mongoose';

/**
 * Merchant authentication middleware
 * 
 * Usage:
 * ```javascript
 * router.get('/orders', merchantAuth, async (req, res) => {
 *   // req.user and req.merchant are available here
 * });
 * ```
 */
// OPTION A: reads Merchant doc only — zero User lookup
export const merchantAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer '))
      return res.status(401).json({ success: false, message: 'Authentication required.' });

    const token = authHeader.replace('Bearer ', '');

    let decoded;
    try { decoded = verifyJwt(token); }
    catch (e) {
      return res.status(401).json({ success: false,
        message: e.name === 'TokenExpiredError' ? 'Token expired. Please login again.' : 'Invalid token.' });
    }
    if (await isTokenRevoked(token)) {
      return res.status(401).json({ success: false, message: 'Token has been invalidated. Please login again.' });
    }

    if (!decoded.isMerchant || !decoded.merchantId)
      return res.status(403).json({ success: false, message: 'Merchant token required.' });

    const merchant = await mongoose.model('Merchant').findById(decoded.merchantId);
    if (!merchant)
      return res.status(404).json({ success: false, message: 'Merchant account not found.' });

    const statusMsgs = {
      SUSPENDED: 'Account suspended. Contact support.',
      INACTIVE:  'Account inactive. Contact support.',
      REJECTED:  'Account rejected. Contact support.',
      PENDING:   'Account pending admin approval.',
    };
    if (statusMsgs[merchant.status] || merchant.merchantApprovalStatus !== 'APPROVED')
      return res.status(403).json({ success: false,
        message: statusMsgs[merchant.status] || 'Account not approved.' });

    req.merchant   = merchant;
    req.merchantId = merchant._id;
    req.userId     = merchant.userId; 
    next();
  } catch (error) {
    console.error('❌ Merchant auth error:', error);
    res.status(500).json({ success: false, message: 'Authentication failed.' });
  }
};

/**
 * Optional: Middleware to check if merchant is online
 * Use this for endpoints that require merchant to be actively online
 */
export const requireOnline = (req, res, next) => {
  if (!req.merchant) {
    return res.status(401).json({
      success: false,
      message: 'Merchant authentication required'
    });
  }
  
  if (!req.merchant.isOnline) {
    return res.status(403).json({
      success: false,
      message: 'You must be online to perform this action. Please toggle your online status.'
    });
  }
  
  next();
};

/**
 * Optional: Middleware to check specific merchant permissions
 * Use this for endpoints that require specific capabilities
 */
export const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.merchant) {
      return res.status(401).json({
        success: false,
        message: 'Merchant authentication required'
      });
    }
    
    // Check permission
    switch (permission) {
      case 'ACCEPT_DEPOSITS':
        if (!req.merchant.acceptsDeposits) {
          return res.status(403).json({
            success: false,
            message: 'You are not authorized to process deposits. Please update your merchant settings.'
          });
        }
        break;
        
      case 'ACCEPT_WITHDRAWALS':
        if (!req.merchant.acceptsWithdrawals) {
          return res.status(403).json({
            success: false,
            message: 'You are not authorized to process withdrawals. Please update your merchant settings.'
          });
        }
        break;
        
      default:
        return res.status(400).json({
          success: false,
          message: 'Invalid permission check'
        });
    }
    
    next();
  };
};

export default { merchantAuth, requireOnline, requirePermission };
