// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/support/support.admin.routes.js — admin edge for the RAG support
 * assistant (CAP-71). Registered in routes/admin/index.js → mounted under
 * /api/admin. Every endpoint requires an authenticated admin.
 *
 *   GET    /api/admin/support/status                 — full readiness + store stats
 *   POST   /api/admin/support/ingest/knowledge-base  — (re)ingest bundled help docs
 *   POST   /api/admin/support/ingest                 — ingest an admin-authored doc
 *   GET    /api/admin/support/documents              — list ingested docs
 *   DELETE /api/admin/support/documents/:docId       — remove a doc's chunks
 *
 * This is a *.routes.js edge adapter, so importing routes/admin/_adminShared.js
 * is allowed by the dependency-cruiser boundary rules (same as the merchant
 * admin routes).
 */
import { express, authenticate, isAdmin } from '../../routes/admin/_adminShared.js';
import {
  ragStatus, ingestKnowledgeBase, ingestDocument,
  listIngestedDocuments, removeDocument,
} from './ragService.js';

const router = express.Router();

router.get('/support/status', authenticate, isAdmin, async (req, res) => {
  try { res.json({ success: true, ...(await ragStatus()) }); }
  catch (e) { res.status(e.status || 500).json({ success: false, message: e.message }); }
});

router.post('/support/ingest/knowledge-base', authenticate, isAdmin, async (req, res) => {
  try { res.json({ success: true, ...(await ingestKnowledgeBase()) }); }
  catch (e) { res.status(e.status || 500).json({ success: false, message: e.message }); }
});

router.post('/support/ingest', authenticate, isAdmin, async (req, res) => {
  try {
    const { docId, title, source, category, text } = req.body || {};
    if (!docId || !String(docId).trim()) return res.status(400).json({ success: false, message: 'docId is required' });
    if (!text  || !String(text).trim())  return res.status(400).json({ success: false, message: 'text is required' });
    const result = await ingestDocument({
      docId: String(docId).slice(0, 200),
      title: title ? String(title).slice(0, 300) : '',
      source: source ? String(source).slice(0, 300) : 'admin',
      category: category ? String(category).slice(0, 64) : 'general',
      text: String(text),
    });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

router.get('/support/documents', authenticate, isAdmin, async (req, res) => {
  try { res.json({ success: true, documents: await listIngestedDocuments() }); }
  catch (e) { res.status(e.status || 500).json({ success: false, message: e.message }); }
});

router.delete('/support/documents/:docId', authenticate, isAdmin, async (req, res) => {
  try {
    const removed = await removeDocument(String(req.params.docId));
    res.json({ success: true, removedChunks: removed });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

export default router;
