// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * winners.routes.js — the public winners feed, and the curated entries an
 * operator adds to it.
 *
 * ── A query that matched nothing, for however long it stood ─────────────────
 * The real-winners half filtered on `isWinner` and `winAmount`. Neither has
 * ever been a field on a bet — it is `status = 'WON'` and a payout — so the
 * query returned nothing and the feed showed ONLY curated entries. A marketing
 * carousel with no real winners in it, and nothing to say so: an empty result
 * from a wrong field looks exactly like a quiet day.
 *
 * ── Curated entries are not people ──────────────────────────────────────────
 * They carry no money and are never joined to a real account. Attaching one to
 * a player would put a fabricated payout next to somebody's real name.
 */
import express from 'express';
import { db } from '#db';
import { authenticate, isAdmin, isAdminOrSubAdmin } from '../domains/identity/auth.middleware.js';

const router = express.Router();

// ── PUBLIC ────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/winners — the public feed, real wins merged with curated ones.
 *
 * `period=today` is the last 24 hours; `period=week` is the last 168.
 */
router.get('/v1/winners', async (req, res) => {
  try {
    const { limit = 50, period = 'today' } = req.query;
    const sinceHours = period === 'week' ? 168 : 24;
    const size = Math.min(Math.max(Number(limit) || 50, 1), 200);

    const [curated, real] = await Promise.all([
      db.engagement.curatedWinners({ sinceHours, limit: size }),
      db.engagement.realWinners({ sinceHours, limit: 20 }),
    ]);

    const merged = [...curated, ...real]
      .sort((a, b) => new Date(b.displayTime).getTime() - new Date(a.displayTime).getTime())
      .slice(0, size);

    res.json({ success: true, winners: merged, total: merged.length });
  } catch (err) {
    console.error('GET /v1/winners error:', err);
    res.status(500).json({ success: false, message: 'Could not load winners.' });
  }
});

// ── ADMIN ─────────────────────────────────────────────────────────────────────

router.get('/admin/fake-winners', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    // Every entry, including the ones switched off — this is the editor, not
    // the feed.
    res.json({ success: true, winners: await db.engagement.listFakeWinners({ publicOnly: false, limit: 200 }) });
  } catch (err) {
    console.error('GET /admin/fake-winners error:', err);
    res.status(500).json({ success: false, message: 'Could not load entries.' });
  }
});

router.post('/admin/fake-winners', authenticate, isAdmin, async (req, res) => {
  try {
    const { displayName, profilePic, city, amount, game, badge, isPublic, sortOrder, displayTime } = req.body || {};
    if (!displayName || !amount) {
      return res.status(400).json({ success: false, message: 'displayName and amount required' });
    }
    if (!(Number(amount) > 0)) {
      return res.status(400).json({ success: false, message: 'amount must be positive' });
    }

    const winner = await db.engagement.addFakeWinner({
      displayName, profilePic: profilePic || '', city: city || '',
      amountRupees: Number(amount), game: game || 'Delhi/Bombay',
      badge: badge || '', isPublic: isPublic !== false,
      sortOrder: Number(sortOrder) || 0,
      displayTime: displayTime ? new Date(displayTime) : new Date(),
      createdBy: req.user.userId,
    });

    // A fabricated payout on a public page is a marketing claim, so who added
    // it is recorded like any other operator action.
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'CURATED_WINNER_ADDED', category: 'CONTENT',
      targetType: 'FakeWinner', targetId: String(winner.id),
      details: { displayName: winner.displayName, amount: winner.amount },
    });
    res.json({ success: true, winner });
  } catch (err) {
    console.error('POST /admin/fake-winners error:', err);
    res.status(500).json({ success: false, message: 'Could not create that entry.' });
  }
});

router.put('/admin/fake-winners/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const winner = await db.engagement.updateFakeWinner(req.params.id, req.body || {});
    if (!winner) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, winner });
  } catch (err) {
    console.error('PUT /admin/fake-winners error:', err);
    res.status(500).json({ success: false, message: 'Could not update that entry.' });
  }
});

router.delete('/admin/fake-winners/:id', authenticate, isAdmin, async (req, res) => {
  try {
    // 404 rather than a silent success. This answered `{success:true}` whatever
    // came back, so an operator deleting the wrong id twice was told both times
    // that it worked.
    const removed = await db.engagement.deleteFakeWinner(req.params.id);
    if (!removed) return res.status(404).json({ success: false, message: 'Not found' });
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'CURATED_WINNER_DELETED', category: 'CONTENT',
      targetType: 'FakeWinner', targetId: String(req.params.id), details: {},
    });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /admin/fake-winners error:', err);
    res.status(500).json({ success: false, message: 'Could not delete that entry.' });
  }
});

export default router;
