// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/support/support.routes.js — player-facing RAG support assistant edge
 * (CAP-71). Mounted at /api/support in server.js.
 *
 *   GET  /api/support/status  — feature readiness (booleans + doc counts, no secrets)
 *   POST /api/support/ask     — authenticated Q&A over the help center (RAG)
 *
 * /ask is authenticated (so we can rate-limit per user — Claude calls cost money)
 * and returns 503 with a clear message while the feature is dormant (keys unset).
 */
import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { authenticate } from '../identity/auth.middleware.js';
import { answer, ragStatus } from './ragService.js';

const router = express.Router();

// Per-user limiter — the route is authenticated, so key by user id (fair, and it
// sidesteps the express-rate-limit v8 IPv6 keyGenerator pitfall). ipKeyGenerator
// is only the fallback for the theoretically-unauthenticated case.
const askLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RAG_ASK_RATE || 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user?._id ? `u:${req.user._id}` : ipKeyGenerator(req.ip)),
  message: { success: false, message: 'Too many support questions. Please wait a minute.' },
});

router.get('/status', async (req, res) => {
  try {
    res.json({ success: true, ...(await ragStatus()) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post('/ask', authenticate, askLimiter, async (req, res) => {
  try {
    const { query, category, topK } = req.body || {};
    if (!query || !String(query).trim()) {
      return res.status(400).json({ success: false, message: 'query is required' });
    }
    const result = await answer({
      query: String(query).slice(0, 2000),
      category: category ? String(category).slice(0, 64) : null,
      topK: Number(topK) || 5,
    });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

export default router;
