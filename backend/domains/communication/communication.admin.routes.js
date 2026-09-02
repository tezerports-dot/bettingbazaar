// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * communication.admin.routes.js — Communication Platform admin surface
 * (BBEPS Phase 012): channel registry view, the Audit Feed, and the Admin
 * Activity Feed (both read-only projections over the enhanced audit trail —
 * the audit data itself stays owned by its existing writers).
 * Mounted at /api/admin via routes/admin/index.js.
 */
import { express, authenticate, isAdmin, isAdminOrSubAdmin } from '../../routes/admin/_adminShared.js';
import { db } from '#db';
import { listChannels } from './communication.service.js';

const router = express.Router();

// GET /api/admin/communication/channels — adapter registry state.
router.get('/communication/channels', authenticate, isAdminOrSubAdmin, async (req, res) => {
  res.json({ success: true, channels: listChannels() });
});

// GET /api/admin/communication/audit-feed?page=&limit=&category=&action=
// The Audit Feed: newest-first audit entries with filters.
router.get('/communication/audit-feed', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const filter = {};
    if (req.query.category) filter.category = req.query.category;
    if (req.query.action)   filter.action = req.query.action;
    if (req.query.admin)    filter.performedBy = req.query.admin;

    // The page and its total come from ONE statement. The two reads this
    // replaced ran concurrently, so an entry written between them handed the
    // auditor a page count that did not match the rows in front of them.
    const feed = await db.audit.feed({ ...filter, page, limit });
    res.json({ success: true, ...feed });
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

    // Ten entries per actor are taken by the WINDOW, before the grouping. The
    // pipeline this replaced pushed every matching entry into an array per
    // admin and sliced ten off the front afterwards, materialising a month of
    // audit history in memory to answer with a handful of rows.
    const activity = await db.audit.adminActivity({ hours });
    res.json({ success: true, hours, activity });
  } catch (error) {
    console.error('Admin activity feed error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch admin activity' });
  }
});

export default router;
