// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * routes/admin/telegram.admin.routes.js — the bot, its standbys, and the referral batches.
 * A staff account has no Telegram of its own (owner, 2026-10-13: staff sign in
 * with an authenticator app, account.admin.routes.js).
 *
 * ── The bot and its standbys (Step 3, owner 2026-10-07; standbys 2026-10-14) ─
 * Slot 1 carries the Mini App that verifies every player and merchant account
 * and approves their sign-ins; slots 2-4 hold standby bots registered ahead of
 * time. Telegram suspends gambling bots, so the switch must not wait for an
 * operator: the health check (`telegram-bot-health`) suspends a bot whose token
 * Telegram refuses and new links move to the next slot at once. Replacing a bot
 * is still a form, not a deploy: PUT a new token to its slot. Links survive any
 * swap — they key on the PERSON's Telegram id, which belongs to Telegram, not
 * to the bot. The channels, the recovery bots and the bot messages that used
 * to be configured here are gone.
 *
 * ── Two areas, each granted on its own ────────────────────────────────────
 * Telegram setup (`canManageTelegram`) holds the key that signs every Mini App
 * proof; referrals (`canManageReferrals`) pay money.
 */
import express from 'express';
import { authenticate, hasPermission } from '../../domains/identity/auth.middleware.js';
import { encryptField } from '../../domains/identity/fieldCrypto.util.js';
import { verifyBotToken, invalidateBotCache, miniAppBots } from '../../domains/telegram/telegramClient.js';
import { db } from '#db';
import { disburse, programmeStats } from '../../domains/referral/referral.service.js';
import { rupeesToPaise, paiseToRupees } from '../../shared/money.js';
import { serverError, respondError, refusal } from '../../shared/httpError.js';

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════════
// THE BOT AND ITS STANDBYS
// ═══════════════════════════════════════════════════════════════════════════

const botView = (b) => ({
  slot: b.slot,
  botId: b.botId,
  botUsername: b.botUsername,
  miniAppShortName: b.miniAppShortName || '',
  suspended: Boolean(b.suspendedAt),
  suspendedAt: b.suspendedAt || null,
  suspendedReason: b.suspendedReason || '',
  updatedAt: b.updatedAt || null,
  updatedBy: b.updatedBy || null,
});

/** The slot in the path or body, 1..BOT_SLOTS, or a refusal. */
function slotOf(raw, { fallback = 1 } = {}) {
  const slot = raw === undefined || raw === null || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(slot) || slot < 1 || slot > db.telegram.BOT_SLOTS) {
    throw refusal(400, 'SLOT_INVALID', `slot must be 1 (the primary) to ${db.telegram.BOT_SLOTS}.`);
  }
  return slot;
}

/**
 * GET /api/admin/telegram/bot — every saved bot, never a token. The top-level
 * fields describe the bot IN USE (the lowest slot not suspended), as before;
 * `bots` lists every slot that holds one.
 */
router.get('/telegram/bot', authenticate, hasPermission('canManageTelegram'), async (req, res) => {
  try {
    const bots = await db.telegram.getBots();
    const bot = bots.find((b) => !b.suspendedAt) ?? null;
    return res.json({
      success: true,
      configured: Boolean(bot),
      slot: bot?.slot ?? null,
      botId: bot?.botId || null,
      botUsername: bot?.botUsername || '',
      miniAppShortName: bot?.miniAppShortName || '',
      updatedAt: bot?.updatedAt || null,
      updatedBy: bot?.updatedBy || null,
      slots: db.telegram.BOT_SLOTS,
      bots: bots.map(botView),
    });
  } catch (err) {
    return serverError(res, err, 'GET /admin/telegram/bot');
  }
});

/** BotFather's short-name rules for a Mini App. Empty = the bot's main Mini App. */
const SHORT_NAME = /^[A-Za-z0-9_]{0,64}$/;

/**
 * PUT /api/admin/telegram/bot `{ slot?, token?, miniAppShortName? }` (slot 1
 * when left out).
 *
 * A token is asked of Telegram (`getMe`) BEFORE it is stored, and the bot's id
 * and @username are Telegram's answer, never typed: a token for the wrong bot,
 * or no bot, is refused by name. Stored encrypted (IDENTITY_ENCRYPTION_KEY).
 * A new token lifts the slot's suspension. One bot sits in one slot: saving
 * a bot already in another is refused (409 BOT_IN_OTHER_SLOT). The cache on
 * this instance is dropped at once; others follow within 5 s.
 */
router.put('/telegram/bot', authenticate, hasPermission('canManageTelegram'), async (req, res) => {
  try {
    const slot = slotOf(req.body?.slot);
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
        slot, botId: me.id, botUsername: me.username, tokenEncrypted: encryptField(token),
        miniAppShortName: short, updatedBy: req.user.userId,
      });
      if (saved?.conflict) {
        throw refusal(409, 'BOT_IN_OTHER_SLOT',
          `@${me.username} is already saved in slot ${saved.conflict}. A standby must be a different bot.`);
      }
    } else {
      saved = await db.telegram.saveBot({ slot, miniAppShortName: short, updatedBy: req.user.userId });
      if (!saved) throw refusal(409, 'NO_BOT', 'Save a bot token first; the short name belongs to a bot.');
    }
    invalidateBotCache();
    console.warn(`[telegram] bot @${saved.botUsername} saved in slot ${slot} by ${req.user.userId}`);
    return res.json({ success: true, configured: true, ...botView(saved) });
  } catch (err) {
    return respondError(res, err, 'PUT /admin/telegram/bot', { message: 'Could not save the bot.' });
  }
});

/**
 * DELETE /api/admin/telegram/bot/:slot — remove a standby. The primary (slot
 * 1) is replaced with PUT, never removed: removing it would leave no bot.
 */
router.delete('/telegram/bot/:slot', authenticate, hasPermission('canManageTelegram'), async (req, res) => {
  try {
    const slot = slotOf(req.params.slot);
    if (slot === 1) throw refusal(400, 'PRIMARY_NOT_REMOVABLE', 'The primary bot is replaced with a new token, never removed.');
    if (!(await db.telegram.removeBot(slot))) throw refusal(404, 'NO_BOT', `Slot ${slot} holds no bot.`);
    invalidateBotCache();
    console.warn(`[telegram] standby bot in slot ${slot} removed by ${req.user.userId}`);
    return res.json({ success: true, slot });
  } catch (err) {
    return respondError(res, err, 'DELETE /admin/telegram/bot/:slot', { message: 'Could not remove the bot.' });
  }
});

/**
 * POST /api/admin/telegram/bot/:slot/resume — put a suspended bot back in
 * use. Telegram is asked first: a token it still refuses stays suspended.
 */
router.post('/telegram/bot/:slot/resume', authenticate, hasPermission('canManageTelegram'), async (req, res) => {
  try {
    const slot = slotOf(req.params.slot);
    const bot = (await miniAppBots({ force: true })).find((b) => b.slot === slot);
    if (!bot) throw refusal(404, 'NO_BOT', `Slot ${slot} holds no bot.`);
    if (!bot.suspended) throw refusal(409, 'NOT_SUSPENDED', `@${bot.botUsername} is already in use.`);
    const me = await verifyBotToken(bot.token);
    if (!me.ok) {
      throw refusal(409, 'TOKEN_STILL_REFUSED',
        `Telegram still refuses @${bot.botUsername}'s token (${me.error}). Save a new token from @BotFather instead.`);
    }
    const row = await db.telegram.setBotSuspended({ slot, reason: null, botId: bot.botId, updatedBy: req.user.userId });
    if (!row) throw refusal(409, 'NOT_SUSPENDED', 'The bot changed meanwhile; reload.');
    invalidateBotCache();
    console.warn(`[telegram] bot @${row.botUsername} in slot ${slot} resumed by ${req.user.userId}`);
    return res.json({ success: true, ...botView(row) });
  } catch (err) {
    return respondError(res, err, 'POST /admin/telegram/bot/:slot/resume', { message: 'Could not resume the bot.' });
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
      // Paid automatically every minute (`referral-autopay`); no budget.
      paid:       paiseToRupees(s.paidPaise),
      paidCount:  s.paidCount,
      pendingCount: s.pendingCount,
      pendingValue: paiseToRupees(s.pendingPaise),
      blockedCount: s.blockedCount,
      blockedValue: paiseToRupees(s.blockedPaise),
      memberCap: s.memberCap,
      verifiedMembers: s.verifiedMembers,
      nextQueuePosition: s.nextQueuePosition,
    });
  } catch (err) {
    return serverError(res, err, 'GET /referral/stats');
  }
});

/**
 * POST /api/admin/referral/disburse — pay the queue now, up to an amount.
 *
 * The queue is paid every minute by itself (`referral-autopay`); this runs it
 * at once. The admin supplies ONLY an amount. Who gets paid is never chosen by hand: the
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
