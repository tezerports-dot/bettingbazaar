// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * routes/giftcode.routes.js — promotional codes.
 *
 * ── The redemption is one transaction, and the credit is a retry ────────────
 * This route used to claim a use, insert a redemption, credit the player, and
 * — whenever any step after the first failed — UNDO the earlier ones: delete
 * the redemption, decrement `usedCount`, tell the player nothing happened.
 * Three writes to unwind one, each able to fail on its own, every one of them
 * `.catch(() => {})`. A crash between any two burned the code and paid nobody.
 *
 * The claim and the redemption row now commit TOGETHER (`redeemGiftCode`), and
 * the credit is keyed on a deterministic txId derived from them. So a failed
 * credit is RETRYABLE, not reversible: the player keeps their claim, the retry
 * collides on the key rather than paying twice, and
 * `db.engagement.findUnpaidRedemptions()` is the list a reconciliation job
 * works through. Detect and repair, never compensate and hope.
 *
 * ── The money is paid FROM a funded pool ────────────────────────────────────
 * `db.bonuses.grant` moves the reward out of the promotional pool that funds
 * it, in one movement, rather than crediting it from nowhere. Promotional
 * liability that appears in player balances without leaving a pool is money the
 * books cannot explain, and explaining it is what an audit asks for.
 */
import express from 'express';
import { db } from '#db';
import { authenticate, isAdmin, isAdminOrSubAdmin } from '../domains/identity/auth.middleware.js';

const router = express.Router();

/** The credit's idempotency key. Derived, so a repair reproduces it exactly. */
const txIdFor = (code, userId) => `giftcode_${code}_${userId}`;

// POST /api/giftcode/redeem
router.post('/redeem', authenticate, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: 'Code is required' });

    // Claim and record, or neither. The refusal says WHICH rule stopped it,
    // because "invalid code" for an expired one sends the player to support.
    const claim = await db.engagement.redeemGiftCode(code, req.user.userId);
    if (!claim.ok) {
      const message = {
        NOT_FOUND: 'That code does not exist.',
        INACTIVE: 'That code is no longer active.',
        EXPIRED: 'That code has expired.',
        FULLY_REDEEMED: 'That code has already been fully redeemed.',
        ALREADY_REDEEMED: 'You have already used this code.',
      }[claim.reason] || 'That code cannot be redeemed.';
      return res.status(400).json({ success: false, message });
    }

    const txId = txIdFor(claim.code ?? String(code).toUpperCase(), req.user.userId);

    // Paid out of the promotional pool. A refusal here means the promotion is
    // not funded — the claim STANDS and reconciliation retries it, because
    // taking the code back is three more writes that can fail.
    const granted = await db.bonuses.grant({
      grantId: txId,
      userId: req.user.userId,
      recordType: 'GIFT_CODE',
      amountRupees: claim.amount,
      refModel: 'GiftCode',
      refId: claim.code,
      reason: `Gift code: ${claim.code}`,
    });

    if (!granted.ok) {
      console.error('[giftcode] reward not funded for', claim.code, granted.reason);
      return res.status(202).json({
        success: true,
        pending: true,
        amount: claim.amount,
        message: 'Your code was accepted. The reward is being processed and will appear shortly.',
      });
    }

    // The audit record of WHY the money moved, beside the ledger row that says
    // it did. Keyed on the same id, so a retry records once.
    await db.engagement.recordBonus({
      bonusId: txId,
      userId: req.user.userId,
      bonusType: 'GIFT_CODE',
      amountRupees: claim.amount,
      description: `Gift code: ${claim.code}`,
      refId: claim.code,
    });

    res.json({
      success: true,
      amount: claim.amount,
      message: `🎁 ₹${claim.amount} credited to your account!`,
    });
  } catch (err) {
    console.error('POST /giftcode/redeem error:', err);
    res.status(500).json({ success: false, message: 'Could not redeem that code.' });
  }
});

// ─── ADMIN ───────────────────────────────────────────────────────────────────

router.get('/admin/giftcodes', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    res.json({ success: true, codes: await db.engagement.listGiftCodes({ limit: 500 }) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post('/admin/giftcodes', authenticate, isAdmin, async (req, res) => {
  try {
    const { code, amount, bonusType, maxUses, expiresAt, note } = req.body;
    if (!code || !amount) return res.status(400).json({ success: false, message: 'Code and amount required' });
    if (!(Number(amount) > 0)) return res.status(400).json({ success: false, message: 'Amount must be positive' });

    const giftCode = await db.engagement.createGiftCode({
      code, amountRupees: Number(amount), bonusType,
      maxUses: Number(maxUses) || 1,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      note: note || '', createdBy: req.user.userId,
    });

    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'GIFT_CODE_CREATED', category: 'PROMOTIONS',
      targetType: 'GiftCode', targetId: giftCode.code,
      details: { amount: giftCode.amount, maxUses: giftCode.maxUses, expiresAt: giftCode.expiresAt },
    });
    res.json({ success: true, giftCode });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ success: false, message: 'Code already exists' });
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * Retire a code.
 *
 * DEACTIVATED, not deleted. The redemptions reference it, and "who was paid
 * what, under which promotion" is a question a finance review asks months
 * later — a delete that cascaded would take the answer with it.
 */
router.delete('/admin/giftcodes/:code', authenticate, isAdmin, async (req, res) => {
  try {
    const updated = await db.engagement.setGiftCodeActive(req.params.code, false);
    if (!updated) return res.status(404).json({ success: false, message: 'Code not found' });
    await db.audit.recordDetailed({
      performedBy: req.user.userId, action: 'GIFT_CODE_RETIRED', category: 'PROMOTIONS',
      targetType: 'GiftCode', targetId: updated.code,
      details: { usedCount: updated.usedCount, maxUses: updated.maxUses },
    });
    res.json({ success: true, giftCode: updated });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get('/admin/giftcodes/:code/redemptions', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    res.json({
      success: true,
      redemptions: await db.engagement.listRedemptions({ code: req.params.code, limit: 500 }),
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

/**
 * Redemptions whose reward never landed.
 *
 * The operator's view of the repair queue. It is money owed, so it is visible
 * rather than buried in a log line.
 */
router.get('/admin/giftcodes/unpaid', authenticate, isAdminOrSubAdmin, async (req, res) => {
  try {
    res.json({ success: true, unpaid: await db.engagement.findUnpaidRedemptions() });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

export default router;
