// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * communication.admin.routes.js — Communication Platform admin surface
 * (BBEPS Phase 012): channel registry view, the Audit Feed, and the Admin
 * Activity Feed (both read-only projections over EnhancedAuditLog — the
 * audit data itself stays owned by its existing writers).
 * Mounted at /api/admin via routes/admin/index.js.
 */
import { express, mongoose, authenticate, isAdmin, isAdminOrSubAdmin } from '../../routes/admin/_adminShared.js';
import { listChannels } from './communication.service.js';

const router = express.Router();

// GET /api/admin/communication/channels — adapter registry state.
router.get('/communication/channels', authenticate, isAdminOrSubAdmin, async (req, res) => {
  res.json({ success: true, channels: listChannels() });
});

// GET /api/admin/communication/audit-feed?page=&limit=&category=&action=
// The Audit Feed: newest-first EnhancedAuditLog entries with filters.
router.get('/communication/audit-feed', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const filter = {};
    if (req.query.category) filter.category = req.query.category;
    if (req.query.action)   filter.action = req.query.action;

    const EnhancedAuditLog = mongoose.model('EnhancedAuditLog');
    const [entries, total] = await Promise.all([
      EnhancedAuditLog.find(filter).sort({ createdAt: -1 })
        .skip((page - 1) * limit).limit(limit).lean(),
      EnhancedAuditLog.countDocuments(filter),
    ]);
    res.json({ success: true, entries, total, page, pages: Math.ceil(total / limit) || 1 });
  } catch (error) {
    console.error('Audit feed error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch audit feed' });
  }
});

// GET /api/admin/communication/admin-activity?hours=24
// The Admin Activity Feed: what each admin actor did recently, grouped.
router.get('/communication/admin-activity', authenticate, isAdmin, async (req, res) => {
  try {
    const hours = Math.min(24 * 30, Math.max(1, parseInt(req.query.hours) || 24));
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const EnhancedAuditLog = mongoose.model('EnhancedAuditLog');
    const activity = await EnhancedAuditLog.aggregate([
      { $match: { createdAt: { $gte: since }, performedByRole: { $in: ['admin', 'subadmin'] } } },
      { $sort: { createdAt: -1 } },
      { $group: {
          _id: { performedBy: '$performedBy', name: '$performedByName' },
          actions: { $sum: 1 },
          lastActionAt: { $first: '$createdAt' },
          recent: { $push: { action: '$action', category: '$category', at: '$createdAt', success: '$success' } },
      } },
      { $project: {
          _id: 0,
          adminId: '$_id.performedBy',
          name: '$_id.name',
          actions: 1,
          lastActionAt: 1,
          recent: { $slice: ['$recent', 10] },
      } },
      { $sort: { lastActionAt: -1 } },
    ]);
    res.json({ success: true, hours, activity });
  } catch (error) {
    console.error('Admin activity feed error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch admin activity' });
  }
});

export default router;
