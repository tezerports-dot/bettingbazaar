// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/** audit.admin.routes.js — Audit logs */
import { express, authenticate, isAdmin } from './_adminShared.js';
import { db } from '#db';

const router = express.Router();

router.get('/audit-logs', authenticate, isAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, category, action, adminId, startDate, endDate } = req.query;

    // A malformed date used to become `new Date('...')` => Invalid Date, which
    // silently matched nothing. Null it instead, so a bad filter is ignored
    // rather than returning an empty page an auditor would read as "no
    // activity in that window".
    const at = (v) => {
      if (!v) return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    };

    // The page and its total come from ONE statement (COUNT(*) OVER ()), so an
    // entry written mid-request cannot make the page count disagree with the
    // rows — in the one place where a row nobody can account for is the point.
    const result = await db.audit.feed({
      category: category || null,
      action: action || null,
      performedBy: adminId || null,
      since: at(startDate),
      until: at(endDate),
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
    });

    res.json({
      success: true,
      logs: result.entries,
      pagination: {
        total: result.total,
        page: result.page,
        limit: result.size,
        pages: result.pages,
        // True when the requested page is past the end. Without it a caller
        // cannot tell "no entries match" from "you paged too far".
        beyondEnd: result.beyondEnd,
      },
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
