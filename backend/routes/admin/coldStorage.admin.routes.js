// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * coldStorage.admin.routes.js — the one way to read cold storage (owner,
 * 2026-10-20: "admin can access that separately ... no one can other ping or
 * send request to see those old cold history"). Full admins only: no
 * sub-admin area grants it, and no player, merchant or other staff route reads
 * `cold_archive` (database/repositories/coldArchive.js). Every opened entry is
 * audited.
 *
 *   GET /cold-storage       what is archived, newest first, without the rows
 *                           (?kind=CYCLE|CHAT|NOTIFICATION&ref=<id>&offset=)
 *   GET /cold-storage/:id   one entry with its rows
 */
import { authenticate, express, isAdmin } from './_adminShared.js';
import { db } from '#db';
import { respondError, refusal } from '../../shared/httpError.js';

const router = express.Router();

router.get('/cold-storage', authenticate, isAdmin, async (req, res) => {
  try {
    const page = await db.coldArchive.listArchive({
      kind: req.query.kind, ref: req.query.ref, offset: req.query.offset,
    });
    res.json({ success: true, kinds: db.coldArchive.COLD_KINDS, coldAfterDays: db.coldArchive.COLD_AFTER_DAYS, ...page });
  } catch (error) {
    respondError(res, error, 'GET /admin/cold-storage', { message: 'Could not read cold storage.' });
  }
});

router.get('/cold-storage/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const entry = await db.coldArchive.getArchiveEntry(req.params.id);
    if (!entry) throw refusal(404, 'NOT_FOUND', 'There is no such cold storage entry.');
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'COLD_STORAGE_OPENED', category: 'SECURITY',
      targetType: 'cold_archive', targetId: String(entry.id), targetName: `${entry.kind} ${entry.ref}`,
      details: { kind: entry.kind, ref: entry.ref, rowCount: entry.rowCount },
      ip: req.ip, method: req.method, endpoint: req.originalUrl,
    });
    res.json({ success: true, entry });
  } catch (error) {
    respondError(res, error, 'GET /admin/cold-storage/:id', { message: 'Could not open that entry.' });
  }
});

export default router;
