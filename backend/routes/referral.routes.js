/**
 * referral.routes.js — Referral system + commission distribution
 * Mounted at /api/referral (user-facing) and /api/admin/referral (admin)
 */
// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import express from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { authenticate, isAdmin, isAdminOrSubAdmin } from '../middleware/auth.middleware.js';

const router = express.Router();

function generateCode(userId) {
  return crypto.createHash('sha256').update(String(userId) + Date.now()).digest('hex').slice(0, 8).toUpperCase();
}

// GET /api/referral/me — get or create referral record for logged-in user
router.get('/me', authenticate, async (req, res) => {
  try {
    const Referral = mongoose.model('Referral');
    const User     = mongoose.model('User');
    let ref = await Referral.findOne({ userId: req.user._id });
    if (!ref) {
      const code = generateCode(req.user._id);
      ref = await Referral.create({ userId: req.user._id, inviteCode: code });
    }
    const f1s = await Referral.find({ referredBy: req.user._id }).lean();
    const CommissionRecord = mongoose.model('CommissionRecord');
    const today = new Date().toISOString().slice(0, 10);
    const [todayEarned] = await CommissionRecord.aggregate([
      { $match: { beneficiaryId: req.user._id, createdAt: { $gte: new Date(today) }, credited: true } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    res.json({
      success: true,
      inviteCode: ref.inviteCode,
      inviteUrl: `${process.env.APP_BASE_URL || ''}/?ref=${ref.inviteCode}`,
      totalReferrals: ref.totalReferrals,
      activeReferrals: ref.activeReferrals,
      totalEarned: ref.totalEarned,
      todayEarned: todayEarned?.total || 0,
      directReferrals: f1s.map(r => ({ userId: r.userId, joinedAt: r.createdAt })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/referral/team — full downline (F1, F2, F3)
router.get('/team', authenticate, async (req, res) => {
  try {
    const Referral = mongoose.model('Referral');
    const User     = mongoose.model('User');
    const myRef = await Referral.findOne({ userId: req.user._id }).lean();
    if (!myRef) return res.json({ success: true, f1: [], f2: [], f3: [] });

    const f1Refs = await Referral.find({ referredBy: req.user._id }).lean();
    const f1Ids  = f1Refs.map(r => r.userId);
    const f2Refs = await Referral.find({ referredBy: { $in: f1Ids } }).lean();
    const f2Ids  = f2Refs.map(r => r.userId);
    const f3Refs = await Referral.find({ referredBy: { $in: f2Ids } }).lean();

    const enrich = async (refs) => {
      const userIds = refs.map(r => r.userId);
      const users = await User.find({ _id: { $in: userIds } })
        .select('username mobile depositBalance createdAt').lean();
      return refs.map(r => {
        const u = users.find(u => String(u._id) === String(r.userId));
        return { ...r, username: u?.username, mobile: u?.mobile?.slice(-4).padStart(10, '*'), joinedAt: r.createdAt };
      });
    };

    const [f1, f2, f3] = await Promise.all([enrich(f1Refs), enrich(f2Refs), enrich(f3Refs)]);
    res.json({ success: true, f1, f2, f3 });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/referral/commissions — commission history for logged-in user
router.get('/commissions', authenticate, async (req, res) => {
  try {
    const CommissionRecord = mongoose.model('CommissionRecord');
    const { page = 1, limit = 30 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);
    const [records, total] = await Promise.all([
      CommissionRecord.find({ beneficiaryId: req.user._id })
        .sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      CommissionRecord.countDocuments({ beneficiaryId: req.user._id }),
    ]);
    res.json({ success: true, records, total, pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// H-03: Only F1 commissions are live — gameEngine.js only calls F1 payout.
// F2/F3 were removed from schema and never paid. The admin config below only
// exposes f1Rate. No F2/F3 fields are accepted or stored.
// GET /api/admin/referral/config — get commission rates
router.get('/admin/referral/config', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const CommissionLevel = mongoose.model('CommissionLevel');
    let cfg = await CommissionLevel.findOne({ key: 'main' });
    if (!cfg) cfg = await CommissionLevel.create({ key: 'main', f1Rate: 0.01, commissionEnabled: true });
    res.json({ success: true, config: cfg });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/admin/referral/config — update commission rates
router.put('/admin/referral/config', authenticate, isAdmin, async (req, res) => {
  try {
    const CommissionLevel = mongoose.model('CommissionLevel');
    const { f1Rate, minBetForCommission, commissionEnabled } = req.body;
    if (f1Rate !== undefined && (isNaN(Number(f1Rate)) || f1Rate < 0 || f1Rate > 0.5))
      return res.status(400).json({ success: false, message: 'f1Rate must be 0–0.5 (0%–50%)' });
    const _upd = { updatedBy: req.user._id, updatedAt: new Date() };
    if (f1Rate !== undefined)             _upd.f1Rate             = Number(f1Rate);
    if (minBetForCommission !== undefined) _upd.minBetForCommission = minBetForCommission;
    if (commissionEnabled !== undefined)   _upd.commissionEnabled   = commissionEnabled;
    const cfg = await CommissionLevel.findOneAndUpdate(
      { key: 'main' }, _upd, { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ success: true, config: cfg });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/referral/stats — admin overview
router.get('/admin/referral/stats', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const Referral = mongoose.model('Referral');
    const CommissionRecord = mongoose.model('CommissionRecord');
    const [totalReferrers, topEarners, totalPaid] = await Promise.all([
      Referral.countDocuments({ referredBy: { $ne: null } }),
      CommissionRecord.aggregate([
        { $match: { credited: true } },
        { $group: { _id: '$beneficiaryId', total: { $sum: '$amount' } } },
        { $sort: { total: -1 } }, { $limit: 10 },
      ]),
      CommissionRecord.aggregate([
        { $match: { credited: true } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ]);
    res.json({ success: true, totalReferrers, topEarners, totalPaid: totalPaid[0]?.total || 0 });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/referral/apply — apply an invite code (called after registration)
router.post('/apply', authenticate, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'Invite code required' });
    const Referral = mongoose.model('Referral');

    // Block self-referral
    const myRef = await Referral.findOne({ userId: req.user._id, inviteCode: code.toUpperCase() }).lean();
    if (myRef) return res.status(400).json({ success: false, message: 'You cannot use your own invite code' });

    // Check already referred
    const alreadyReferred = await Referral.findOne({ userId: req.user._id, referredBy: { $ne: null } }).lean();
    if (alreadyReferred) return res.status(400).json({ success: false, message: 'You have already applied a referral code' });

    // Find referrer
    const referrerRef = await Referral.findOne({ inviteCode: code.toUpperCase() }).lean();
    if (!referrerRef) return res.status(404).json({ success: false, message: 'Invalid invite code' });

    // Link referral
    await Referral.findOneAndUpdate(
      { userId: req.user._id },
      { referredBy: referrerRef.userId, appliedCode: code.toUpperCase(), appliedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ success: true, message: 'Referral code applied successfully' });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
