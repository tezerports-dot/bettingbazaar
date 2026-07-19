// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** audit.admin.routes.js — Audit logs */
import { express, mongoose, authenticate, isAdmin, isAdminOrSubAdmin, getModels } from './_adminShared.js';
import adminService from '../../services/admin.service.js';

const router = express.Router();

router.get('/audit-logs', authenticate, isAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, category, action, adminId, startDate, endDate } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const query = {};
    if (category)   query.category    = category;
    if (action)     query.action      = action;
    if (adminId)    query.performedBy = adminId;
    // FIX DATA 3.9: EnhancedAuditLog schema uses 'timestamp', not 'createdAt'. Wrong field = empty results.
    if (startDate || endDate) {
      query.timestamp = {};
      if (startDate) query.timestamp.$gte = new Date(startDate);
      if (endDate)   query.timestamp.$lte = new Date(endDate);
    }
    
    const { EnhancedAuditLog } = getModels();
    
    const [logs, total] = await Promise.all([
      EnhancedAuditLog.find(query)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate('performedBy', 'username mobile'),
      EnhancedAuditLog.countDocuments(query)
    ]);
    
    res.json({
      success: true,
      logs,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get audit logs error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch audit logs' });
  }
});


// ─── POST /api/admin/branding/images ────────────────────────────────────────
// Register a CDN image URL into the library (called AFTER the S3 presigned-URL
// upload flow completes on the client).  Previously this route saved to
// SystemConfig.cdnImages while confirm-upload saved to CDNImage model — the two
// collections were completely separate, so images uploaded via CDNManager never
// appeared alongside branding logos and vice-versa.  Unified to CDNImage model.
//
export default router;
