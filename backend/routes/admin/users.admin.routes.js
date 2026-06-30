// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** users.admin.routes.js — User management, balance adjust, block/unblock, phantom, queue managers */
import { express, mongoose, authenticate, isAdmin, isAdminOrSubAdmin, getModels } from './_adminShared.js';
import { adminAdjustment } from '../../services/walletAuthority.service.js';

const router = express.Router();


/**
 * POST /api/admin/users/:userId/adjust-balance
 * ACID-SAFE: delegates to wallet.service.adminAdjust() which wraps in session.withTransaction().
 * The original direct user.save() + Transaction.create() sequence was NOT atomic.
 */
router.post('/users/:userId/adjust-balance', authenticate, isAdmin, async (req, res) => {
  try {
    const { amount, reason, walletType } = req.body;
    const userId = req.params.userId;
    const { User } = getModels();
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const field = (walletType === 'winnings' || walletType === 'winningsBalance')
      ? 'winningsBalance' : 'depositBalance';

    if (amount < 0 && (user[field] || 0) + amount < 0) {
      return res.status(400).json({ success: false, message: `Insufficient ${field}` });
    }

    const adjustmentId = new (await import('mongoose')).default.Types.ObjectId().toString();
    const type = amount >= 0 ? 'CREDIT' : 'DEBIT';
    // adminAdjust is ACID-safe: wraps debitForBet/creditWinnings in session.withTransaction()
    await adminAdjustment(req.user._id, userId, type, field, Math.abs(amount), reason || `Admin adjustment`, adjustmentId);

    const updated = await User.findById(userId).select('depositBalance winningsBalance').lean();
    if (global.io) {
      global.io.to(`user-${userId}`).emit('user_update', {
        depositBalance: updated.depositBalance, winningsBalance: updated.winningsBalance, server_ts: Date.now()
      });
      global.io.to('admin-room').emit('admin_stats_delta', { type: 'BALANCE_ADJUSTED', server_ts: Date.now() });
    }
    res.json({ success: true, newBalance: updated });
  } catch (error) {
    console.error('Adjust balance error:', error);
    res.status(500).json({ success: false, message: 'Failed to adjust balance' });
  }
});
router.get('/users', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { User } = getModels();
    const { status, kycStatus, search, page = 1, limit = 50 } = req.query;
    
    // Merchants are a completely separate entity with their own Merchant model and
    // auth system. They are excluded from the player-users list two ways:
    //   1. Users created via POST /admin/merchants/create get roles:['merchant']
    //   2. Admin/subadmin Users are excluded by isAdmin/isSubAdmin flags
    // We filter on roles so the list shows only genuine player accounts.
    const filter = { roles: { $ne: 'merchant' } };
    if (status && status !== 'all') filter.status = status;
    if (kycStatus && kycStatus !== 'all') filter.kycStatus = kycStatus;
    if (search) {
      // Escape regex special characters to prevent ReDoS attacks
      const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 50);
      filter.$or = [
        { username: { $regex: escapedSearch, $options: 'i' } },
        { mobile: { $regex: escapedSearch, $options: 'i' } }
      ];
    }

    const users = await User.find(filter)
      .select('-passwordHash -twoFactorSecret')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await User.countDocuments(filter);

    res.json({
      success: true,
      users,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch users' });
  }
});

// Get single user
router.get('/users/:userId', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { User, Bet, Transaction } = getModels();
    const user = await User.findById(req.params.userId).select('-passwordHash -twoFactorSecret');
    
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Get user's recent activity
    const recentBets = await Bet.find({ userId: user._id }).sort({ createdAt: -1 }).limit(10);
    const recentTransactions = await Transaction.find({ userId: user._id }).sort({ createdAt: -1 }).limit(10);

    res.json({
      success: true,
      user,
      recentBets,
      recentTransactions
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch user' });
  }
});

// Update user roles
router.put('/users/:userId/roles', authenticate, isAdmin, async (req, res) => {
  try {
    const { User } = getModels();
    const { roles } = req.body;
    
    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    user.roles         = roles;
    user.isAdmin       = roles.includes('admin');
    user.isSubAdmin    = roles.includes('subadmin');
    // NOTE: isMerchant is NOT a User field. Merchant auth uses the Merchant model.
    // Setting roles:['merchant'] on a User doc only affects which users appear in
    // the player-users list (they are excluded). It does NOT grant merchant panel access.
    user.isQueueManager = roles.includes('queue_manager');
    
    await user.save();

    res.json({ success: true, user });
  } catch (error) {
    console.error('Update roles error:', error);
    res.status(500).json({ success: false, message: 'Failed to update roles' });
  }
});

// Block user
router.put('/users/:userId/block', authenticate, isAdmin, async (req, res) => {
  try {
    const { User } = getModels();
    const { reason } = req.body;
    
    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    user.isBlocked = true;
    user.status = 'BLOCKED';
    user.blockReason = reason;
    user.blockedAt = new Date();
    user.blockedBy = req.user._id;
    await user.save();

    res.json({ success: true, message: 'User blocked successfully' });
  } catch (error) {
    console.error('Block user error:', error);
    res.status(500).json({ success: false, message: 'Failed to block user' });
  }
});

// Unblock user — with optional warningCount reset (Section 13.4 of Migration Spec)
router.put('/users/:userId/unblock', authenticate, isAdmin, async (req, res) => {
  try {
    const { User } = getModels();
    const { resetWarnings = false } = req.body;

    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    user.isBlocked   = false;
    user.status      = 'ACTIVE';
    user.blockReason = null;
    user.blockedAt   = null;
    user.blockedBy   = null;
    if (resetWarnings) {
      user.warningCount = 0;
    }
    await user.save();

    // Audit log
    try {
      const Audit = mongoose.model('AuditLog');
      await Audit.create({
        actorId:   req.user._id,
        actorType: 'ADMIN',
        action:    'USER_UNBLOCK',
        targetId:  user._id,
        targetType: 'User',
        meta: { resetWarnings },
        timestamp: new Date(),
      });
    } catch (_) { /* audit failure never blocks response */ }

    res.json({
      success: true,
      message: `User unblocked${resetWarnings ? ' and warnings reset' : ''}`,
      warningCount: user.warningCount,
    });
  } catch (error) {
    console.error('Unblock user error:', error);
    res.status(500).json({ success: false, message: 'Failed to unblock user' });
  }
});

// Delete user
router.delete('/users/:userId', authenticate, isAdmin, async (req, res) => {
  try {
    const { User, Bet, Transaction } = getModels();
    
    const user = await User.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Soft delete — mark as deleted but keep data for audit trail
    user.isDeleted = true;
    user.deletedAt = new Date();
    user.deletedBy = req.user._id;
    // ✅ FIX #16: 'DELETED' is now in the User status enum (models/user.model.js)
    user.status = 'DELETED';
    await user.save();

    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete user' });
  }
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 📋 KYC MANAGEMENT
 * ════════════════════════════════════════════════════════════════════════════
 */

// Get KYC queue
router.get('/phantom-agents', authenticate, isAdmin, async (req, res) => {
  try {
    const { User } = getModels();
    
    const phantomAgents = await User.find({
      phantomAccess: { $ne: 'NONE' }
    }).select('-passwordHash -twoFactorSecret');
    
    res.json({ success: true, agents: phantomAgents });
  } catch (error) {
    console.error('Get phantom agents error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch phantom agents' });
  }
});

// Assign phantom agent role
router.post('/users/:userId/phantom-access', authenticate, isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { accessLevel } = req.body; // '30_MIN', 'FULL_DAY', 'BOTH', 'NONE'
    const { User } = getModels();
    
    const validLevels = ['NONE', '30_MIN', 'FULL_DAY', 'BOTH'];
    if (!validLevels.includes(accessLevel)) {
      return res.status(400).json({
        success: false,
        message: `Invalid access level. Must be: ${validLevels.join(', ')}`
      });
    }
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    user.phantomAccess = accessLevel;
    await user.save();
    
    res.json({
      success: true,
      message: `Phantom access updated to ${accessLevel}`,
      user
    });
  } catch (error) {
    console.error('Assign phantom access error:', error);
    res.status(500).json({ success: false, message: 'Failed to assign phantom access' });
  }
});

// Get phantom betting statistics
router.get('/analytics/phantom-stats', authenticate, isAdmin, async (req, res) => {
  try {
    const { Bet, Cycle } = getModels();
    
    // Get phantom bet statistics
    const phantomStats = await Bet.aggregate([
      { $match: { isPhantom: true } },
      {
        $group: {
          _id: '$cycleId',
          totalPhantomBets: { $sum: 1 },
          totalPhantomAmount: { $sum: '$amount' },
          delhiPhantom: {
            $sum: { $cond: [{ $eq: ['$side', 'DELHI'] }, '$amount', 0] }
          },
          bombayPhantom: {
            $sum: { $cond: [{ $eq: ['$side', 'BOMBAY'] }, '$amount', 0] }
          }
        }
      },
      { $sort: { _id: -1 } },
      { $limit: 10 }
    ]);
    
    res.json({ success: true, stats: phantomStats });
  } catch (error) {
    console.error('Get phantom stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch phantom stats' });
  }
});

/**
 * ════════════════════════════════════════════════════════════════════════════
 * 📋 QUEUE MANAGER OPERATIONS
 * ════════════════════════════════════════════════════════════════════════════
 */

// Get all queue managers
router.get('/queue-managers', authenticate, isAdmin, async (req, res) => {
  try {
    const { User } = getModels();
    
    const queueManagers = await User.find({
      isQueueManager: true
    }).select('-passwordHash -twoFactorSecret');
    
    res.json({ success: true, managers: queueManagers });
  } catch (error) {
    console.error('Get queue managers error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch queue managers' });
  }
});

// Assign queue manager role
router.post('/users/:userId/queue-manager', authenticate, isAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { enable } = req.body; // true or false
    const { User } = getModels();
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    user.isQueueManager = enable;
    await user.save();
    
    res.json({
      success: true,
      message: enable ? 'Queue manager role assigned' : 'Queue manager role removed',
      user
    });
  } catch (error) {
    console.error('Assign queue manager error:', error);
    res.status(500).json({ success: false, message: 'Failed to assign queue manager role' });
  }
});

// ─── GET /api/admin/payment-queue ──────────────────────────────────────────────
// Returns ALL orders grouped by status with summary stats — different from
// /queue/pending-orders which returns only PENDING orders for the assignment
// workflow. QueueDashboard "Queue Overview" tab uses this for a full snapshot.
router.get('/users/:userId/transactions', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 50 } = req.query;
    const { Transaction, Bet, PaymentOrder, Cycle } = getModels();
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // FIX 6: Fetch all three sources in parallel — admin needs full picture
    const [transactions, bets, orders] = await Promise.all([
      Transaction.find({ userId }).sort({ timestamp: -1 }).lean(),
      Bet.find({ userId, isPhantom: { $ne: true } }).sort({ createdAt: -1 }).lean(),
      PaymentOrder.find({ userId }).populate('merchantId', 'username name mobile').sort({ createdAt: -1 }).lean(),
    ]);

    // Join cycle metadata for bets
    const cycleIds = [...new Set(bets.map((b) => b.cycleId).filter(Boolean))];
    const cycles   = cycleIds.length
      ? await Cycle.find({ cycleId: { $in: cycleIds } }).select('cycleId type startTime endTime status winner').lean()
      : [];
    const cycleMap = Object.fromEntries(cycles.map((c) => [c.cycleId, c]));

    // Normalise into unified shape
    const normTx = transactions.map((t) => ({
      _id: t._id, source: 'transaction',
      type: t.type, amount: t.amount, status: t.status,
      date: t.timestamp || t.createdAt,
      referenceId: t.referenceId, walletType: t.walletType, note: t.note,
    }));

    const normBets = bets.map((b) => ({
      _id: b._id, source: 'bet',
      type: `BET_${(b.side || 'PLACED').toUpperCase()}`,
      amount: b.amount, status: b.status, date: b.createdAt,
      side: b.side, payout: b.payout, cycleId: b.cycleId,
      cycleType:   cycleMap[b.cycleId]?.type,
      cycleWinner: cycleMap[b.cycleId]?.winner,
    }));

    const normOrders = orders.map((o) => ({
      _id: o._id, source: 'p2p_order',
      type: `P2P_${o.type}`, amount: o.amount, status: o.status, date: o.createdAt,
      orderId: o.orderId,
      merchantName:   o.merchantId?.name || o.merchantId?.username || 'Unknown',
      merchantMobile: o.merchantId?.mobile,
    }));

    // Merge → sort by date desc → paginate
    const all = [...normTx, ...normBets, ...normOrders]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const total     = all.length;
    const paginated = all.slice(skip, skip + parseInt(limit));

    res.json({ success: true, transactions: paginated, pagination: { total, page: parseInt(page), limit: parseInt(limit) } });
  } catch (error) {
    console.error('Get user transactions error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch user transactions' });
  }
});

// Add CDN URL to library (no file upload)

export default router;
