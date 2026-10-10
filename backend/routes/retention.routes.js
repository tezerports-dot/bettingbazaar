// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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
import {
  authenticate, authenticatePlayer, hasPermission,
} from '../domains/identity/auth.middleware.js';
import { publicLeaderboard } from '../domains/analytics/leaderboardPublicView.js';
import { emitToStaff } from '../domains/notification/staffEventAreas.js';
import { emitToPlayer } from '../domains/notification/realtimeEmitters.js';
import { toPlayerBonus } from '../domains/wallet/playerLedgerView.js';
import { getBalancesRupees } from '#db/repositories/wallets.core.js';

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
      // Through the allowlist. This sent the cached rows WHOLE, and they carry
      // `userId` — the id every user-scoped API takes — on an endpoint that
      // needs no authentication. See leaderboardPublicView.js for why that is
      // about identifier cost rather than about the leaderboard.
      entries: publicLeaderboard(cache?.entries),
      generatedAt: cache?.generatedAt,
    });
  } catch (err) {
    console.error('GET /leaderboard error:', err);
    res.status(500).json({ success: false, message: 'Could not load the leaderboard.' });
  }
});

router.post('/leaderboard/rebuild', authenticate, hasPermission('canRunMaintenance'), async (req, res) => {
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

router.get('/admin/announcements', authenticate, hasPermission('canManageContent'), async (req, res) => {
  try {
    res.json({ success: true, announcements: await db.content.listAnnouncements({ limit: 200 }) });
  } catch (err) {
    console.error('GET /admin/announcements error:', err);
    res.status(500).json({ success: false, message: 'Could not load announcements.' });
  }
});

router.post('/admin/announcements', authenticate, hasPermission('canManageContent'), async (req, res) => {
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

router.put('/admin/announcements/:id', authenticate, hasPermission('canManageContent'), async (req, res) => {
  try {
    const patch = normalizeAnnouncementBody(req.body, { partial: true });
    const announcement = await db.content.updateAnnouncement(req.params.id, patch);
    if (!announcement) return res.status(404).json({ success: false, message: 'Announcement not found' });
    // Audited like the create and the delete. An edit can rewrite every word
    // players are shown, and it was the one change to an announcement with no
    // record of who made it (§32 S3).
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'ANNOUNCEMENT_UPDATED', category: 'CONTENT',
      targetType: 'Announcement', targetId: announcement.announcementId,
      details: { fields: Object.keys(patch) },
    });
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
router.delete('/admin/announcements/:id', authenticate, hasPermission('canManageContent'), async (req, res) => {
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

router.get('/bonuses/my', authenticatePlayer, async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    // Page and total from one query, so a bonus credited between them cannot
    // make the footer disagree with the rows above it.
    const result = await db.engagement.pageBonuses({ userId: req.user.userId, page, limit });
    // Never the record's description: for a support credit it is the admin's
    // note for the audit trail (playerLedgerView.js).
    res.json({ success: true, ...result, records: result.records.map(toPlayerBonus) });
  } catch (err) {
    console.error('GET /bonuses/my error:', err);
    res.status(500).json({ success: false, message: 'Could not load your bonus history.' });
  }
});

// ── ADMIN BALANCE ADJUSTMENT ─────────────────────────────────────────────────

router.post('/admin/balance-adjust', authenticate, hasPermission('canAdjustBalances'), async (req, res) => {
  try {
    const { userId, type, field, amount, reason } = req.body || {};
    // The reason is tested as the writer tests it — trimmed. A reason of
    // spaces passed `!reason` and the writer's own check threw a bare Error,
    // answered as a 500 to a request that can never succeed (S35).
    if (!userId || !type || !field || !amount || !String(reason ?? '').trim()) {
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
    // ── The ceiling on one adjustment ──────────────────────────────────────
    // This was bounded at `> 0` and nothing else. A DEBIT is capped by what
    // the player holds (the `Insufficient` branch below), so the open end was
    // a CREDIT: one admin, one click, any sum, with an audit row as the only
    // record. `SystemConfig.maxBalanceAdjustment` is the one owner of the
    // number — the panel reads the same value to bound its input, rather than
    // repeating it (§2, §4).
    const { maxBalanceAdjustment } = await db.config.getSystemConfig();
    if (Number(amount) > Number(maxBalanceAdjustment)) {
      return res.status(400).json({
        success: false,
        message: `amount must be at most ₹${Number(maxBalanceAdjustment).toLocaleString('en-IN')}`
          + ' — raise the ceiling in System Settings if this is intended',
      });
    }

    const user = await db.users.getUser(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    // A PLAYER account only. Staff and merchant logins are separate accounts
    // for their own panels (owner, 2026-10-01); money moved onto one sits in a
    // wallet no player screen shows and nothing can play or withdraw from.
    if (user.accountType !== 'PLAYER') {
      return res.status(409).json({
        success: false,
        message: 'Only a player account can be adjusted. That id is a staff or merchant login.',
      });
    }

    // Held, not generated inline: the bonus record below is keyed on it, and a
    // second call to the generator would key the retry differently and pay the
    // record twice.
    const adjustmentId = newAdjustmentId();
    const result = await adminAdjustment(
      req.user.userId, userId, type, field, Number(amount), reason, adjustmentId,
    );
    if (!result.ok && result.reason === 'SUPPLY_EXHAUSTED') {
      // Platform state, not the admin's mistake: the configured token supply
      // is all in circulation (§32 S14). Nothing moved.
      return res.status(409).json({
        success: false,
        message: 'Nothing was credited: every token of the configured supply is already in circulation. Raise the supply in System Settings first.',
      });
    }
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

    // ── Tell the player, and the admin room ────────────────────────────────
    // Carried over from `/users/:userId/adjust-balance`, which this route
    // absorbed. Without it an operator credits an account and the player goes on
    // seeing the old number until something else makes them reload — and the
    // two screens behaved differently depending on which one was used.
    //
    // The balances come from the movement itself, never a re-read: a re-read can
    // pick up a LATER movement and attribute it to this one.
    emitToPlayer(userId, 'user_update', {
      depositBalance:  result.balances?.depositBalance  ?? 0,
      winningsBalance: result.balances?.winningsBalance ?? 0,
      server_ts: Date.now(),
    });
    if (global.io) {
      emitToStaff(global.io, 'admin_stats_delta', { type: 'BALANCE_ADJUSTED', server_ts: Date.now() });
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

/**
 * GET /api/admin/balance-adjust/players — this area's own player lookup.
 *
 * The Balance Adjust screen found players through `GET /api/admin/users` (the
 * Users area) and read its ceiling from System Settings, so a sub-admin given
 * balance adjustment alone could find nobody (check:staff-permissions, rule
 * 5). This answers both from inside the area: PLAYERS only, each with the
 * wallet the adjustment would move, and the one ceiling the POST enforces.
 * With no search it lists nobody and still answers the ceiling.
 */
router.get('/admin/balance-adjust/players', authenticate, hasPermission('canAdjustBalances'), async (req, res) => {
  try {
    const search = String(req.query.search ?? '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 25);
    const { maxBalanceAdjustment } = await db.config.getSystemConfig();
    let players = [];
    if (search) {
      const { users } = await db.users.listUsers({ search, accountType: 'PLAYER', limit });
      players = await Promise.all(users.map(async (u) => {
        const b = await getBalancesRupees(u.userId);
        return {
          userId: u.userId, username: u.username, mobile: u.mobile, status: u.status,
          depositBalance: b.depositBalance ?? 0, winningsBalance: b.winningsBalance ?? 0,
        };
      }));
    }
    res.json({ success: true, players, maxBalanceAdjustment: Number(maxBalanceAdjustment) });
  } catch (err) {
    console.error('GET /admin/balance-adjust/players error:', err);
    res.status(500).json({ success: false, message: 'Could not search players.' });
  }
});

router.get('/admin/balance-adjustments', authenticate, hasPermission('canAdjustBalances'), async (req, res) => {
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
