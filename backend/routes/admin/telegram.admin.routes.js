// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * routes/admin/telegram.admin.routes.js — operating the Telegram layer.
 *
 * Three jobs, all of them things an operator must be able to do at 3am without
 * a developer: replace a banned bot, replace a lost channel, and run the KYC
 * and referral batches.
 *
 * ── Why replacement is a first-class operation ──────────────────────────────
 * Telegram suspends bots, and gambling bots more than most. If replacing one
 * required a code change and a deploy, a suspension would be an outage measured
 * in hours during which nobody can sign up or log in. Activating a new
 * generation here is a database write plus a webhook registration, and existing
 * users are unaffected because identities are keyed on the person's Telegram
 * user id, which belongs to Telegram rather than to our bot.
 *
 * ── Everything here is isAdmin, never isAdminOrSubAdmin ─────────────────────
 * These endpoints move the platform's identity root and export national ID
 * numbers. Admin 2FA is mandatory platform-wide, so isAdmin also means "proved
 * a second factor" — which is the control the operator obligations research
 * calls for on raw-KYC access.
 */
import express from 'express';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { authenticate, isAdmin } from '../../domains/identity/auth.middleware.js';
import { TelegramConfig } from '../../domains/telegram/telegram.model.js';
import { encryptField } from '../../domains/identity/fieldCrypto.util.js';
import {
  verifyBotToken, setWebhook, invalidateConfigCache, activeConfig, liveBot,
} from '../../domains/telegram/telegramClient.js';
import {
  registerBot, promote, retire, retryWebhook, listBots,
} from '../../domains/telegram/telegramBots.service.js';
import { listTemplates, saveTemplate } from '../../domains/telegram/telegramTemplates.service.js';
import { buildExport, applyImport, kycStats } from '../../domains/identity/kycBulk.service.js';
import { disburse, programmeStats } from '../../domains/referral/referral.service.js';
import { rupeesToPaise, paiseToRupees } from '../../shared/money.js';

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════════
// TELEGRAM CONFIG
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/admin/telegram/config — the active generation, secrets omitted. */
router.get('/telegram/config', authenticate, isAdmin, async (req, res) => {
  try {
    const cfg = await activeConfig({ force: true });
    const history = await TelegramConfig.find({})
      .sort({ generation: -1 }).limit(10)
      .select('generation botUsername channelId channelUsername active activatedAt reason')
      .populate('activatedBy', 'username')
      .lean();

    res.json({
      success: true,
      // Tokens are NEVER returned. An admin who needs to change one supplies a
      // new value; there is no read path for a bot token by design.
      active: cfg && {
        generation: cfg.generation,
        botUsername: cfg.botUsername,
        recoveryBotUsername: cfg.recoveryBotUsername,
        channelId: cfg.channelId,
        channelUsername: cfg.channelUsername,
        channelInviteLink: cfg.channelInviteLink,
        botTokenConfigured: Boolean(cfg.botToken),
        recoveryBotConfigured: Boolean(cfg.recoveryBotToken),
        // Whether each live credential comes from the registry or from the
        // generation. Without this an operator who promotes a spare has no way
        // to confirm the promotion actually took effect.
        signinSource: cfg.signinSource,
        recoverySource: cfg.recoverySource,
      },
      history,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/admin/telegram/config — activate a new generation.
 *
 * The token is VERIFIED against Telegram before anything is stored: activating
 * a config with a dead token would take signup and login down until someone
 * noticed, and the failure would look like "the bot stopped working" rather
 * than "the value pasted was wrong".
 */
router.post('/telegram/config', authenticate, isAdmin, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const {
      botToken, recoveryBotToken, channelId, channelUsername, channelInviteLink,
      webhookBaseUrl, reason,
    } = req.body || {};

    if (!botToken || !channelId) {
      return res.status(400).json({ success: false, message: 'botToken and channelId are required' });
    }

    const probe = await verifyBotToken(botToken);
    if (!probe.ok) {
      return res.status(400).json({
        success: false,
        message: `Telegram rejected that bot token: ${probe.error}`,
      });
    }

    let recoveryUsername = '';
    if (recoveryBotToken) {
      const rprobe = await verifyBotToken(recoveryBotToken);
      if (!rprobe.ok) {
        return res.status(400).json({ success: false, message: `Recovery bot token rejected: ${rprobe.error}` });
      }
      recoveryUsername = rprobe.username || '';
    }

    const webhookSecret = crypto.randomBytes(32).toString('hex');
    const recoveryWebhookSecret = recoveryBotToken ? crypto.randomBytes(32).toString('hex') : null;

    let created;
    await session.withTransaction(async () => {
      const latest = await TelegramConfig.findOne({}).sort({ generation: -1 }).select('generation').session(session).lean();
      const generation = (latest?.generation || 0) + 1;

      // Deactivate the old one IN THE SAME transaction as activating the new.
      // The partial unique index refuses two active configs, so doing this in
      // two steps would either fail or leave a window with none active.
      await TelegramConfig.updateMany({ active: true }, { $set: { active: false } }, { session });

      const [doc] = await TelegramConfig.create([{
        generation,
        botTokenEncrypted: encryptField(botToken),
        botUsername: probe.username || '',
        webhookSecret,
        recoveryBotTokenEncrypted: recoveryBotToken ? encryptField(recoveryBotToken) : undefined,
        recoveryBotUsername: recoveryUsername,
        recoveryWebhookSecret: recoveryWebhookSecret || undefined,
        channelId: String(channelId),
        channelUsername: channelUsername || '',
        channelInviteLink: channelInviteLink || '',
        active: true,
        activatedAt: new Date(),
        activatedBy: req.user._id,
        reason: reason || '',
      }], { session });
      created = doc;
    });

    invalidateConfigCache();

    // Point Telegram at us. Failure here is reported but does NOT unwind the
    // config: the row is correct and an operator can retry the webhook, whereas
    // rolling back would leave the platform on a bot that may already be dead.
    let webhook = { ok: false, error: 'not_attempted' };
    const base = String(webhookBaseUrl || process.env.PUBLIC_APP_ORIGIN || '').replace(/\/+$/, '');
    if (base) {
      webhook = await setWebhook({
        token: botToken,
        url: `${base}/api/telegram/webhook`,
        secret: webhookSecret,
      });
    }

    res.json({
      success: true,
      generation: created.generation,
      botUsername: created.botUsername,
      webhook: webhook.ok ? 'registered' : `not registered: ${webhook.error}`,
      message: `Generation ${created.generation} is now active. Existing users keep their accounts.`,
    });
  } catch (err) {
    console.error('[admin/telegram] activation failed:', err.message);
    res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.endSession();
  }
});

/**
 * POST /api/admin/telegram/channel — swap the channel, keep everything else.
 *
 * The combined form above replaces the bot AND the channel together, because
 * originally they were one document. In an incident they are almost never the
 * same event: a channel is lost or deleted while the bot is fine, and forcing
 * the operator to re-paste a working bot token to fix an unrelated channel is
 * both an extra way to fail and an extra reason to hesitate.
 *
 * So this endpoint takes a channel and nothing else. It creates a new
 * generation carrying the current bot arrangement forward.
 *
 * ── What the generation bump does to players ────────────────────────────────
 * Every cached "this user is a member" records the generation it was observed
 * in. Bumping it makes all of them stale BY CONSTRUCTION — nothing has to be
 * invalidated by hand and nothing has to be migrated. The next protected
 * request each player makes returns 403 CHANNEL_MEMBERSHIP_REQUIRED carrying
 * the NEW invite link, which the user panel raises as a mandatory join prompt.
 *
 * Accounts, balances, KYC state, referral position and joining numbers are all
 * untouched: none of them is keyed on the channel. A player joins the new
 * channel and continues exactly where they were.
 */
router.post('/telegram/channel', authenticate, isAdmin, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { channelId, channelUsername, channelInviteLink, reason } = req.body || {};
    if (!channelId) {
      return res.status(400).json({ success: false, message: 'channelId is required' });
    }

    // A generation with no reachable bot would take signup and login down the
    // moment it activated. `botTokenEncrypted` is no longer `required` on the
    // schema — the registry may hold the credential instead — so the invariant
    // is checked HERE, where both sources are visible.
    const current = await TelegramConfig.findOne({ active: true })
      .select('+botTokenEncrypted +webhookSecret +recoveryBotTokenEncrypted +recoveryWebhookSecret')
      .lean();
    const registrySignin = await liveBot('signin');

    if (!current && !registrySignin) {
      return res.status(400).json({
        success: false,
        message: 'Register and promote a sign-in bot first — a channel with no bot leaves nobody able to sign in.',
      });
    }

    let created;
    await session.withTransaction(async () => {
      const latest = await TelegramConfig.findOne({}).sort({ generation: -1 }).select('generation').session(session).lean();
      const generation = (latest?.generation || 0) + 1;

      await TelegramConfig.updateMany({ active: true }, { $set: { active: false } }, { session });

      // Bot credentials are carried forward ONLY when they are not already in
      // the registry. Copying a token the registry owns would create a second
      // copy of a secret that a later promotion would silently leave stale.
      const carryBot = registrySignin ? {} : {
        botTokenEncrypted: current.botTokenEncrypted,
        botUsername: current.botUsername,
        webhookSecret: current.webhookSecret,
      };
      const carryRecovery = (await liveBot('recovery')) ? {} : {
        recoveryBotTokenEncrypted: current?.recoveryBotTokenEncrypted,
        recoveryBotUsername: current?.recoveryBotUsername,
        recoveryWebhookSecret: current?.recoveryWebhookSecret,
      };

      const [doc] = await TelegramConfig.create([{
        generation,
        ...carryBot,
        ...carryRecovery,
        channelId: String(channelId),
        channelUsername: channelUsername || '',
        channelInviteLink: channelInviteLink || '',
        active: true,
        activatedAt: new Date(),
        activatedBy: req.user._id,
        reason: reason || 'channel replaced',
      }], { session });
      created = doc;
    });

    invalidateConfigCache();

    console.warn(`[admin/telegram] CHANNEL FLIP to generation ${created.generation} `
      + `(${channelUsername || channelId}) by admin ${req.user._id}`);

    return res.json({
      success: true,
      generation: created.generation,
      channelId: created.channelId,
      channelUsername: created.channelUsername,
      message: `Generation ${created.generation} is live. Every player will be asked to join the new channel `
        + 'on their next action. Accounts, balances, KYC and referral positions are unchanged.',
    });
  } catch (err) {
    console.error('[admin/telegram] channel flip failed:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    await session.endSession();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// BOT FLEET — spares registered before the incident, promoted during it
// ═══════════════════════════════════════════════════════════════════════════

/** GET /api/admin/telegram/bots — every bot, no secrets. */
router.get('/telegram/bots', authenticate, isAdmin, async (req, res) => {
  try {
    res.json({ success: true, bots: await listBots() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

/** POST /api/admin/telegram/bots — register a bot, verified against Telegram. */
router.post('/telegram/bots', authenticate, isAdmin, async (req, res) => {
  try {
    const { label, role, token, notes } = req.body || {};
    const bot = await registerBot({ label, role, token, notes, actorId: req.user._id });
    console.warn(`[admin/telegram] bot @${bot.username} registered as ${bot.role} by admin ${req.user._id}`);
    res.json({ success: true, bot, message: `@${bot.username} is registered and on standby.` });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/admin/telegram/bots/:id/promote — make it the live bot for its role.
 *
 * The one-click flip. For sign-in and recovery this stands the incumbent down
 * in the same transaction, so there is never a window with two live bots or
 * none. Players are not affected: an identity is keyed on the person's Telegram
 * user id, not on whichever of our bots they happen to be messaging.
 */
router.post('/telegram/bots/:id/promote', authenticate, isAdmin, async (req, res) => {
  try {
    const result = await promote({
      id: req.params.id,
      actorId: req.user._id,
      webhookBaseUrl: req.body?.webhookBaseUrl,
    });
    console.warn(`[admin/telegram] PROMOTE @${result.bot.username} (${result.bot.role}) by admin ${req.user._id}`
      + `${result.displaced ? `, displacing @${result.displaced.username}` : ''} — webhook ${result.webhook}`);
    res.json({
      success: true,
      ...result,
      message: result.alreadyLive
        ? `@${result.bot.username} was already live.`
        : `@${result.bot.username} is now the live ${result.bot.role} bot. Existing accounts are unaffected.`,
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

/** POST /api/admin/telegram/bots/:id/webhook — retry a registration that failed. */
router.post('/telegram/bots/:id/webhook', authenticate, isAdmin, async (req, res) => {
  try {
    const bot = await retryWebhook({ id: req.params.id, webhookBaseUrl: req.body?.webhookBaseUrl });
    res.json({ success: true, bot, message: `Telegram is now delivering to @${bot.username}.` });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

/** POST /api/admin/telegram/bots/:id/retire — stand a bot down for good. */
router.post('/telegram/bots/:id/retire', authenticate, isAdmin, async (req, res) => {
  try {
    const bot = await retire({ id: req.params.id, actorId: req.user._id });
    console.warn(`[admin/telegram] RETIRE @${bot.username} (${bot.role}) by admin ${req.user._id}`);
    res.json({ success: true, bot, message: `@${bot.username} is retired.` });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGE TEMPLATES — the bot's words
// ═══════════════════════════════════════════════════════════════════════════

router.get('/telegram/templates', authenticate, isAdmin, async (req, res) => {
  try {
    res.json({ success: true, templates: await listTemplates() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

/**
 * PUT /api/admin/telegram/templates/:key — change what the bot says.
 *
 * The body is checked for markup Telegram will refuse before it is stored. An
 * empty body reverts the key to the shipped copy, which is also what the send
 * path falls back to if a template somehow still fails to parse — a typo here
 * must not be able to take signup offline.
 */
router.put('/telegram/templates/:key', authenticate, isAdmin, async (req, res) => {
  try {
    const saved = await saveTemplate({
      key: req.params.key,
      body: req.body?.body,
      actorId: req.user._id,
    });
    res.json({
      success: true,
      template: saved,
      message: saved.customised
        ? `The "${saved.key}" message is updated. It takes effect on the next message the bot sends.`
        : `The "${saved.key}" message is back to the default wording.`,
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// KYC BATCHES
// ═══════════════════════════════════════════════════════════════════════════

router.get('/kyc/bulk/stats', authenticate, isAdmin, async (req, res) => {
  try {
    res.json({ success: true, ...(await kycStats()) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/admin/kyc/bulk/export — download pending rows for verification.
 *
 * Streamed as an attachment and never persisted server-side. Every call writes
 * an audit row naming the admin.
 */
router.get('/kyc/bulk/export', authenticate, isAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 10_000, 50_000);
    const { batchId, csv, rowCount } = await buildExport({ actorId: req.user._id, limit });

    if (!rowCount) {
      return res.status(404).json({ success: false, message: 'There are no pending verifications to export.' });
    }

    console.warn(`[kyc] EXPORT ${batchId}: ${rowCount} Aadhaar row(s) released to admin ${req.user._id}`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${batchId}.csv"`);
    // Identity data must never sit in a shared cache.
    res.setHeader('Cache-Control', 'no-store, private');
    return res.send(csv);
  } catch (err) {
    console.error('[admin/kyc] export failed:', err.message);
    return res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

/** POST /api/admin/kyc/bulk/import — apply a completed verification file. */
router.post('/kyc/bulk/import', authenticate, isAdmin, async (req, res) => {
  try {
    const csv = typeof req.body === 'string' ? req.body : req.body?.csv;
    const result = await applyImport({ csv, actorId: req.user._id });
    console.warn(`[kyc] IMPORT ${result.batchId} by admin ${req.user._id}: `
      + `${result.verified} verified, ${result.failed} failed, ${result.skipped} skipped`);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[admin/kyc] import failed:', err.message);
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// REFERRAL PROGRAMME
// ═══════════════════════════════════════════════════════════════════════════

router.get('/referral/stats', authenticate, isAdmin, async (req, res) => {
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
    res.status(500).json({ success: false, message: err.message });
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
router.post('/referral/disburse', authenticate, isAdmin, async (req, res) => {
  try {
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ success: false, message: 'A positive amount is required' });
    }

    const result = await disburse({
      poolPaise: rupeesToPaise(amount),
      actorId: req.user._id,
    });

    console.warn(`[referral] DISBURSAL ${result.batchId} by admin ${req.user._id}: `
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
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

export default router;
