// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { adminAdjustment } from '../domains/wallet/walletAuthority.service.js';
/**
 * retention.routes.js — Leaderboard, Announcements, Bonus history,
 * Balance Adjustment, VIP, Recharge requests
 */
import express from 'express';
import mongoose from 'mongoose';
import { authenticate, isAdmin, isAdminOrSubAdmin } from '../domains/identity/auth.middleware.js';
const router = express.Router();

// ── LEADERBOARD ───────────────────────────────────────────────────────────────
router.get('/leaderboard/:period', async (req, res) => {
  try {
    const { period } = req.params;
    if (!['daily','weekly','monthly','alltime'].includes(period))
      return res.status(400).json({ success: false, message: 'Invalid period' });
    const LeaderboardCache = mongoose.model('LeaderboardCache');
    const cache = await LeaderboardCache.findOne({ period }).lean();
    res.json({ success: true, entries: cache?.entries || [], generatedAt: cache?.generatedAt });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// Rebuild leaderboard (admin or cron)
router.post('/leaderboard/rebuild', authenticate, isAdmin, async (req, res) => {
  try {
    await rebuildLeaderboard();
    res.json({ success: true, message: 'Leaderboard rebuilt' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

export async function rebuildLeaderboard() {
  const Bet = mongoose.model('Bet');
  const LeaderboardCache = mongoose.model('LeaderboardCache');
  const periods = {
    daily:   new Date(Date.now() - 86400000),
    weekly:  new Date(Date.now() - 7*86400000),
    monthly: new Date(Date.now() - 30*86400000),
    alltime: new Date(0),
  };
  for (const [period, since] of Object.entries(periods)) {
    const agg = await Bet.aggregate([
      { $match: { timestamp: { $gte: since }, isPhantom: false } },
      { $group: {
        _id: '$userId',
        totalBets: { $sum: 1 },
        totalWon:  { $sum: { $cond: [{ $eq: ['$isWinner', true] }, '$betAmount', 0] } },
        netProfit: { $sum: { $cond: [{ $eq: ['$isWinner', true] }, '$winAmount', { $multiply: ['$betAmount', -1] }] } },
      }},
      { $sort: { netProfit: -1 } },
      { $limit: 50 },
    ]);
    const User = mongoose.model('User');
    const userIds = agg.map(e => e._id);
    const users = await User.find({ _id: { $in: userIds } }).select('username').lean();
    const entries = agg.map((e, i) => {
      const u = users.find(u => String(u._id) === String(e._id));
      return { rank: i+1, userId: e._id, username: u?.username || 'Player', totalBets: e.totalBets, totalWon: e.totalWon, netProfit: e.netProfit, winRate: e.totalBets ? Math.round(e.totalWon/e.totalBets*100) : 0 };
    });
    await LeaderboardCache.findOneAndUpdate({ period }, { entries, generatedAt: new Date() }, { upsert: true });
  }
}

// ── ANNOUNCEMENTS ─────────────────────────────────────────────────────────────
const ANNOUNCEMENT_TYPES = new Set(['INFO', 'WARNING', 'PROMO', 'MAINTENANCE']);
const ANNOUNCEMENT_UPDATE_FIELDS = new Set(['title', 'body', 'type', 'priority', 'isActive', 'expiresAt']);

function normalizeAnnouncementBody(body, { partial = false } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (!ANNOUNCEMENT_UPDATE_FIELDS.has(key)) continue;
    if (key === 'type') {
      const type = String(value || '').toUpperCase();
      if (!ANNOUNCEMENT_TYPES.has(type)) throw Object.assign(new Error('Invalid announcement type'), { status: 400 });
      out.type = type;
    } else if (key === 'priority') {
      const priority = Number(value);
      if (!Number.isFinite(priority)) throw Object.assign(new Error('Invalid announcement priority'), { status: 400 });
      out.priority = priority;
    } else if (key === 'expiresAt') {
      out.expiresAt = value ? new Date(value) : null;
      if (out.expiresAt && Number.isNaN(out.expiresAt.getTime())) throw Object.assign(new Error('Invalid announcement expiry'), { status: 400 });
    } else if (key === 'isActive') {
      out.isActive = Boolean(value);
    } else {
      out[key] = value;
    }
  }
  if (!partial && (!out.title || !out.body)) throw Object.assign(new Error('Title and body required'), { status: 400 });
  return out;
}
router.get('/announcements', async (req, res) => {
  try {
    const Announcement = mongoose.model('Announcement');
    const now = new Date();
    const items = await Announcement.find({ isActive: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }).sort({ priority: -1, createdAt: -1 }).limit(10).lean();
    res.json({ success: true, announcements: items });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/admin/announcements', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const Announcement = mongoose.model('Announcement');
    const items = await Announcement.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, announcements: items });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/admin/announcements', authenticate, isAdmin, async (req, res) => {
  try {
    const Announcement = mongoose.model('Announcement');
    const item = await Announcement.create({
      ...normalizeAnnouncementBody(req.body),
      createdBy: req.user.userId,
    });
    res.json({ success: true, announcement: item });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message }); }
});

router.put('/admin/announcements/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const Announcement = mongoose.model('Announcement');
    const item = await Announcement.findByIdAndUpdate(
      req.params.id,
      { $set: normalizeAnnouncementBody(req.body, { partial: true }) },
      { new: true, runValidators: true }
    );
    if (!item) return res.status(404).json({ success: false, message: 'Announcement not found' });
    res.json({ success: true, announcement: item });
  } catch (err) { res.status(err.status || 500).json({ success: false, message: err.message }); }
});

router.delete('/admin/announcements/:id', authenticate, isAdmin, async (req, res) => {
  try {
    await mongoose.model('Announcement').findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── BONUS HISTORY ─────────────────────────────────────────────────────────────
router.get('/bonuses/my', authenticate, async (req, res) => {
  try {
    const BonusRecord = mongoose.model('BonusRecord');
    const { page=1, limit=30 } = req.query;
    const skip = (Number(page)-1)*Number(limit);
    const [records, total] = await Promise.all([
      BonusRecord.find({ userId: req.user.userId }).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      BonusRecord.countDocuments({ userId: req.user.userId }),
    ]);
    res.json({ success: true, records, total });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── ADMIN BALANCE ADJUSTMENT ──────────────────────────────────────────────────
router.post('/admin/balance-adjust', authenticate, isAdmin, async (req, res) => {
  try {
    const User = mongoose.model('User');
    const BalanceAdjustment = mongoose.model('BalanceAdjustment');
    const BonusRecord = mongoose.model('BonusRecord');
    const { userId, type, field, amount, reason } = req.body;
    if (!userId || !type || !field || !amount || !reason)
      return res.status(400).json({ success: false, message: 'All fields required' });
    if (!['CREDIT','DEBIT'].includes(type)) return res.status(400).json({ success: false, message: 'type must be CREDIT or DEBIT' });
    if (!['depositBalance','winningsBalance','tokenBalance'].includes(field)) return res.status(400).json({ success: false, message: 'Invalid field' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const before = user[field] || 0;
    const delta = type === 'CREDIT' ? Number(amount) : -Number(amount);
    if (type === 'DEBIT' && before < Number(amount)) return res.status(400).json({ success: false, message: 'Insufficient balance' });

    // Atomic: admin adjustment via wallet service (ledger + SSE)
    const adjustDoc = await BalanceAdjustment.create({ userId, adminId: req.user.userId, type, field, amount: Number(amount), reason, beforeBalance: before, afterBalance: before + (type==='CREDIT'?1:-1)*Number(amount) });
    await adminAdjustment(req.user.userId, userId, type, field, Number(amount), reason, adjustDoc._id.toString());
    const after = before + (type === 'CREDIT' ? Number(amount) : -Number(amount));
    if (type === 'CREDIT') await BonusRecord.create({ userId, type: 'ADMIN_CREDIT', amount: Number(amount), description: reason });

    res.json({ success: true, message: `${type === 'CREDIT' ? 'Credited' : 'Debited'} ₹${amount} ${type==='CREDIT'?'to':'from'} ${user.username}`, before, after });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/admin/balance-adjustments', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const BalanceAdjustment = mongoose.model('BalanceAdjustment');
    const { userId, page=1, limit=30 } = req.query;
    const filter = userId ? { userId } : {};
    const skip = (Number(page)-1)*Number(limit);
    const [items, total] = await Promise.all([
      BalanceAdjustment.find(filter).sort({ createdAt:-1 }).skip(skip).limit(Number(limit)).populate('userId','username mobile').populate('adminId','username').lean(),
      BalanceAdjustment.countDocuments(filter),
    ]);
    res.json({ success: true, adjustments: items, total });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── RECHARGE REQUESTS (Manual UPI / USDT) ────────────────────────────────────
export default router;
