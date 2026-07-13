// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * ════════════════════════════════════════════════════════════════════════════
 * 👑 ADMIN SERVICE - Business Logic Layer
 * ════════════════════════════════════════════════════════════════════════════
 * 
 * Complete business logic for admin operations including:
 * - User management (roles, blocking, deletion)
 * - Balance adjustments
 * - KYC approval/rejection
 * - Sub-admin management
 * - Analytics and dashboard metrics
 * - Financial reporting
 * 
 * @module admin.service
 */

// ✅ FIX #40: Converted from CommonJS (module.exports) to ESM so it can be imported
//    in the ES Module project ("type": "module" in package.json).
import mongoose from 'mongoose';
// Communication Platform (Phase 012): notify() is the single user-messaging path.
import { notify } from '../domains/communication/communication.service.js';
// AQ-8: hash via the password authority (argon2id).
import { hashPassword } from '../domains/identity/password.util.js';

// Models are accessed via mongoose.model() to avoid circular dependency
function getModels() {
  return {
    User:             mongoose.model('User'),
    Transaction:      mongoose.model('Transaction'),
    Bet:              mongoose.model('Bet'),
    Cycle:            mongoose.model('Cycle'),
    PaymentOrder:         mongoose.model('PaymentOrder'),
    EnhancedAuditLog: mongoose.model('EnhancedAuditLog'),
    Merchant:         mongoose.model('Merchant'),
    // Dispute model removed — C-1
    Notification:     mongoose.model('Notification'),
  };
}

class AdminService {
  
  // ✅ FIX #40: Lazy model getters — resolve at call time, not at import time.
  //    This avoids "Model not registered" errors during startup before mongoose connects.
  get User()             { return mongoose.model('User'); }
  get Transaction()      { return mongoose.model('Transaction'); }
  get Bet()              { return mongoose.model('Bet'); }
  get Cycle()            { return mongoose.model('Cycle'); }
  get PaymentOrder()         { return mongoose.model('PaymentOrder'); }
  get EnhancedAuditLog() { return mongoose.model('EnhancedAuditLog'); }
  get Merchant()         { return mongoose.model('Merchant'); }
  // get Dispute() removed — C-1
  get Notification()     { return mongoose.model('Notification'); }

  /**
   * ════════════════════════════════════════════════════════════════════════════
   * 👥 USER MANAGEMENT
   * ════════════════════════════════════════════════════════════════════════════
   */

  /**
   * Assign roles to a user
   * @param {string} userId - User ID
   * @param {Array<string>} roles - Array of role names
   * @param {string} adminId - ID of admin performing action
   * @returns {Object} Updated user
   */
  async assignRoles(userId, roles, adminId) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      const oldRoles = user.roles || [];
      
      // Update roles
      user.roles = roles;
      
      // Update boolean flags based on roles
      user.isMerchant = roles.includes('merchant');
      user.isQueueManager = roles.includes('queue_manager');
      user.isMediator = roles.includes('mediator');
      user.isAdmin = roles.includes('admin');
      user.isSubAdmin = roles.includes('subadmin');
      
      await user.save();

      // Log action
      await this.createAuditLog({
        performedBy: adminId,
        action: 'ROLES_ASSIGNED',
        category: 'USER_MANAGEMENT',
        targetType: 'User',
        targetId: userId,
        targetName: user.username || user.mobile,
        changes: {
          before: { roles: oldRoles },
          after: { roles }
        }
      });

      return user;
    } catch (error) {
      throw new Error(`Failed to assign roles: ${error.message}`);
    }
  }

  /**
   * Block a user account
   * @param {string} userId - User ID
   * @param {string} reason - Reason for blocking
   * @param {string} adminId - ID of admin performing action
   * @returns {Object} Updated user
   */
  async blockUser(userId, reason, adminId) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      if (user.isBlocked) {
        throw new Error('User is already blocked');
      }

      user.isBlocked = true;
      user.blockReason = reason;
      user.blockedAt = new Date();
      user.blockedBy = adminId;
      await user.save();

      // Log action
      await this.createAuditLog({
        performedBy: adminId,
        action: 'USER_BLOCKED',
        category: 'USER_MANAGEMENT',
        targetType: 'User',
        targetId: userId,
        targetName: user.username || user.mobile,
        details: { reason },
        changes: {
          before: { isBlocked: false },
          after: { isBlocked: true, reason }
        }
      });

      // Send notification to user
      await notify({
        userId,
        type: 'ERROR',
        title: 'Account Blocked',
        message: `Your account has been blocked. ${reason ? `Reason: ${reason}` : 'Please contact support for details.'}`,
        relatedType: 'User'
      });

      return user;
    } catch (error) {
      throw new Error(`Failed to block user: ${error.message}`);
    }
  }

  /**
   * Unblock a user account
   * @param {string} userId - User ID
   * @param {string} adminId - ID of admin performing action
   * @returns {Object} Updated user
   */
  async unblockUser(userId, adminId) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      if (!user.isBlocked) {
        throw new Error('User is not blocked');
      }

      const oldReason = user.blockReason;

      user.isBlocked = false;
      user.blockReason = null;
      user.blockedAt = null;
      user.blockedBy = null;
      await user.save();

      // Log action
      await this.createAuditLog({
        performedBy: adminId,
        action: 'USER_UNBLOCKED',
        category: 'USER_MANAGEMENT',
        targetType: 'User',
        targetId: userId,
        targetName: user.username || user.mobile,
        details: { previousReason: oldReason },
        changes: {
          before: { isBlocked: true },
          after: { isBlocked: false }
        }
      });

      // Send notification to user
      await notify({
        userId,
        type: 'SUCCESS',
        title: 'Account Unblocked',
        message: 'Your account has been unblocked. You can now use all features.',
        relatedType: 'User'
      });

      return user;
    } catch (error) {
      throw new Error(`Failed to unblock user: ${error.message}`);
    }
  }

  /**
   * Delete a user account (soft delete - keep records)
   * @param {string} userId - User ID
   * @param {string} adminId - ID of admin performing action
   * @returns {Object} Result
   */
  async deleteUser(userId, adminId) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Check if user has pending orders or locked balance
      const pendingOrders = await PaymentOrder.countDocuments({
        userId,
        status: { $in: ['ASSIGNED', 'PROCESSING', 'PAID'] }
      });

      if (pendingOrders > 0) {
        throw new Error('Cannot delete user with pending orders');
      }

      if (user.lockedBalance > 0) {
        throw new Error('Cannot delete user with locked balance');
      }

      // Soft delete: block and mark as deleted
      user.isBlocked = true;
      user.blockReason = 'Account deleted by admin';
      user.status = 'SUSPENDED';
      user.mobile = `DELETED_${user.mobile}_${Date.now()}`; // Ensure uniqueness
      await user.save();

      // Log action
      await this.createAuditLog({
        performedBy: adminId,
        action: 'USER_DELETED',
        category: 'USER_MANAGEMENT',
        targetType: 'User',
        targetId: userId,
        targetName: user.username,
        details: {
          depositBalance: user.depositBalance,
          winningsBalance: user.winningsBalance,
          totalBets: await Bet.countDocuments({ userId }),
          totalTransactions: await Transaction.countDocuments({ userId })
        }
      });

      return { success: true, message: 'User account deleted successfully' };
    } catch (error) {
      throw new Error(`Failed to delete user: ${error.message}`);
    }
  }

  /**
   * ════════════════════════════════════════════════════════════════════════════
   * ✅ KYC MANAGEMENT
   * ════════════════════════════════════════════════════════════════════════════
   */

  /**
   * Approve KYC submission
   * @param {string} userId - User ID
   * @param {string} adminId - ID of admin performing action
   * @returns {Object} Updated user
   */
  async approveKYC(userId, adminId) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      if (user.kycStatus === 'APPROVED') {
        throw new Error('KYC is already approved');
      }

      if (user.kycStatus !== 'PENDING_APPROVAL') {
        throw new Error('KYC is not ready for approval');
      }

      user.kycStatus = 'APPROVED';
      if (user.status === 'PENDING_KYC') {
        user.status = 'ACTIVE';
      }
      await user.save();

      // Log action
      await this.createAuditLog({
        performedBy: adminId,
        action: 'KYC_APPROVED',
        category: 'KYC',
        targetType: 'User',
        targetId: userId,
        targetName: user.kycData?.nameOnAadhaar || user.username,
        details: {
          aadhaarNumber: user.kycData?.aadhaarNumber,
          panNumber: user.kycData?.panNumber
        }
      });

      // Send notification to user
      await notify({
        userId,
        type: 'SUCCESS',
        title: 'KYC Approved',
        message: 'Your KYC verification has been approved. You can now access all features.',
        relatedType: 'KYC'
      });

      return user;
    } catch (error) {
      throw new Error(`Failed to approve KYC: ${error.message}`);
    }
  }

  /**
   * Reject KYC submission
   * @param {string} userId - User ID
   * @param {string} reason - Rejection reason
   * @param {string} adminId - ID of admin performing action
   * @returns {Object} Updated user
   */
  async rejectKYC(userId, reason, adminId) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      if (user.kycStatus === 'APPROVED') {
        throw new Error('Cannot reject already approved KYC');
      }

      user.kycStatus = 'REJECTED';
      if (!user.kycData) {
        user.kycData = {};
      }
      user.kycData.rejectionReason = reason;
      await user.save();

      // Log action
      await this.createAuditLog({
        performedBy: adminId,
        action: 'KYC_REJECTED',
        category: 'KYC',
        targetType: 'User',
        targetId: userId,
        targetName: user.kycData?.nameOnAadhaar || user.username,
        details: { reason }
      });

      // Send notification to user
      await notify({
        userId,
        type: 'ERROR',
        title: 'KYC Rejected',
        message: `Your KYC verification has been rejected. Reason: ${reason}. Please resubmit with correct information.`,
        relatedType: 'KYC'
      });

      return user;
    } catch (error) {
      throw new Error(`Failed to reject KYC: ${error.message}`);
    }
  }

  /**
   * Get KYC queue (pending approvals)
   * @returns {Array} List of users pending KYC
   */
  async getKYCQueue() {
    try {
      const queue = await User.find({
        kycStatus: 'PENDING_APPROVAL',
        'kycData.submittedAt': { $exists: true }
      })
        .select('username mobile kycData profilePic joinedAt')
        .sort({ 'kycData.submittedAt': 1 })
        .limit(100);

      return queue;
    } catch (error) {
      throw new Error(`Failed to get KYC queue: ${error.message}`);
    }
  }

  /**
   * ════════════════════════════════════════════════════════════════════════════
   * 🎯 SUB-ADMIN MANAGEMENT
   * ════════════════════════════════════════════════════════════════════════════
   */

  /**
   * Create a new sub-admin
   * @param {Object} data - Sub-admin data (username, mobile, password, permissions)
   * @param {string} adminId - ID of admin creating the sub-admin
   * @returns {Object} New sub-admin user
   */
  async createSubAdmin(data, adminId) {
    try {
      const { username, mobile, password, permissions } = data;

      // Check if user already exists
      const existing = await User.findOne({ mobile });
      if (existing) {
        throw new Error('User with this mobile number already exists');
      }

      // Hash password
      const passwordHash = await hashPassword(password); // AQ-8: argon2id (was bcrypt cost 12)

      // Create sub-admin user
      const subAdmin = await User.create({
        username,
        mobile,
        passwordHash,
        isSubAdmin: true,
        roles: ['subadmin'],
        subAdminPermissions: permissions || {},
        status: 'ACTIVE'
      });

      // Log action
      await this.createAuditLog({
        performedBy: adminId,
        action: 'SUBADMIN_CREATED',
        category: 'USER_MANAGEMENT',
        targetType: 'User',
        targetId: subAdmin._id.toString(),
        targetName: username,
        details: { mobile, permissions }
      });

      return subAdmin;
    } catch (error) {
      throw new Error(`Failed to create sub-admin: ${error.message}`);
    }
  }

  /**
   * Update sub-admin permissions
   * @param {string} subAdminId - Sub-admin user ID
   * @param {Object} permissions - New permissions object
   * @param {string} adminId - ID of admin updating permissions
   * @returns {Object} Updated sub-admin
   */
  async updateSubAdminPermissions(subAdminId, permissions, adminId) {
    try {
      const subAdmin = await User.findById(subAdminId);
      if (!subAdmin) {
        throw new Error('Sub-admin not found');
      }

      if (!subAdmin.isSubAdmin) {
        throw new Error('User is not a sub-admin');
      }

      const oldPermissions = subAdmin.subAdminPermissions || {};
      subAdmin.subAdminPermissions = { ...oldPermissions, ...permissions };
      await subAdmin.save();

      // Log action
      await this.createAuditLog({
        performedBy: adminId,
        action: 'SUBADMIN_PERMISSIONS_UPDATED',
        category: 'USER_MANAGEMENT',
        targetType: 'User',
        targetId: subAdminId,
        targetName: subAdmin.username,
        changes: {
          before: oldPermissions,
          after: subAdmin.subAdminPermissions
        }
      });

      return subAdmin;
    } catch (error) {
      throw new Error(`Failed to update permissions: ${error.message}`);
    }
  }

  /**
   * Delete a sub-admin
   * @param {string} subAdminId - Sub-admin user ID
   * @param {string} adminId - ID of admin deleting the sub-admin
   * @returns {Object} Result
   */
  async deleteSubAdmin(subAdminId, adminId) {
    try {
      const subAdmin = await User.findById(subAdminId);
      if (!subAdmin) {
        throw new Error('Sub-admin not found');
      }

      if (!subAdmin.isSubAdmin) {
        throw new Error('User is not a sub-admin');
      }

      // Remove sub-admin role
      subAdmin.isSubAdmin = false;
      subAdmin.roles = subAdmin.roles.filter(r => r !== 'subadmin');
      subAdmin.subAdminPermissions = {};
      subAdmin.isBlocked = true;
      subAdmin.blockReason = 'Sub-admin access revoked';
      await subAdmin.save();

      // Log action
      await this.createAuditLog({
        performedBy: adminId,
        action: 'SUBADMIN_DELETED',
        category: 'USER_MANAGEMENT',
        targetType: 'User',
        targetId: subAdminId,
        targetName: subAdmin.username
      });

      return { success: true, message: 'Sub-admin deleted successfully' };
    } catch (error) {
      throw new Error(`Failed to delete sub-admin: ${error.message}`);
    }
  }

  /**
   * Get all sub-admins
   * @returns {Array} List of sub-admins
   */
  async getSubAdmins() {
    try {
      const subAdmins = await User.find({ isSubAdmin: true })
        .select('username mobile subAdminPermissions isBlocked lastLogin joinedAt')
        .sort({ joinedAt: -1 });

      return subAdmins;
    } catch (error) {
      throw new Error(`Failed to get sub-admins: ${error.message}`);
    }
  }

  /**
   * ════════════════════════════════════════════════════════════════════════════
   * 📊 ANALYTICS & DASHBOARD
   * ════════════════════════════════════════════════════════════════════════════
   */

  /**
   * Get dashboard metrics
   * @returns {Object} Dashboard metrics
   */
  async getDashboardMetrics() {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const [
        totalUsers,
        activeUsers,
        blockedUsers,
        pendingKYC,
        totalMerchants,
        activeMerchants,
        totalBets,
        todayBets,
        totalVolume,
        todayVolume,
        pendingOrders,
        activeDisputes
      ] = await Promise.all([
        User.countDocuments({}),
        User.countDocuments({ status: 'ACTIVE', isBlocked: false }),
        User.countDocuments({ isBlocked: true }),
        User.countDocuments({ kycStatus: 'PENDING_APPROVAL' }),
        Merchant.countDocuments({}),
        Merchant.countDocuments({ status: 'ACTIVE', isOnline: true }),
        Bet.countDocuments({}),
        Bet.countDocuments({ timestamp: { $gte: today } }),
        Bet.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
        Bet.aggregate([
          { $match: { timestamp: { $gte: today } } },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        PaymentOrder.countDocuments({ 
          status: { $in: ['ASSIGNED', 'PROCESSING'] }
        }),
        Promise.resolve(0), // Dispute model removed — C-1; disputes tracked in PaymentOrder
      ]);

      return {
        users: {
          total: totalUsers,
          active: activeUsers,
          blocked: blockedUsers,
          pendingKYC
        },
        merchants: {
          total: totalMerchants,
          active: activeMerchants
        },
        betting: {
          totalBets,
          todayBets,
          totalVolume: totalVolume[0]?.total || 0,
          todayVolume: todayVolume[0]?.total || 0
        },
        operations: {
          pendingOrders,
          // activeDisputes removed — C-1
        }
      };
    } catch (error) {
      throw new Error(`Failed to get dashboard metrics: ${error.message}`);
    }
  }

  /**
   * Get financial data for analytics
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @returns {Object} Financial data
   */
  async getFinancialData(startDate, endDate) {
    try {
      // Aggregate transactions by type and date
      const transactions = await Transaction.aggregate([
        {
          $match: {
            timestamp: { $gte: startDate, $lte: endDate },
            status: 'SUCCESS'
          }
        },
        {
          $group: {
            _id: {
              type: '$type',
              date: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } }
            },
            count: { $sum: 1 },
            totalAmount: { $sum: '$amount' }
          }
        },
        { $sort: { '_id.date': 1 } }
      ]);

      // Aggregate betting data
      const bettingData = await Bet.aggregate([
        {
          $match: {
            timestamp: { $gte: startDate, $lte: endDate }
          }
        },
        {
          $group: {
            _id: {
              status: '$status',
              date: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } }
            },
            count: { $sum: 1 },
            totalAmount: { $sum: '$amount' },
            totalPayout: { $sum: '$payout' }
          }
        },
        { $sort: { '_id.date': 1 } }
      ]);

      return {
        transactions,
        betting: bettingData
      };
    } catch (error) {
      throw new Error(`Failed to get financial data: ${error.message}`);
    }
  }

  /**
   * ════════════════════════════════════════════════════════════════════════════
   * 📝 AUDIT LOGGING
   * ════════════════════════════════════════════════════════════════════════════
   */

  /**
   * Create an audit log entry
   * @param {Object} logData - Audit log data
   * @returns {Object} Created audit log
   */
  async createAuditLog(logData) {
    try {
      const admin = await User.findById(logData.performedBy);
      
      const auditLog = await EnhancedAuditLog.create({
        ...logData,
        performedByName: admin?.username || admin?.mobile || 'Unknown',
        performedByRole: admin?.isAdmin ? 'admin' : admin?.isSubAdmin ? 'subadmin' : 'user',
        timestamp: new Date()
      });

      return auditLog;
    } catch (error) {
      console.error('Failed to create audit log:', error);
      // Don't throw - logging failure shouldn't break the main operation
      return null;
    }
  }

  /**
   * Get audit logs with filters
   * @param {Object} filters - Filter options
   * @returns {Array} Audit logs
   */
  async getAuditLogs(filters = {}) {
    try {
      const { 
        performedBy, 
        category, 
        action, 
        startDate, 
        endDate,
        limit = 100,
        skip = 0
      } = filters;

      const query = {};

      if (performedBy) query.performedBy = performedBy;
      if (category) query.category = category;
      if (action) query.action = action;
      if (startDate || endDate) {
        query.timestamp = {};
        if (startDate) query.timestamp.$gte = new Date(startDate);
        if (endDate) query.timestamp.$lte = new Date(endDate);
      }

      const logs = await EnhancedAuditLog.find(query)
        .sort({ timestamp: -1 })
        .limit(limit)
        .skip(skip)
        .populate('performedBy', 'username mobile');

      const total = await EnhancedAuditLog.countDocuments(query);

      return { logs, total };
    } catch (error) {
      throw new Error(`Failed to get audit logs: ${error.message}`);
    }
  }
}

// ✅ FIX #40: ESM export default (was module.exports)
export default new AdminService();
