// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * reporting.admin.routes.js — Reporting Platform admin surface (BBEPS
 * Phase 012, Enterprise Services tier). All read-only; ?format=csv on the
 * export endpoint streams a regulatory CSV.
 * Mounted at /api/admin via routes/admin/index.js.
 */
import {
  authenticate, express, hasPermission,
} from '../../routes/admin/_adminShared.js';
import { financialReport, settlementReport, merchantReport, regulatoryLedgerExport, toCsv } from './reporting.service.js';
// Item 5: a large regulatory CSV is CPU-bound string work — offload it to a
// worker thread so serializing it doesn't block the event loop (and every
// concurrent request, money paths included). Small exports stay inline.
import { runCpuTask, shouldOffloadCsv } from '../../services/workerPool.service.js';
import { respondError } from '../../shared/httpError.js';
import { sendXlsx, oneTable, columnsOf, istText } from './xlsx.util.js';

const router = express.Router();

function period(req) {
  const { from, to } = req.query;
  if (from && isNaN(Date.parse(from))) throw Object.assign(new Error('Invalid from date'), { status: 400 });
  if (to && isNaN(Date.parse(to)))     throw Object.assign(new Error('Invalid to date'), { status: 400 });
  return { from, to };
}

// GET /api/admin/reports/financial?from=&to=
router.get('/reports/financial', authenticate, hasPermission('canViewAnalytics'), async (req, res) => {
  try {
    const report = await financialReport(period(req));
    res.json({ success: true, report });
  } catch (error) {
    return respondError(res, error, 'GET /admin/reports/financial', { message: 'Failed to build financial report' });
  }
});

// GET /api/admin/reports/settlement?from=&to=
router.get('/reports/settlement', authenticate, hasPermission('canViewAnalytics'), async (req, res) => {
  try {
    const days = await settlementReport(period(req));
    res.json({ success: true, days });
  } catch (error) {
    return respondError(res, error, 'GET /admin/reports/settlement', { message: 'Failed to build settlement report' });
  }
});

// GET /api/admin/reports/merchants?from=&to=
router.get('/reports/merchants', authenticate, hasPermission('canViewAnalytics'), async (req, res) => {
  try {
    const merchants = await merchantReport(period(req));
    res.json({ success: true, merchants });
  } catch (error) {
    return respondError(res, error, 'GET /admin/reports/merchants', { message: 'Failed to build merchant report' });
  }
});

// GET /api/admin/reports/ledger-export?from=&to=&format=csv|xlsx|json
// Regulatory export: one row per journal posting, admin-only.
router.get('/reports/ledger-export', authenticate, hasPermission('canExportLedger'), async (req, res) => {
  try {
    const rows = await regulatoryLedgerExport(period(req));
    if ((req.query.format || 'csv') === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition',
        `attachment; filename="ledger-export-${(req.query.from || 'start')}-${(req.query.to || 'now')}.csv"`);
      // Big export → serialize off the main loop; small → inline (no thread hop).
      const csv = shouldOffloadCsv(rows) ? await runCpuTask('csvSerialize', rows) : toCsv(rows);
      return res.send(csv);
    }
    // The same postings as a workbook for a person to read (owner, 2026-10-21).
    if (req.query.format === 'xlsx') {
      return sendXlsx(res, `ledger-export-${(req.query.from || 'start')}-${(req.query.to || 'now')}.xlsx`, oneTable({
        name: 'Ledger postings', title: 'Ledger postings', accent: 'teal',
        subtitle: `${req.query.from || 'From the start'} to ${req.query.to || 'now'}. Downloaded ${istText(new Date())}`,
        rows, columns: rows.length ? columnsOf(rows) : [{ key: 'posting', label: 'Posting' }],
      }));
    }
    res.json({ success: true, rows });
  } catch (error) {
    return respondError(res, error, 'GET /admin/reports/regulatory-ledger', { message: 'Failed to build ledger export' });
  }
});

export default router;
