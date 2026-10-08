// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * routes/admin/telegram.admin.routes.js — the one bot, the staff account's own
 * Telegram link, and the referral batches.
 *
 * ── The one bot (Step 3, owner 2026-10-07) ─────────────────────────────────
 * One bot carries the Mini App that verifies every account and approves staff
 * and merchant sign-ins. Telegram suspends gambling bots, so replacing it must
 * be a form an operator fills at 3am, not a deploy: PUT a new token here. Links
 * survive a swap — they key on the PERSON's Telegram id, which belongs to
 * Telegram, not to the bot. The fleet, the channels, the recovery bots and the
 * bot messages that used to be configured here are gone.
 *
 * ── Two areas, each granted on its own ────────────────────────────────────
 * Telegram setup (`canManageTelegram`) holds the key that signs every Mini App
 * proof; referrals (`canManageReferrals`) pay money.
 */
import express from 'express';
import { authenticate, authenticateStaff, hasPermission } from '../../domains/identity/auth.middleware.js';
import { encryptField } from '../../domains/identity/fieldCrypto.util.js';
import { verifyBotToken, invalidateBotCache } from '../../domains/telegram/telegramClient.js';
import { telegramStatus, telegramRelink, telegramTwoFactor } from '../../domains/identity/accountTelegram.js';
import { db } from '#db';
import { disburse, programmeStats } from '../../domains/referral/referral.service.js';
import { rupeesToPaise, paiseToRupees } from '../../shared/money.js';
import { serverError, respondError, refusal } from '../../shared/httpError.js';

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════════
// THE STAFF ACCOUNT'S OWN TELEGRAM (accountTelegram.js; SELF_ROUTES)
// ═══════════════════════════════════════════════════════════════════════════
// About the caller themselves, so no area: every staff account, of any role,
// may see and move its own link. `authenticateStaff` admits STAFF rows only.
router.get('/account/telegram', authenticateStaff, telegramStatus);
router.post('/account/telegram/relink', authenticateStaff, telegramRelink);
router.put('/account/telegram/two-factor', authenticateStaff, telegramTwoFactor);

// ═══════════════════════════════════════════════════════════════════════════
// THE ONE BOT
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/admin/telegram/bot — the bot, never its token. */
router.get('/telegram/bot', authenticate, hasPermission('canManageTelegram'), async (req, res) => {
  try {
    const bot = await db.telegram.getBot();
    return res.json({
      success: true,
      configured: Boolean(bot),
      botId: bot?.botId || null,
      botUsername: bot?.botUsername || '',
      miniAppShortName: bot?.miniAppShortName || '',
      updatedAt: bot?.updatedAt || null,
      updatedBy: bot?.updatedBy || null,
    });
  } catch (err) {
    return serverError(res, err, 'GET /admin/telegram/bot');
  }
});

/** BotFather's short-name rules for a Mini App. Empty = the bot's main Mini App. */
const SHORT_NAME = /^[A-Za-z0-9_]{0,64}$/;

/**
 * PUT /api/admin/telegram/bot `{ token?, miniAppShortName? }`.
 *
 * A token is asked of Telegram (`getMe`) BEFORE it is stored, and the bot's id
 * and @username are Telegram's answer, never typed: a token for the wrong bot,
 * or no bot, is refused by name. Stored encrypted (IDENTITY_ENCRYPTION_KEY).
 * The cache on this instance is dropped at once; others follow within 30 s.
 */
router.put('/telegram/bot', authenticate, hasPermission('canManageTelegram'), async (req, res) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    const short = req.body?.miniAppShortName;
    if (short !== undefined && (typeof short !== 'string' || !SHORT_NAME.test(short))) {
      throw refusal(400, 'SHORT_NAME_INVALID',
        'The Mini App short name is the part after the bot in t.me/<bot>/<short name>: letters, digits and _, or empty.');
    }
    if (!token && short === undefined) {
      throw refusal(400, 'NOTHING_TO_SAVE', 'Send a bot token, a Mini App short name, or both.');
    }

    let saved;
    if (token) {
      if (!/^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(token)) {
        throw refusal(400, 'TOKEN_INVALID', 'That is not a bot token. Copy it from @BotFather: digits, a colon, then letters.');
      }
      const me = await verifyBotToken(token);
      if (!me.ok) {
        throw refusal(400, 'TOKEN_INVALID', `Telegram did not accept that token (${me.error}). Copy it again from @BotFather.`);
      }
      saved = await db.telegram.saveBot({
        botId: me.id, botUsername: me.username, tokenEncrypted: encryptField(token),
        miniAppShortName: short, updatedBy: req.user.userId,
      });
    } else {
      saved = await db.telegram.saveBot({ miniAppShortName: short, updatedBy: req.user.userId });
      if (!saved) throw refusal(409, 'NO_BOT', 'Save a bot token first; the short name belongs to a bot.');
    }
    invalidateBotCache();
    console.warn(`[telegram] bot @${saved.botUsername} saved by ${req.user.userId}`);
    return res.json({
      success: true,
      configured: true,
      botId: saved.botId,
      botUsername: saved.botUsername,
      miniAppShortName: saved.miniAppShortName,
      updatedAt: saved.updatedAt,
      updatedBy: saved.updatedBy,
    });
  } catch (err) {
    return respondError(res, err, 'PUT /admin/telegram/bot', { message: 'Could not save the bot.' });
  }
});

// KYC batches (export/import of Aadhaar numbers) were removed 2026-10-02 with KYC.

// ═══════════════════════════════════════════════════════════════════════════
// REFERRAL PROGRAMME
// ═══════════════════════════════════════════════════════════════════════════

router.get('/referral/stats', authenticate, hasPermission('canManageReferrals'), async (req, res) => {
  try {
    const s = await programmeStats();
    res.json({
      success: true,
      budget:     paiseToRupees(s.budgetPaise),
      disbursed:  paiseToRupees(s.disbursedPaise),
      remaining:  paiseToRupees(s.remainingPaise),
      pendingCount: s.pendingCount,
      pendingValue: paiseToRupees(s.pendingPaise),
      blockedCount: s.blockedCount,
      blockedValue: paiseToRupees(s.blockedPaise),
      memberCap: s.memberCap,
      verifiedMembers: s.verifiedMembers,
      nextQueuePosition: s.nextQueuePosition,
      active: s.active,
    });
  } catch (err) {
    return serverError(res, err, 'GET /referral/stats');
  }
});

/**
 * POST /api/admin/referral/disburse — fund the queue.
 *
 * The admin supplies ONLY an amount. Who gets paid is never chosen by hand: the
 * queue pays strictly in joining order, which is what makes the programme
 * defensible to everyone waiting in it, and what stops a disbursal from being a
 * discretionary favour.
 */
router.post('/referral/disburse', authenticate, hasPermission('canManageReferrals'), async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'A positive amount is required' });
    }

    const result = await disburse({
      poolPaise: rupeesToPaise(amount),
      actorId: req.user.userId,
    });

    console.warn(`[referral] DISBURSAL ${result.batchId} by admin ${req.user.userId}: `
      + `₹${paiseToRupees(result.spentPaise)} to ${result.paid} earner(s), ${result.blocked} blocked`);

    res.json({
      success: true,
      batchId: result.batchId,
      paid: result.paid,
      blocked: result.blocked,
      spent: paiseToRupees(result.spentPaise),
      unspent: paiseToRupees(result.unspentPaise),
      paidUpToJoiner: result.lastQueuePosition,
      message: `₹${paiseToRupees(result.spentPaise)} paid to ${result.paid} referrer(s). `
        + `${result.blocked} skipped as ineligible — see the report for reasons.`,
    });
  } catch (err) {
    console.error('[admin/referral] disbursal failed:', err.message);
    return respondError(res, err, 'POST /admin/referral/disburse');
  }
});

export default router;
