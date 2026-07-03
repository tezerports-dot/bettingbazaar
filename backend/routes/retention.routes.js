// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { creditWinnings, adminAdjustment } from '../domains/wallet/walletAuthority.service.js';
/**
 * retention.routes.js — Leaderboard, Spin Wheel, Announcements,
 * Bonus history, Balance Adjustment, VIP, Recharge requests
 */
import express from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { authenticate, isAdmin, isAdminOrSubAdmin } from '../middleware/auth.middleware.js';
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

// ── SPIN WHEEL ────────────────────────────────────────────────────────────────
router.get('/spin/config', async (req, res) => {
  try {
    const SpinWheelConfig = mongoose.model('SpinWheelConfig');
    let cfg = await SpinWheelConfig.findOne({ key: 'main' }).lean();
    if (!cfg) cfg = { enabled: true, cooldownHours: 24, segments: [
      { label:'₹5',  amount:5,   probability:0.30, color:'#F59E0B' },
      { label:'₹10', amount:10,  probability:0.25, color:'#10B981' },
      { label:'₹25', amount:25,  probability:0.15, color:'#3B82F6' },
      { label:'₹50', amount:50,  probability:0.10, color:'#8B5CF6' },
      { label:'₹100',amount:100, probability:0.05, color:'#EF4444' },
      { label:'Try Again',amount:0,probability:0.15,color:'#6B7280' },
    ]};
    res.json({ success: true, config: cfg });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/spin/spin', authenticate, async (req, res) => {
  try {
    const SpinWheelConfig = mongoose.model('SpinWheelConfig');
    const SpinRecord = mongoose.model('SpinRecord');
    const BonusRecord = mongoose.model('BonusRecord');
    const User = mongoose.model('User');

    const cfg = await SpinWheelConfig.findOne({ key: 'main' });
    if (cfg?.enabled === false) return res.status(400).json({ success: false, message: 'Spin wheel is disabled' });

    const hours = cfg?.cooldownHours || 24;
    const lastSpin = await SpinRecord.findOne({ userId: req.user._id }).sort({ spunAt: -1 });
    if (lastSpin && (Date.now() - lastSpin.spunAt.getTime()) < hours * 3600000) {
      const nextSpin = new Date(lastSpin.spunAt.getTime() + hours * 3600000);
      return res.status(400).json({ success: false, message: 'Already spun today', nextSpinAt: nextSpin });
    }

    const segments = cfg?.segments || [];
    const rand = Math.random();
    let cumulative = 0;
    let winner = segments[segments.length - 1];
    for (const seg of segments) { cumulative += seg.probability; if (rand <= cumulative) { winner = seg; break; } }

    if (winner.amount > 0) {
      // Spin winnings go to winningsBalance (withdrawable)
      await creditWinnings(req.user._id, winner.amount, `Spin wheel: \${winner.label}`, 'SpinWheel', null, `spin_\${req.user._id}_\${Date.now()}`);
      await BonusRecord.create({ userId: req.user._id, type: 'SPIN_WHEEL', amount: winner.amount, description: `Spin wheel: ${winner.label}` });
    }
    await SpinRecord.create({ userId: req.user._id, segment: winner.label, amount: winner.amount });

    res.json({ success: true, result: winner, message: winner.amount > 0 ? `🎉 You won ${winner.label}!` : 'Better luck next time!' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.put('/admin/spin/config', authenticate, isAdmin, async (req, res) => {
  try {
    const SpinWheelConfig = mongoose.model('SpinWheelConfig');
    const { segments, cooldownHours, enabled } = req.body;
    const total = segments?.reduce((s, seg) => s + seg.probability, 0) || 0;
    if (segments && Math.abs(total - 1) > 0.01) return res.status(400).json({ success: false, message: 'Probabilities must sum to 1.0' });
    const cfg = await SpinWheelConfig.findOneAndUpdate({ key: 'main' }, { segments, cooldownHours, enabled, updatedBy: req.user._id, updatedAt: new Date() }, { upsert: true, new: true });
    res.json({ success: true, config: cfg });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── ANNOUNCEMENTS ─────────────────────────────────────────────────────────────
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
    const { title, body, type, priority, expiresAt } = req.body;
    if (!title || !body) return res.status(400).json({ success: false, message: 'Title and body required' });
    const item = await Announcement.create({ title, body, type: type||'INFO', priority: priority||0, expiresAt: expiresAt ? new Date(expiresAt) : undefined, createdBy: req.user._id });
    res.json({ success: true, announcement: item });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.put('/admin/announcements/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const Announcement = mongoose.model('Announcement');
    const item = await Announcement.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, announcement: item });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
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
      BonusRecord.find({ userId: req.user._id }).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      BonusRecord.countDocuments({ userId: req.user._id }),
    ]);
    res.json({ success: true, records, total });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── VIP ───────────────────────────────────────────────────────────────────────
router.get('/vip/config', async (req, res) => {
  try {
    const VIPLevelConfig = mongoose.model('VIPLevelConfig');
    let cfg = await VIPLevelConfig.findOne({ key: 'main' }).lean();
    if (!cfg) cfg = { levels: [
      { level:0, name:'Bronze',   minTotalDeposit:0,     dailyWithdrawalLimit:10000, bonusPercent:0,   badgeColor:'#CD7F32', badgeIcon:'🥉' },
      { level:1, name:'Silver',   minTotalDeposit:1000,  dailyWithdrawalLimit:25000, bonusPercent:1,   badgeColor:'#C0C0C0', badgeIcon:'🥈' },
      { level:2, name:'Gold',     minTotalDeposit:5000,  dailyWithdrawalLimit:50000, bonusPercent:2,   badgeColor:'#FFD700', badgeIcon:'🥇' },
      { level:3, name:'Platinum', minTotalDeposit:20000, dailyWithdrawalLimit:100000,bonusPercent:3,   badgeColor:'#E5E4E2', badgeIcon:'💎' },
      { level:4, name:'Diamond',  minTotalDeposit:100000,dailyWithdrawalLimit:500000,bonusPercent:5,   badgeColor:'#B9F2FF', badgeIcon:'👑' },
    ]};
    res.json({ success: true, config: cfg });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/vip/my', authenticate, async (req, res) => {
  try {
    const UserVIP = mongoose.model('UserVIP');
    const VIPLevelConfig = mongoose.model('VIPLevelConfig');
    const [vip, cfg] = await Promise.all([UserVIP.findOne({ userId: req.user._id }), VIPLevelConfig.findOne({ key:'main' })]);
    const levels = cfg?.levels || [];
    const current = levels.find(l => l.level === (vip?.currentLevel||0)) || levels[0] || {};
    const nextLevel = levels.find(l => l.level === (vip?.currentLevel||0) + 1);
    res.json({ success: true, vip: vip||{ currentLevel:0, totalDeposited:0 }, currentLevelInfo: current, nextLevelInfo: nextLevel||null });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.put('/admin/vip/config', authenticate, isAdmin, async (req, res) => {
  try {
    const VIPLevelConfig = mongoose.model('VIPLevelConfig');
    const cfg = await VIPLevelConfig.findOneAndUpdate({ key:'main' }, { levels: req.body.levels, updatedBy: req.user._id, updatedAt: new Date() }, { upsert:true, new:true });
    res.json({ success: true, config: cfg });
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
    const adjustDoc = await BalanceAdjustment.create({ userId, adminId: req.user._id, type, field, amount: Number(amount), reason, beforeBalance: before, afterBalance: before + (type==='CREDIT'?1:-1)*Number(amount) });
    await adminAdjustment(req.user._id, userId, type, field, Number(amount), reason, adjustDoc._id.toString());
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
