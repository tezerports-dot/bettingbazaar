// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { creditWinnings, creditDeposit } from '../services/walletAuthority.service.js';
import express from 'express';
import mongoose from 'mongoose';
import { authenticate, isAdmin, isAdminOrSubAdmin } from '../middleware/auth.middleware.js';
const router = express.Router();

// POST /api/giftcode/redeem
router.post('/redeem', authenticate, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'Code is required' });
    const GiftCode = mongoose.model('GiftCode');
    const GiftCodeRedemption = mongoose.model('GiftCodeRedemption');
    const BonusRecord = mongoose.model('BonusRecord');
    const User = mongoose.model('User');

    const gc = await GiftCode.findOne({ code: code.toUpperCase().trim() });
    if (!gc || !gc.isActive) return res.status(404).json({ success: false, message: 'Invalid or expired code' });
    if (gc.expiresAt && gc.expiresAt < new Date()) return res.status(400).json({ success: false, message: 'This code has expired' });
    if (gc.usedCount >= gc.maxUses) return res.status(400).json({ success: false, message: 'This code has been fully redeemed' });

    const alreadyUsed = await GiftCodeRedemption.findOne({ codeId: gc._id, userId: req.user._id });
    if (alreadyUsed) return res.status(400).json({ success: false, message: 'You have already used this code' });

    await GiftCode.findByIdAndUpdate(gc._id, { $inc: { usedCount: 1 } });
    await GiftCodeRedemption.create({ codeId: gc._id, code: gc.code, userId: req.user._id, amount: gc.amount });
    // Gift code credits: WINNINGS_BALANCE → creditWinnings, others → depositBalance
    // NOTE: Only winningsBalance is withdrawable; DEPOSIT type goes to non-withdrawable deposit balance
    const txId = `giftcode_\${gc.code}_\${req.user._id}`;
    if (gc.bonusType === 'WINNINGS_BALANCE' || gc.bonusType === 'TOKENS') {
      await creditWinnings(req.user._id, gc.amount, `Gift code: \${gc.code}`, 'GiftCode', gc._id, txId);
    } else {
      await creditDeposit(req.user._id, gc.amount, txId);
    }
    await BonusRecord.create({ userId: req.user._id, type: 'GIFT_CODE', amount: gc.amount, description: `Gift code: ${gc.code}`, refId: gc.code });

    res.json({ success: true, amount: gc.amount, message: `🎁 ₹${gc.amount} credited to your account!` });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ success: false, message: 'You have already used this code' });
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/admin/giftcodes
router.get('/admin/giftcodes', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const GiftCode = mongoose.model('GiftCode');
    const codes = await GiftCode.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, codes });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /api/admin/giftcodes
router.post('/admin/giftcodes', authenticate, isAdmin, async (req, res) => {
  try {
    const GiftCode = mongoose.model('GiftCode');
    const { code, amount, bonusType, maxUses, expiresAt, note } = req.body;
    if (!code || !amount) return res.status(400).json({ success: false, message: 'Code and amount required' });
    const gc = await GiftCode.create({ code: code.toUpperCase(), amount, bonusType, maxUses: maxUses || 1, expiresAt: expiresAt ? new Date(expiresAt) : undefined, note, createdBy: req.user._id });
    res.json({ success: true, giftCode: gc });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ success: false, message: 'Code already exists' });
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/admin/giftcodes/:id
router.delete('/admin/giftcodes/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const GiftCode = mongoose.model('GiftCode');
    await GiftCode.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /api/admin/giftcodes/:id/redemptions
router.get('/admin/giftcodes/:id/redemptions', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    const GiftCodeRedemption = mongoose.model('GiftCodeRedemption');
    const redemptions = await GiftCodeRedemption.find({ codeId: req.params.id }).sort({ redeemedAt: -1 }).lean();
    res.json({ success: true, redemptions });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

export default router;
