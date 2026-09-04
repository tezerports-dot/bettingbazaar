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
import { db } from '#db';
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

/**
 * Strip the fields no panel may ever see.
 *
 * The bot objects the repository returns already omit the token and the webhook
 * secret — its projection does not select them — so this is a shaping step
 * rather than the security boundary. That boundary is `getBotSecrets`, which a
 * caller has to ASK for, and which nothing on this path passes to a response.
 */
function publicView(bot) {
  return {
    id: bot.botId,
    label: bot.label,
    role: bot.role,
    botId: bot.botId,
    username: bot.username,
    status: bot.status,
    live: bot.status === 'ACTIVE',
    webhookUrl: bot.webhookUrl || '',
    webhookRegisteredAt: bot.webhookRegisteredAt || null,
    lastError: bot.lastError || '',
    addedAt: bot.addedAt,
    activatedAt: bot.activatedAt || null,
    retiredAt: bot.retiredAt || null,
    notes: bot.notes || '',
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

  // `bot_id` is the PRIMARY KEY, which is the real guarantee; this read only
  // makes the message useful. Registering the same bot twice would leave two
  // rows that could each claim to be live.
  const existing = await db.telegram.getBot(String(probe.id));
  if (existing) {
    throw Object.assign(
      new Error(`@${probe.username} is already registered as "${existing.label}" (${existing.status}).`),
      { status: 409 },
    );
  }

  const bot = await db.telegram.addBot({
    botId: String(probe.id),
    label: String(label).trim(),
    role,
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
  return publicView(bot);
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
  const probe = await db.telegram.getBot(id);
  if (!probe) throw Object.assign(new Error('No such bot'), { status: 404 });
  if (probe.status === 'ACTIVE') {
    return { alreadyLive: true, bot: publicView(probe), webhook: 'unchanged' };
  }
  if (probe.status === 'RETIRED') {
    throw Object.assign(
      new Error('A retired bot cannot be promoted. Register it again if it is genuinely back.'),
      { status: 400 },
    );
  }

  // ── ONE STATEMENT PAIR, ONE TRANSACTION ──────────────────────────────────
  // The stand-down and the promotion commit together. The partial unique index
  // refuses two live bots in a singular role, so splitting them either fails
  // outright or leaves a window with NO live bot — every inbound update
  // rejected, nobody able to sign in.
  //
  // The version this replaced ran the pair through a document-store
  // transaction whose callback had to re-read both documents on EVERY attempt,
  // because a retried callback holding a document loaded outside it would issue
  // a second save that sent nothing — committing successfully having written
  // nothing, and reporting a promotion that did not happen. The whole hazard is
  // a property of documents that carry their own dirty state; two UPDATEs do
  // not have it.
  let promoted;
  try {
    promoted = await db.telegram.promoteBot({ botId: probe.botId, role: probe.role, actor: actorId });
  } catch (err) {
    throw Object.assign(new Error(`Could not promote @${probe.username}: ${err.message}`), { status: 409 });
  }

  const { bot: target, secrets, displaced } = promoted;

  // The client caches the resolved bot for 30s; a promotion must be visible
  // immediately or the first minute after a flip still uses the dead token.
  invalidateConfigCache();

  const result = {
    bot: publicView(target),
    displaced: displaced ? publicView(displaced.bot) : null,
    webhook: 'not_required',
  };

  const path = webhookPathForRole(target.role);
  if (!path) return result;

  const base = String(webhookBaseUrl || process.env.PUBLIC_APP_ORIGIN || '').replace(/\/+$/, '');
  if (!base) {
    result.webhook = 'not registered: no webhook base URL configured';
    // Recorded on the ROW, so the panel shows an operator what is wrong and
    // `retryWebhook` is one click. The row is already correct; only Telegram
    // has not been told.
    await db.telegram.recordBotError(target.botId, result.webhook);
    return result;
  }

  const outcome = await registerWebhook(target, secrets, `${base}${path}`);
  result.webhook = outcome.ok ? 'registered' : `not registered: ${outcome.error}`;

  // Point the displaced bot at nothing, so a bot that is merely suspected of
  // being compromised stops receiving anything the moment it is stood down.
  // Best effort by design: a banned bot will refuse this call, and a promotion
  // must not fail because the thing it is replacing is already dead.
  if (displaced) {
    try {
      const cleared = await deleteWebhook(decryptField(displaced.secrets.tokenEncrypted));
      if (!cleared.ok) {
        console.warn(`[telegram] could not clear webhook on displaced @${displaced.bot.username}: ${cleared.error}`);
      }
    } catch (err) {
      console.warn(`[telegram] could not clear webhook on displaced @${displaced.bot.username}: ${err.message}`);
    }
  }

  return result;
}

/**
 * (Re)register a bot's webhook. Separated so a failed promotion is fixed by a
 * retry rather than by promoting something else.
 */
export async function registerWebhook(bot, secrets, url) {
  const res = await setWebhook({
    token: decryptField(secrets.tokenEncrypted),
    url,
    secret: secrets.webhookSecret,
  });
  // The outcome is recorded either way, in ONE statement: a success stamps
  // where Telegram was told to deliver and when it accepted; a failure records
  // why, so the panel can show it and a retry needs no operator input beyond a
  // click.
  await db.telegram.recordWebhookRegistration(bot.botId, {
    url,
    error: res.ok ? null : String(res.error || 'unknown error'),
  });
  return res;
}

export async function retryWebhook({ id, webhookBaseUrl }) {
  const secrets = await db.telegram.getBotSecrets(id);
  if (!secrets) throw Object.assign(new Error('No such bot'), { status: 404 });

  const path = webhookPathForRole(secrets.role);
  if (!path) {
    throw Object.assign(
      new Error(`A ${secrets.role} bot receives no updates, so it has no webhook to register.`),
      { status: 400 },
    );
  }
  const base = String(webhookBaseUrl || process.env.PUBLIC_APP_ORIGIN || '').replace(/\/+$/, '');
  if (!base) throw Object.assign(new Error('No webhook base URL configured'), { status: 400 });

  const res = await registerWebhook({ botId: secrets.botId }, secrets, `${base}${path}`);
  if (!res.ok) throw Object.assign(new Error(`Telegram refused: ${res.error}`), { status: 502 });
  // Re-read, so the response carries what the row now says rather than what
  // this function believes it wrote.
  return publicView(await db.telegram.getBot(secrets.botId));
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
  const secrets = await db.telegram.getBotSecrets(id);
  if (!secrets) throw Object.assign(new Error('No such bot'), { status: 404 });

  // The refusal is IN the statement, guarded on the generated `live_slot`
  // column. The check this replaced read the status first and wrote after, so a
  // promotion landing in between could make this bot live and the retire would
  // still go through — leaving the platform with nobody answering the webhook.
  const retired = await db.telegram.retireBot(id, { actor: actorId });
  if (!retired.ok) {
    if (retired.reason === 'IS_LIVE') {
      throw Object.assign(
        new Error(
          'This is the live bot for its role. Promote its replacement instead — that stands '
          + 'this one down in the same step, with no window where nobody can sign in.',
        ),
        { status: 409 },
      );
    }
    if (retired.reason === 'ALREADY_RETIRED') return publicView(await db.telegram.getBot(id));
    throw Object.assign(new Error('No such bot'), { status: 404 });
  }

  invalidateConfigCache();

  if (webhookPathForRole(retired.bot.role)) {
    try {
      await deleteWebhook(decryptField(secrets.tokenEncrypted));
    } catch { /* a dead bot cannot be told anything; the row is what matters */ }
  }

  return publicView(retired.bot);
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

/** Every bot, with no secrets. */
export async function listBots() {
  return (await db.telegram.listBots({})).map(publicView);
}
