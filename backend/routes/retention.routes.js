// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * routes/retention.routes.js — leaderboard, announcements, bonus history, and
 * the manual balance adjustment.
 *
 * ── The leaderboard is DERIVED, then cached ─────────────────────────────────
 * `rebuildLeaderboard()` computes the standings from settled bets in one query
 * and stores the result. Nothing reads the cache to make a decision, which is
 * what makes caching it legitimate: losing it costs a rebuild, not a fact.
 *
 * ── The adjustment decides where the money is ───────────────────────────────
 * Everything that made a decision moved behind `adminAdjustment`, which does it
 * under the wallet row lock: the affordability check (which used to compare a
 * number on an account record while the debit hit `wallets`), the pocket
 * selection (which used to be discarded), and the audit row (which used to be
 * written first, in rupee floats, naming a model that did not exist — so it
 * threw on every call and the adjustment went unrecorded).
 */
import express from 'express';
import { randomBytes } from 'node:crypto';
import { db } from '#db';
import {
  adminAdjustment, getBalanceAdjustments, ADJUSTABLE_FIELDS,
} from '../domains/wallet/walletAuthority.service.js';
import { authenticate, isAdmin, isAdminOrSubAdmin } from '../domains/identity/auth.middleware.js';

const router = express.Router();

/**
 * The adjustment's identity, and its idempotency key. Generated per request so
 * a double-submit creates two adjustments; a retry of the SAME id is a no-op.
 */
const newAdjustmentId = () => randomBytes(12).toString('hex');

// ── LEADERBOARD ──────────────────────────────────────────────────────────────

const PERIODS = Object.freeze({
  daily:   86_400_000,
  weekly:  7 * 86_400_000,
  monthly: 30 * 86_400_000,
  alltime: null,
});

router.get('/leaderboard/:period', async (req, res) => {
  try {
    const { period } = req.params;
    if (!(period in PERIODS)) {
      return res.status(400).json({ success: false, message: 'Invalid period' });
    }
    const cache = await db.engagement.getLeaderboard(period);
    res.json({
      success: true,
      entries: cache?.entries || [],
      generatedAt: cache?.generatedAt,
    });
  } catch (err) {
    console.error('GET /leaderboard error:', err);
    res.status(500).json({ success: false, message: 'Could not load the leaderboard.' });
  }
});

router.post('/leaderboard/rebuild', authenticate, isAdmin, async (req, res) => {
  try {
    const built = await rebuildLeaderboard();
    res.json({ success: true, message: 'Leaderboard rebuilt', periods: built });
  } catch (err) {
    console.error('POST /leaderboard/rebuild error:', err);
    res.status(500).json({ success: false, message: 'Could not rebuild the leaderboard.' });
  }
});

/**
 * Recompute every period from settled bets.
 *
 * One aggregate per period, each ranking on realised profit. The document
 * version ranked on every bet including PENDING ones, whose payout is zero, so
 * an open position dragged a player down the board and then jumped them back up
 * when it settled — a leaderboard that moved for reasons nobody could explain.
 *
 * Called by the admin route above and by the scheduled rebuild. Returns what it
 * wrote so a caller can log it rather than assuming.
 */
export async function rebuildLeaderboard() {
  const written = [];
  for (const [period, window] of Object.entries(PERIODS)) {
    const since = window === null ? null : new Date(Date.now() - window);
    const entries = await db.stats.leaderboard({ since, limit: 50 });
    await db.engagement.putLeaderboard(period, entries);
    written.push({ period, entries: entries.length });
  }
  return written;
}

// ── ANNOUNCEMENTS ────────────────────────────────────────────────────────────

const ANNOUNCEMENT_KINDS = new Set(['INFO', 'WARNING', 'PROMO', 'MAINTENANCE']);

/**
 * Validate and normalise the operator's body.
 *
 * `type` on the wire, `kind` in the table — the column could not be called
 * `type` without shadowing a reserved-ish name in half the query builders, and
 * the panels were already sending `type`. Translated here, once, rather than in
 * each of the three handlers that used to do it differently.
 */
function normalizeAnnouncementBody(body, { partial = false } = {}) {
  const out = {};
  const src = body || {};

  if (src.title !== undefined) out.title = String(src.title);
  if (src.body !== undefined) out.body = String(src.body);

  const rawKind = src.type ?? src.kind;
  if (rawKind !== undefined) {
    const kind = String(rawKind || '').toUpperCase();
    if (!ANNOUNCEMENT_KINDS.has(kind)) {
      throw Object.assign(new Error('Invalid announcement type'), { status: 400 });
    }
    out.kind = kind;
  }

  if (src.priority !== undefined) {
    const priority = Number(src.priority);
    if (!Number.isFinite(priority)) {
      throw Object.assign(new Error('Invalid announcement priority'), { status: 400 });
    }
    out.priority = priority;
  }

  if (src.expiresAt !== undefined) {
    const expiresAt = src.expiresAt ? new Date(src.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      throw Object.assign(new Error('Invalid announcement expiry'), { status: 400 });
    }
    out.expiresAt = expiresAt;
  }

  if (src.isActive !== undefined) out.isActive = Boolean(src.isActive);

  if (!partial && (!out.title || !out.body)) {
    throw Object.assign(new Error('Title and body required'), { status: 400 });
  }
  return out;
}

/**
 * What players see.
 *
 * Expiry is enforced by the READ, not by a sweep. PostgreSQL has no TTL index
 * and does not need one: an expired announcement is invisible from the instant
 * it expires, rather than from whenever a background job next runs — and a job
 * that fails silently cannot leave a stale banner up for a day.
 */
router.get('/announcements', async (req, res) => {
  try {
    res.json({ success: true, announcements: await db.content.listLiveAnnouncements({ limit: 10 }) });
  } catch (err) {
    console.error('GET /announcements error:', err);
    res.status(500).json({ success: false, message: 'Could not load announcements.' });
  }
});

router.get('/admin/announcements', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    res.json({ success: true, announcements: await db.content.listAnnouncements({ limit: 200 }) });
  } catch (err) {
    console.error('GET /admin/announcements error:', err);
    res.status(500).json({ success: false, message: 'Could not load announcements.' });
  }
});

router.post('/admin/announcements', authenticate, isAdmin, async (req, res) => {
  try {
    const fields = normalizeAnnouncementBody(req.body);
    const announcement = await db.content.createAnnouncement({
      ...fields, createdBy: req.user.userId,
    });
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'ANNOUNCEMENT_CREATED', category: 'CONTENT',
      targetType: 'Announcement', targetId: announcement.announcementId,
      details: { title: announcement.title, kind: announcement.kind },
    });
    res.json({ success: true, announcement });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error('POST /admin/announcements error:', err);
    res.status(500).json({ success: false, message: 'Could not create that announcement.' });
  }
});

router.put('/admin/announcements/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const patch = normalizeAnnouncementBody(req.body, { partial: true });
    const announcement = await db.content.updateAnnouncement(req.params.id, patch);
    if (!announcement) return res.status(404).json({ success: false, message: 'Announcement not found' });
    res.json({ success: true, announcement });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    console.error('PUT /admin/announcements error:', err);
    res.status(500).json({ success: false, message: 'Could not update that announcement.' });
  }
});

/**
 * Remove an announcement.
 *
 * A missing id is a 404, not a silent success. The document version called
 * `findByIdAndDelete` and answered `{success:true}` whatever came back, so an
 * operator deleting the wrong id twice was told both times that it worked.
 */
router.delete('/admin/announcements/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const removed = await db.content.deleteAnnouncement(req.params.id);
    if (!removed) return res.status(404).json({ success: false, message: 'Announcement not found' });
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'ANNOUNCEMENT_DELETED', category: 'CONTENT',
      targetType: 'Announcement', targetId: req.params.id, details: {},
    });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /admin/announcements error:', err);
    res.status(500).json({ success: false, message: 'Could not delete that announcement.' });
  }
});

// ── BONUS HISTORY ────────────────────────────────────────────────────────────

router.get('/bonuses/my', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    // Page and total from one query, so a bonus credited between them cannot
    // make the footer disagree with the rows above it.
    const result = await db.engagement.pageBonuses({ userId: req.user.userId, page, limit });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('GET /bonuses/my error:', err);
    res.status(500).json({ success: false, message: 'Could not load your bonus history.' });
  }
});

// ── ADMIN BALANCE ADJUSTMENT ─────────────────────────────────────────────────

router.post('/admin/balance-adjust', authenticate, isAdmin, async (req, res) => {
  try {
    const { userId, type, field, amount, reason } = req.body || {};
    if (!userId || !type || !field || !amount || !reason) {
      return res.status(400).json({ success: false, message: 'All fields required' });
    }
    if (!['CREDIT', 'DEBIT'].includes(type)) {
      return res.status(400).json({ success: false, message: 'type must be CREDIT or DEBIT' });
    }
    // The writer's own list, not a second copy of it — a route that accepts a
    // pocket the writer refuses is a 500 dressed as a validation pass.
    if (!ADJUSTABLE_FIELDS.includes(field)) {
      return res.status(400).json({ success: false, message: `Invalid field. Adjustable: ${ADJUSTABLE_FIELDS.join(', ')}` });
    }
    if (!(Number(amount) > 0)) {
      return res.status(400).json({ success: false, message: 'amount must be positive' });
    }

    const user = await db.users.getUser(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Held, not generated inline: the bonus record below is keyed on it, and a
    // second call to the generator would key the retry differently and pay the
    // record twice.
    const adjustmentId = newAdjustmentId();
    const result = await adminAdjustment(
      req.user.userId, userId, type, field, Number(amount), reason, adjustmentId,
    );
    if (!result.ok) {
      return res.status(400).json({
        success: false,
        message: `Insufficient ${field}: have ₹${result.availableRupees}`,
      });
    }

    // The bonus record follows the money; it is not part of deciding it, and a
    // failure to write it must not unwind an adjustment that has committed.
    // Keyed on the adjustment id so a retry records once.
    if (type === 'CREDIT') {
      try {
        await db.engagement.recordBonus({
          bonusId: `adj_${adjustmentId}`,
          userId, bonusType: 'ADMIN_CREDIT', amountRupees: Number(amount), description: reason,
        });
      } catch (e) {
        console.error('[balance-adjust] bonus record not written:', e.message);
      }
    }

    res.json({
      success: true,
      message: `${type === 'CREDIT' ? 'Credited' : 'Debited'} ₹${amount} ${type === 'CREDIT' ? 'to' : 'from'} ${user.username}`,
      before: result.beforeRupees,
      after: result.afterRupees,
      adjustment: result.adjustment,
    });
  } catch (err) {
    console.error('POST /admin/balance-adjust error:', err);
    res.status(500).json({ success: false, message: 'Could not apply that adjustment.' });
  }
});

router.get('/admin/balance-adjustments', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const { userId, page = 1, limit = 30 } = req.query;
    const { adjustments, total } = await getBalanceAdjustments({ userId: userId || null, page, limit });
    res.json({ success: true, adjustments, total });
  } catch (err) {
    console.error('GET /admin/balance-adjustments error:', err);
    res.status(500).json({ success: false, message: 'Could not load adjustments.' });
  }
});

export default router;
