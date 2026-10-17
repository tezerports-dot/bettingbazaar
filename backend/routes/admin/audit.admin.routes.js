// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/** audit.admin.routes.js — Audit logs */
import { express, authenticate, hasPermission } from './_adminShared.js';
import { db } from '#db';
import { toCsv } from '../../domains/reporting/csv.util.js';
import { respondError } from '../../shared/httpError.js';

const router = express.Router();

router.get('/audit-logs', authenticate, hasPermission('canViewAuditLogs'), async (req, res) => {
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

// GET /api/admin/audit-logs.csv?category=&action=&adminId=&startDate=&endDate=
// The whole trail for the filters, from the same reads as the table (§2 "A
// table's CSV"), newest first, at most AUDIT_CSV_MAX rows.
const AUDIT_CSV_MAX = 50000;
router.get('/audit-logs.csv', authenticate, hasPermission('canViewAuditLogs'), async (req, res) => {
  try {
    const { category, action, adminId, startDate, endDate } = req.query;
    const at = (v) => {
      if (!v) return null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const rows = [];
    for (let page = 1, pages = 1; page <= pages && rows.length < AUDIT_CSV_MAX; page += 1) {
      const chunk = await db.audit.feed({
        category: category || null, action: action || null, performedBy: adminId || null,
        since: at(startDate), until: at(endDate), page, limit: 200,
      });
      pages = chunk.pages;
      for (const l of chunk.entries) {
        rows.push({
          time: l.createdAt ? new Date(l.createdAt).toISOString() : '',
          by: l.performedByName || l.performedBy || '',
          role: l.performedByRole || '',
          category: l.category || '',
          action: l.action || '',
          target: [l.targetType, l.targetName || l.targetId].filter(Boolean).join(' '),
          success: l.success === false ? 'no' : 'yes',
          details: l.details ? JSON.stringify(l.details) : '',
          ip: l.ip || '',
        });
      }
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${startDate || 'start'}-${endDate || 'now'}.csv"`);
    res.send(toCsv(rows));
  } catch (error) {
    respondError(res, error, 'GET /admin/audit-logs.csv', { message: 'Could not build the export.' });
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
