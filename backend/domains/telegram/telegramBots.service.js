// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/telegram/telegramBots.service.js — operating a fleet of bots.
 *
 * Telegram suspends gambling bots. The question is never "will the bot be
 * banned" but "how long are we down when it is", and the honest answer for a
 * single hardcoded bot is: as long as it takes to create a new one, name it,
 * verify it, paste its token, and register its webhook — with signup and login
 * dead throughout.
 *
 * This module exists to move all of that to BEFORE the incident. Spares are
 * registered and verified while everything is calm, and sit as STANDBY. The
 * incident response is then `promote(id)`: two database writes and one webhook
 * call.
 *
 * ── What a promotion does NOT do ────────────────────────────────────────────
 * It does not touch identities, phone numbers, KYC rows, balances, the channel,
 * or the config generation. A Telegram identity is keyed on the PERSON's
 * Telegram user id, which belongs to Telegram; whichever of our bots they
 * happen to be talking to is not part of who they are. So a player mid-signup
 * finishes with the new bot, and a player who never noticed keeps their account.
 *
 * The one thing that does change is which @username the site tells people to
 * message — read live from `public-config`, never baked into a build.
 */
import crypto from 'crypto';
import mongoose from 'mongoose';
import { TelegramBot, SINGULAR_BOT_ROLES } from './telegram.model.js';
import { encryptField, decryptField } from '../identity/fieldCrypto.util.js';
import { verifyBotToken, setWebhook, deleteWebhook, invalidateConfigCache } from './telegramClient.js';

/**
 * Where each role's updates arrive.
 *
 * Only the two INBOUND roles have an entry. Broadcast, moderation and generic
 * bots are outbound-only: they are held so they can be promoted or sent from,
 * and registering a webhook for a conversation that has no handler would point
 * Telegram at an endpoint that can only drop what it receives.
 */
const WEBHOOK_PATH = {
  signin:   '/api/telegram/webhook',
  recovery: '/api/telegram/recovery/webhook',
};

export function webhookPathForRole(role) {
  return WEBHOOK_PATH[role] || null;
}

/** Strip the fields no panel may ever see. */
function publicView(doc) {
  return {
    id: String(doc._id),
    label: doc.label,
    role: doc.role,
    botId: doc.botId,
    username: doc.username,
    status: doc.status,
    live: doc.status === 'ACTIVE',
    webhookUrl: doc.webhookUrl || '',
    webhookRegisteredAt: doc.webhookRegisteredAt || null,
    lastError: doc.lastError || '',
    addedAt: doc.addedAt,
    activatedAt: doc.activatedAt || null,
    retiredAt: doc.retiredAt || null,
    notes: doc.notes || '',
  };
}

/**
 * Register a bot the platform owns.
 *
 * The token is proved against Telegram BEFORE anything is stored, and the
 * @username is taken from Telegram's answer rather than from what the operator
 * typed. A standby bot exists to be trusted in an emergency; one that was never
 * verified is worse than no standby at all, because it will be promoted under
 * pressure and fail then.
 */
export async function registerBot({ label, role, token, notes = '', actorId }) {
  if (!label || !role || !token) {
    throw Object.assign(new Error('label, role and token are required'), { status: 400 });
  }

  const probe = await verifyBotToken(token);
  if (!probe.ok) {
    throw Object.assign(new Error(`Telegram rejected that bot token: ${probe.error}`), { status: 400 });
  }

  // The unique index on botId is the real guarantee; this read only makes the
  // message useful. Registering the same bot twice would leave two rows that
  // could each claim to be live.
  const existing = await TelegramBot.findOne({ botId: String(probe.id) }).lean();
  if (existing) {
    throw Object.assign(
      new Error(`@${probe.username} is already registered as "${existing.label}" (${existing.status}).`),
      { status: 409 },
    );
  }

  const doc = new TelegramBot({
    label: String(label).trim(),
    role,
    botId: String(probe.id),
    username: probe.username || '',
    tokenEncrypted: encryptField(token),
    // Minted now rather than at promotion: the secret is what authenticates
    // inbound updates, and generating it under incident pressure is one more
    // thing to get wrong.
    webhookSecret: crypto.randomBytes(32).toString('hex'),
    status: 'STANDBY',
    notes: String(notes || '').slice(0, 500),
    addedBy: actorId,
  });
  await doc.save();
  return publicView(doc);
}

/**
 * Make a standby bot the live one for its role.
 *
 * ── Ordering, and which failure we choose ───────────────────────────────────
 * Two writes must both land: the database's idea of the live bot, and
 * Telegram's idea of where to deliver. They cannot be made atomic across two
 * systems, so one of them goes first and the other can fail.
 *
 *   Webhook first — Telegram delivers to us as the new bot while the database
 *   still says the old one is live, so every update is authenticated against
 *   the wrong secret and rejected 401. The panel shows the old bot as live.
 *   Nothing in the system reveals what is wrong.
 *
 *   Database first — the new bot is live and correct, but Telegram has not been
 *   told, so no updates arrive at all. Loud, obvious, and fixed by retrying the
 *   webhook against a row that is already right.
 *
 * The second is chosen: the recoverable failure, with the failure recorded on
 * the row and a retry that needs no operator input beyond a click. This matches
 * the posture the config activation path already takes.
 */
export async function promote({ id, actorId, webhookBaseUrl }) {
  const target = await TelegramBot.findById(id).select('+tokenEncrypted +webhookSecret');
  if (!target) throw Object.assign(new Error('No such bot'), { status: 404 });
  if (target.status === 'ACTIVE') {
    return { alreadyLive: true, bot: publicView(target), webhook: 'unchanged' };
  }
  if (target.status === 'RETIRED') {
    throw Object.assign(new Error('A retired bot cannot be promoted. Register it again if it is genuinely back.'), { status: 400 });
  }

  const singular = SINGULAR_BOT_ROLES.has(target.role);
  let displaced = null;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (singular) {
        // Stand the incumbent down IN THE SAME transaction. The sparse unique
        // index on liveSlot refuses two live bots in one singular role, so
        // doing this in two steps would either fail outright or leave a window
        // with no sign-in bot at all.
        //
        // `.save()` rather than `updateOne`: liveSlot is maintained by the
        // schema's pre-validate hook, and Mongoose does not run hooks for
        // update operations. An updateOne here would clear `status` and leave a
        // stale `liveSlot` behind, which is precisely the invariant this index
        // exists to hold.
        // `+tokenEncrypted` because the displaced bot's webhook is cleared after
        // the transaction commits, and that needs its token. Selecting it later
        // would be a second read of a row we already have in hand.
        const current = await TelegramBot.findOne({ liveSlot: target.role })
          .select('+tokenEncrypted')
          .session(session);
        if (current && String(current._id) !== String(target._id)) {
          current.status = 'STANDBY';
          current.activatedAt = undefined;
          await current.save({ session });
          displaced = current;
        }
      }

      target.status = 'ACTIVE';
      target.activatedAt = new Date();
      target.activatedBy = actorId;
      target.lastError = '';
      await target.save({ session });
    });
  } finally {
    await session.endSession();
  }

  // The client caches the resolved bot for 30s; a promotion must be visible
  // immediately or the first minute after a flip still uses the dead token.
  invalidateConfigCache();

  const result = {
    bot: publicView(target),
    displaced: displaced ? publicView(displaced) : null,
    webhook: 'not_required',
  };

  const path = webhookPathForRole(target.role);
  if (!path) return result;

  const base = String(webhookBaseUrl || process.env.PUBLIC_APP_ORIGIN || '').replace(/\/+$/, '');
  if (!base) {
    result.webhook = 'not registered: no webhook base URL configured';
    target.lastError = result.webhook;
    await target.save();
    return result;
  }

  const outcome = await registerWebhookFor(target, `${base}${path}`);
  result.webhook = outcome.ok ? 'registered' : `not registered: ${outcome.error}`;

  // Point the displaced bot at nothing, so a bot that is merely suspected of
  // being compromised stops receiving anything the moment it is stood down.
  // Best effort by design: a banned bot will refuse this call, and a promotion
  // must not fail because the thing it is replacing is already dead.
  if (displaced) {
    try {
      const token = decryptField(displaced.get('tokenEncrypted'));
      const cleared = await deleteWebhook(token);
      if (!cleared.ok) console.warn(`[telegram] could not clear webhook on displaced @${displaced.username}: ${cleared.error}`);
    } catch (err) {
      console.warn(`[telegram] could not clear webhook on displaced @${displaced.username}: ${err.message}`);
    }
  }

  return result;
}

/**
 * (Re)register a bot's webhook. Separated so a failed promotion is fixed by a
 * retry rather than by promoting something else.
 */
export async function registerWebhookFor(doc, url) {
  const token = decryptField(doc.get('tokenEncrypted'));
  const res = await setWebhook({ token, url, secret: doc.get('webhookSecret') });

  if (res.ok) {
    doc.webhookUrl = url;
    doc.webhookRegisteredAt = new Date();
    doc.lastError = '';
  } else {
    doc.lastError = String(res.error || 'unknown error').slice(0, 500);
  }
  await doc.save();
  return res;
}

export async function retryWebhook({ id, webhookBaseUrl }) {
  const doc = await TelegramBot.findById(id).select('+tokenEncrypted +webhookSecret');
  if (!doc) throw Object.assign(new Error('No such bot'), { status: 404 });

  const path = webhookPathForRole(doc.role);
  if (!path) {
    throw Object.assign(new Error(`A ${doc.role} bot receives no updates, so it has no webhook to register.`), { status: 400 });
  }
  const base = String(webhookBaseUrl || process.env.PUBLIC_APP_ORIGIN || '').replace(/\/+$/, '');
  if (!base) throw Object.assign(new Error('No webhook base URL configured'), { status: 400 });

  const res = await registerWebhookFor(doc, `${base}${path}`);
  if (!res.ok) throw Object.assign(new Error(`Telegram refused: ${res.error}`), { status: 502 });
  return publicView(doc);
}

/**
 * Retire a bot.
 *
 * The row survives, so an incident review can still answer what was running
 * when. Retiring the LIVE sign-in bot is refused: it would leave the platform
 * with no way for anyone to sign in, and the operation the admin actually wants
 * in that moment is to promote the replacement — which stands this one down as
 * part of the same transaction.
 */
export async function retire({ id, actorId }) {
  const doc = await TelegramBot.findById(id).select('+tokenEncrypted');
  if (!doc) throw Object.assign(new Error('No such bot'), { status: 404 });

  if (doc.status === 'ACTIVE' && doc.role === 'signin') {
    throw Object.assign(
      new Error('This is the live sign-in bot. Promote its replacement instead — that stands this one down in the same step, with no window where nobody can sign in.'),
      { status: 409 },
    );
  }

  const wasLive = doc.status === 'ACTIVE';
  doc.status = 'RETIRED';
  doc.retiredAt = new Date();
  doc.retiredBy = actorId;
  await doc.save();
  invalidateConfigCache();

  if (wasLive && webhookPathForRole(doc.role)) {
    try {
      await deleteWebhook(decryptField(doc.get('tokenEncrypted')));
    } catch { /* a dead bot cannot be told anything; the row is what matters */ }
  }

  return publicView(doc);
}

/**
 * The live bot for a role, with its token decrypted.
 *
 * Lives in telegramClient.js — resolving credentials is what that module is
 * for, and putting it here instead would make the client import this service
 * while this service imports the client. Re-exported so callers that think in
 * terms of the fleet have one place to look.
 */
export { liveBot } from './telegramClient.js';

/** Every bot, newest first, with no secrets. */
export async function listBots() {
  const docs = await TelegramBot.find({}).sort({ status: 1, addedAt: -1 }).lean();
  return docs.map(publicView);
}
