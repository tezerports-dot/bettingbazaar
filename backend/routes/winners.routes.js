// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * winners.routes.js
 * Public + admin management of the winners list.
 * Admin can create fully synthetic entries (fake profile pic, name, amount)
 * or link to a real user. The public /winners endpoint merges both sources.
 */
import express from 'express';
import mongoose from 'mongoose';
import crypto   from 'crypto';
import { authenticate, isAdmin, isAdminOrSubAdmin } from '../domains/identity/auth.middleware.js';
// Item 47 (2026-07-13): the public winners feed is analytics-class (staleness
// fine) — routes to a secondary when FLAGS.READ_REPLICA is enabled.
import { preferReplica } from '../services/readPreference.service.js';
// The ordering lives in its own module so it can be tested without dragging
// mongoose and the auth middleware in behind it — see winners.ranking.js.
import { rankWinners, resolveWinnersLimit } from './winners.ranking.js';

const router = express.Router();

// ── PUBLIC ────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/winners — the public leaderboard: the BIGGEST wins in a window.
 *
 * Query params:
 *   period = 'today' (default) → last 24 hours
 *   period = 'week'            → last 7 days
 *   limit  = number (default 20, max 50)
 *
 * ── Ordered by payout, and that is the whole feature ────────────────────────
 * This used to merge the two sources and sort by `displayTime`, i.e. by
 * RECENCY — while the nav calls it "Top Winners" and the page renders the first
 * three entries as a podium. So the podium showed the three most recent
 * winners, presented as the three biggest. A ₹50 win a minute ago outranked a
 * ₹50,000 win an hour ago.
 *
 * `page` is gone rather than fixed. It was applied to the curated source only,
 * so page 2 returned the same real winners as page 1 — and a top-N leaderboard
 * does not page: the tail is not a second page of winners, it is not winners.
 * No caller ever sent it.
 */
router.get('/v1/winners', async (req, res) => {
  try {
    const { period = 'today' } = req.query;
    // Clamped, not trusted: this is a public unauthenticated endpoint reading
    // the largest collection in the system, and `limit` sizes that read.
    const limit = resolveWinnersLimit(req.query.limit);

    const FakeWinner = mongoose.model('FakeWinner');
    const Bet        = mongoose.model('Bet');
    const User       = mongoose.model('User');

    // ── period window ─────────────────────────────────────────────────────────
    // 'today' = last 24 hours | 'week' = last 168 hours (7 days)
    const periodHours = (period === 'week') ? 168 : 24;
    const since       = new Date(Date.now() - periodHours * 3600000);

    // 1. Admin-curated winners — within the window.
    //
    // `sortOrder` SELECTS here, it does not rank: it decides which curated
    // entries make the shortlist when there are more than `limit` of them, and
    // then `rankWinners` orders the merged board by amount like everything
    // else. That is deliberate. A pin that jumped the queue would put a chosen
    // entry above a bigger real win on a board whose entire promise is "biggest
    // wins", which is the defect this endpoint just had. Admins choose who is
    // eligible; the amount decides the position.
    const curated = await preferReplica(FakeWinner.find({
      isPublic: true, displayTime: { $gte: since },
    })
      .sort({ sortOrder: 1, amount: -1 })
      .limit(limit)
      .lean());

    // 2. Real recent winners — actual settled winning bets in the window.
    // FIXED 2026-07-10: this queried isWinner/winAmount, fields that have
    // NEVER existed on the Bet schema (it's status:'WON' + payout), so real
    // winners never appeared — only curated entries. Now cycle-based real
    // wins show with their true NET payout (2x minus the winnings fee).
    //
    // `limit`, not a hard-coded 20: the two sources are merged and re-cut to
    // `limit`, so capping one of them lower silently biases the board toward
    // the other. Served by the `winners_leaderboard` index (bet.model.js),
    // which provides the payout order rather than feeding a blocking sort.
    const realWins = await preferReplica(Bet.find({
      status: 'WON', isPhantom: false, settledAt: { $gte: since }
    }).sort({ payout: -1 }).limit(limit).lean());

    const realUserIds = [...new Set(realWins.map(b => b.userId))];
    const users = await User.find({ _id: { $in: realUserIds } })
      .select('username profilePic').lean();
    const userMap = Object.fromEntries(users.map(u => [String(u._id), u]));

    const realFormatted = realWins.map(b => {
      const u = userMap[String(b.userId)] || {};
      return {
        displayName: u.username || 'Player',
        profilePic:  u.profilePic || '',
        amount:      b.payout || 0,          // net payout actually credited
        game:        'Delhi/Bombay',
        cycleId:     b.cycleId,              // per-cycle context, not platform-total
        side:        b.side,
        city:        '',
        displayTime: b.settledAt || b.timestamp,
        isReal:      true,
      };
    });

    const merged = rankWinners([
      ...curated.map(w => ({ ...w, isReal: false })),
      ...realFormatted,
    ], limit);

    res.json({ success: true, winners: merged, total: merged.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── ADMIN ─────────────────────────────────────────────────────────────────────

// GET /api/admin/fake-winners
router.get('/admin/fake-winners', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const FakeWinner = mongoose.model('FakeWinner');
    const list = await FakeWinner.find().sort({ sortOrder: 1, createdAt: -1 }).lean();
    res.json({ success: true, winners: list });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/admin/fake-winners
router.post('/admin/fake-winners', authenticate, isAdmin, async (req, res) => {
  try {
    const FakeWinner = mongoose.model('FakeWinner');
    const { displayName, profilePic, city, amount, game, badge, isPublic, sortOrder, displayTime } = req.body;
    if (!displayName || !amount) return res.status(400).json({ success: false, message: 'displayName and amount required' });
    const entry = await FakeWinner.create({
      displayName, profilePic: profilePic || '', city: city || '',
      amount: Number(amount), game: game || 'Delhi/Bombay',
      badge: badge || '', isPublic: isPublic !== false,
      sortOrder: sortOrder || 0,
      displayTime: displayTime ? new Date(displayTime) : new Date(),
      createdBy: req.user._id,
    });
    res.json({ success: true, winner: entry });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PUT /api/admin/fake-winners/:id
router.put('/admin/fake-winners/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const FakeWinner = mongoose.model('FakeWinner');
    const allowed = ['displayName','profilePic','city','amount','game','badge','isPublic','sortOrder','displayTime'];
    const update  = { updatedAt: new Date() };
    for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];
    if (update.amount)      update.amount      = Number(update.amount);
    if (update.displayTime) update.displayTime = new Date(update.displayTime);
    const entry = await FakeWinner.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!entry) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, winner: entry });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// DELETE /api/admin/fake-winners/:id
router.delete('/admin/fake-winners/:id', authenticate, isAdmin, async (req, res) => {
  try {
    await mongoose.model('FakeWinner').findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

export default router;
