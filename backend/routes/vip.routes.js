// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import express from 'express';
import mongoose from 'mongoose';
const router = express.Router();
import { authenticate } from '../middleware/auth.middleware.js';

router.get('/my', authenticate, async (req, res) => {
  try {
    const UserVIP = mongoose.model('UserVIP');
    const vip = await UserVIP.findOne({ userId: req.user._id }).lean();
    res.json({ success: true, vip: vip || { currentLevel: 0, totalDeposited: 0 } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.get('/config', async (req, res) => {
  try {
    const VIPLevelConfig = mongoose.model('VIPLevelConfig');
    const levels = await VIPLevelConfig.find().sort({ level: 1 }).lean();
    const defaults = levels.length ? levels : [
      { level:0, name:'Bronze', badgeIcon:'🥉', badgeColor:'#cd7f32', minTotalDeposited:0,    bonusPercent:0,  dailyWithdrawalLimit:10000, withdrawalFeeDiscount:0 },
      { level:1, name:'Silver', badgeIcon:'🥈', badgeColor:'#C0C0C0', minTotalDeposited:10000, bonusPercent:2, dailyWithdrawalLimit:25000, withdrawalFeeDiscount:5 },
      { level:2, name:'Gold',   badgeIcon:'🥇', badgeColor:'#D4AF37', minTotalDeposited:50000, bonusPercent:5, dailyWithdrawalLimit:50000, withdrawalFeeDiscount:10 },
      { level:3, name:'Platinum',badgeIcon:'💎',badgeColor:'#E5E4E2', minTotalDeposited:200000,bonusPercent:10,dailyWithdrawalLimit:100000,withdrawalFeeDiscount:20 },
    ];
    res.json({ success: true, config: { levels: defaults } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

export default router;
