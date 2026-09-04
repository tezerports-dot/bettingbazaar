// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/telegramPg.js — the sign-in surface: configuration generations, the
 * bot registry, message templates, identities, half-finished onboardings and
 * one-time login tokens.
 *
 * ── Expiry is enforced by the READS, not by a sweep ──────────────────────────
 * The document model used TTL indexes, which delete expired rows on their own
 * schedule. PostgreSQL has no such thing, so every read of an expiring row
 * filters on `expires_at` and `sweepExpired()` only reclaims space.
 *
 * That ordering is not a detail. If a read trusted the sweep to have run, then
 * a login token — a bearer credential — would stay usable for as long as the
 * sweep was late, and an abandoned onboarding would keep an Aadhaar hash
 * reachable past its retention window. The sweep may fail, lag, or never be
 * scheduled; the reads still have to be right.
 *
 * ── Secrets ─────────────────────────────────────────────────────────────────
 * Bot tokens and webhook secrets are ciphertext at rest and are never returned
 * by the ordinary read. Whoever holds a token can read every message sent to
 * the bot and speak as the platform, so reaching one takes calling the function
 * named for it.
 */
import { pgQuery, getPool, connectGuarded } from '../client.js';

const toInt = (v) => (v == null ? null : Number(v));

// ── Configuration generations ────────────────────────────────────────────────

const CONFIG_PUBLIC = `
  generation, bot_username, recovery_bot_username,
  channel_id, channel_username, channel_invite_link,
  active, activated_at, activated_by, reason, created_at`;

function toConfig(row) {
  if (!row) return null;
  return {
    generation: toInt(row.generation),
    botUsername: row.bot_username,
    recoveryBotUsername: row.recovery_bot_username,
    channelId: row.channel_id,
    channelUsername: row.channel_username,
    channelInviteLink: row.channel_invite_link,
    active: row.active,
    activatedAt: row.activated_at,
    activatedBy: row.activated_by,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

/** The live generation, or null when the platform has never been configured. */
export async function getActiveConfig() {
  const { rows } = await pgQuery(
    `SELECT ${CONFIG_PUBLIC} FROM telegram_configs WHERE active LIMIT 1`, [], 'tg_config_active',
  );
  return toConfig(rows[0]);
}

/**
 * Recent generations, newest first. The record of every channel and bot swap.
 *
 * Public columns only — `CONFIG_PUBLIC` names them, and no token is among them.
 * This is what an admin panel renders, and a config history that could leak a
 * bot token would be a read path for a credential the platform deliberately
 * has none of.
 */
export async function listConfigHistory({ limit = 10 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 10, 1), 100);
  const { rows } = await pgQuery(
    `SELECT ${CONFIG_PUBLIC} FROM telegram_configs
      ORDER BY generation DESC LIMIT ${capped}`, [], 'tg_config_history',
  );
  return rows.map(toConfig);
}

/**
 * The live generation's SECRETS. Separate function, deliberately: no route that
 * renders a config calls this one.
 */
export async function getActiveConfigSecrets() {
  const { rows } = await pgQuery(
    `SELECT generation, bot_token_encrypted, webhook_secret,
            recovery_bot_token_encrypted, recovery_webhook_secret
       FROM telegram_configs WHERE active LIMIT 1`, [], 'tg_config_secrets',
  );
  const r = rows[0];
  return r ? {
    generation: toInt(r.generation),
    botTokenEncrypted: r.bot_token_encrypted,
    webhookSecret: r.webhook_secret,
    recoveryBotTokenEncrypted: r.recovery_bot_token_encrypted,
    recoveryWebhookSecret: r.recovery_webhook_secret,
  } : null;
}

/**
 * The live generation, public fields AND secrets, in ONE statement.
 *
 * The send path needs both halves: the channel to check membership against and
 * the token to check it with. Reading them as two queries would let an admin's
 * channel swap land between them, composing a config whose channel belongs to
 * one generation and whose credentials belong to another — and the generation
 * number, which is what makes every cached membership answer stale, would be
 * whichever of the two the caller happened to keep.
 *
 * Kept SEPARATE from `getActiveConfig` rather than merged into it, for the same
 * reason `getActiveConfigSecrets` is: a route that renders a config to a panel
 * calls the one that cannot return a token.
 */
export async function getActiveConfigWithSecrets() {
  const { rows } = await pgQuery(
    `SELECT ${CONFIG_PUBLIC},
            bot_token_encrypted, webhook_secret,
            recovery_bot_token_encrypted, recovery_webhook_secret
       FROM telegram_configs WHERE active LIMIT 1`, [], 'tg_config_active_secrets',
  );
  const r = rows[0];
  if (!r) return null;
  return {
    ...toConfig(r),
    botTokenEncrypted: r.bot_token_encrypted,
    webhookSecret: r.webhook_secret,
    recoveryBotTokenEncrypted: r.recovery_bot_token_encrypted,
    recoveryWebhookSecret: r.recovery_webhook_secret,
  };
}

/**
 * Activate a new generation.
 *
 * Deactivating the old one and activating the new one happen in ONE
 * transaction, because the partial unique index refuses two active rows — so a
 * half-applied swap cannot leave the platform with none, which is an install
 * where nobody can sign up.
 *
 * The generation number is `MAX + 1` taken inside the transaction, never a
 * count: two admins swapping at once must not compute the same next number.
 */
export async function activateConfig({
  channelId, channelUsername = '', channelInviteLink = '',
  botTokenEncrypted = null, botUsername = '', webhookSecret = null,
  recoveryBotTokenEncrypted = null, recoveryBotUsername = '', recoveryWebhookSecret = null,
  activatedBy = null, reason = '',
}) {
  if (!channelId) throw new Error('activateConfig requires a channelId');
  return withTelegramTransaction(async (client) => {
    await client.query('UPDATE telegram_configs SET active = FALSE WHERE active');
    const { rows } = await client.query(
      `INSERT INTO telegram_configs (
         generation, bot_token_encrypted, bot_username, webhook_secret,
         recovery_bot_token_encrypted, recovery_bot_username, recovery_webhook_secret,
         channel_id, channel_username, channel_invite_link,
         active, activated_at, activated_by, reason)
       VALUES ((SELECT COALESCE(MAX(generation), 0) + 1 FROM telegram_configs),
               $1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, now(), $10, $11)
       RETURNING ${CONFIG_PUBLIC}`,
      [botTokenEncrypted, botUsername, webhookSecret,
       recoveryBotTokenEncrypted, recoveryBotUsername, recoveryWebhookSecret,
       String(channelId), channelUsername, channelInviteLink,
       activatedBy ? String(activatedBy) : null, reason],
    );
    return toConfig(rows[0]);
  });
}

// ── The bot registry ─────────────────────────────────────────────────────────

const BOT_PUBLIC = `
  bot_id, label, role, username, status, live_slot, webhook_url,
  webhook_registered_at, last_error, added_by, added_at,
  activated_at, activated_by, retired_at, retired_by, notes`;

function toBot(row) {
  if (!row) return null;
  return {
    botId: row.bot_id, label: row.label, role: row.role, username: row.username,
    status: row.status, liveSlot: row.live_slot, webhookUrl: row.webhook_url,
    webhookRegisteredAt: row.webhook_registered_at, lastError: row.last_error,
    addedBy: row.added_by, addedAt: row.added_at,
    activatedAt: row.activated_at, activatedBy: row.activated_by,
    retiredAt: row.retired_at, retiredBy: row.retired_by, notes: row.notes,
  };
}

/** Every registered bot, live and reserve. Secrets excluded. */
export async function listBots({ role = null, status = null } = {}) {
  const where = [];
  const params = [];
  if (role) { params.push(role); where.push(`role = $${params.length}`); }
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  const { rows } = await pgQuery(
    `SELECT ${BOT_PUBLIC} FROM telegram_bots
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY role, status, added_at DESC`, params, 'tg_bot_list',
  );
  return rows.map(toBot);
}

/** The live bot for a singular role, or null. Reads the generated column. */
export async function getLiveBot(role) {
  const { rows } = await pgQuery(
    `SELECT ${BOT_PUBLIC} FROM telegram_bots WHERE live_slot = $1`, [role], 'tg_bot_live',
  );
  return toBot(rows[0]);
}

/** The live bot's credentials, for the send and webhook-verify paths only. */
export async function getLiveBotSecrets(role) {
  const { rows } = await pgQuery(
    `SELECT bot_id, username, token_encrypted, webhook_secret
       FROM telegram_bots WHERE live_slot = $1`, [role], 'tg_bot_live_secrets',
  );
  const r = rows[0];
  return r ? {
    botId: r.bot_id, username: r.username,
    tokenEncrypted: r.token_encrypted, webhookSecret: r.webhook_secret,
  } : null;
}

/** Register a bot. Parked as STANDBY unless told otherwise — that is the point. */
export async function addBot({
  botId, label, role, username, tokenEncrypted, webhookSecret,
  status = 'STANDBY', addedBy = null, notes = '',
}) {
  const { rows } = await pgQuery(
    `INSERT INTO telegram_bots (bot_id, label, role, username, token_encrypted,
                                webhook_secret, status, added_by, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING ${BOT_PUBLIC}`,
    [String(botId), label, role, username, tokenEncrypted, webhookSecret,
     status, addedBy ? String(addedBy) : null, notes],
    'tg_bot_add',
  );
  return toBot(rows[0]);
}

/**
 * Promote a standby bot to live, standing down whichever bot holds the slot.
 *
 * Both moves in ONE transaction, and in this order, because the partial unique
 * index refuses two live bots in a singular role. Doing it in two statements
 * outside a transaction leaves a window with no live bot — every inbound
 * webhook rejected, nobody able to sign in.
 *
 * ── STANDBY, not RETIRED ───────────────────────────────────────────────────
 * The incumbent is stood down, not retired. RETIRED is a one-way door here —
 * `promote` refuses a retired bot outright — so retiring the incumbent made
 * every promotion irreversible: an operator who promoted the wrong bot could
 * not switch back, and the working bot they had just displaced was gone for
 * good. Standing it down leaves it promotable, which is what a rollback needs.
 *
 * Note what is NOT here: any application-side maintenance of `live_slot`. It is
 * generated from `status` and `role` by the database, so a promotion cannot
 * forget to recompute it. The model this replaces derived it in a hook that
 * update operators bypassed entirely.
 *
 * Returns the promoted bot AND the bot it displaced, because the caller has to
 * revoke the old webhook once the transaction has committed.
 */
export async function promoteBot({ botId, role, actor = null }) {
  return withTelegramTransaction(async (client) => {
    const { rows: stoodDown } = await client.query(
      `UPDATE telegram_bots
          SET status = 'STANDBY', activated_at = NULL, activated_by = NULL
        WHERE live_slot = $1 AND bot_id <> $2
        RETURNING ${BOT_PUBLIC}, token_encrypted, webhook_secret`,
      [role, String(botId)],
    );
    const { rows } = await client.query(
      `UPDATE telegram_bots
          SET status = 'ACTIVE', activated_at = now(), activated_by = $2, last_error = ''
        WHERE bot_id = $1 AND role = $3 AND status <> 'RETIRED'
        RETURNING ${BOT_PUBLIC}, token_encrypted, webhook_secret`,
      [String(botId), actor ? String(actor) : null, role],
    );
    if (!rows[0]) {
      // Either no such bot in that role, or it is retired. Both are refusals
      // the caller turns into a 4xx, and neither may leave the slot empty —
      // which is why the stand-down and the promotion share a transaction.
      throw new Error(`promoteBot: no promotable bot ${botId} in role ${role}`);
    }
    return {
      bot: toBot(rows[0]),
      secrets: {
        tokenEncrypted: rows[0].token_encrypted,
        webhookSecret: rows[0].webhook_secret,
      },
      displaced: stoodDown[0]
        ? {
            bot: toBot(stoodDown[0]),
            secrets: {
              tokenEncrypted: stoodDown[0].token_encrypted,
              webhookSecret: stoodDown[0].webhook_secret,
            },
          }
        : null,
    };
  });
}

/** One bot by id, or null. No secrets — see `getBotSecrets` for those. */
export async function getBot(botId) {
  const { rows } = await pgQuery(
    `SELECT ${BOT_PUBLIC} FROM telegram_bots WHERE bot_id = $1`,
    [String(botId)], 'tg_bot_get',
  );
  return toBot(rows[0]);
}

/**
 * One bot's credentials, for the webhook paths that need them.
 *
 * Separate from `getBot` on purpose: an ordinary read cannot leak a bot token
 * into a response body by accident, because the projection that produces a bot
 * object does not contain one.
 */
export async function getBotSecrets(botId) {
  const { rows } = await pgQuery(
    `SELECT bot_id, username, role, status, token_encrypted, webhook_secret
       FROM telegram_bots WHERE bot_id = $1`,
    [String(botId)], 'tg_bot_secrets',
  );
  const r = rows[0];
  return r ? {
    botId: r.bot_id, username: r.username, role: r.role, status: r.status,
    tokenEncrypted: r.token_encrypted, webhookSecret: r.webhook_secret,
  } : null;
}

/** Record where Telegram was told to deliver, and when it accepted. */
export async function recordWebhookRegistration(botId, { url, error = null }) {
  const { rows } = await pgQuery(
    `UPDATE telegram_bots SET
       webhook_url = CASE WHEN $3::text IS NULL THEN $2 ELSE webhook_url END,
       webhook_registered_at = CASE WHEN $3::text IS NULL THEN now() ELSE webhook_registered_at END,
       last_error = COALESCE($3, '')
      WHERE bot_id = $1
      RETURNING ${BOT_PUBLIC}`,
    [String(botId), String(url ?? ''), error ? String(error).slice(0, 500) : null],
    'tg_bot_webhook_recorded',
  );
  return toBot(rows[0]);
}

/**
 * Retire a bot, permanently.
 *
 * Refuses the LIVE bot of a singular role: retiring it leaves the platform with
 * nobody answering the webhook and no way for anyone to sign in. The operation
 * an operator actually wants in that moment is to promote the replacement,
 * which stands this one down inside the same transaction.
 *
 * The guard is `live_slot IS NULL` — the generated column — rather than a
 * status check the caller performs first, so a promotion landing between the
 * caller's read and this write cannot slip past it.
 */
export async function retireBot(botId, { actor = null } = {}) {
  const { rows } = await pgQuery(
    `UPDATE telegram_bots
        SET status = 'RETIRED', retired_at = now(), retired_by = $2
      WHERE bot_id = $1 AND live_slot IS NULL AND status <> 'RETIRED'
      RETURNING ${BOT_PUBLIC}`,
    [String(botId), actor ? String(actor) : null], 'tg_bot_retire',
  );
  if (rows[0]) return { ok: true, bot: toBot(rows[0]) };
  const current = await getBot(botId);
  if (!current) return { ok: false, reason: 'NOT_FOUND' };
  if (current.status === 'RETIRED') return { ok: false, reason: 'ALREADY_RETIRED' };
  return { ok: false, reason: 'IS_LIVE', role: current.role };
}

/** Record why a promotion or a send failed — the first thing an operator needs. */
export async function recordBotError(botId, message) {
  await pgQuery(
    `UPDATE telegram_bots SET last_error = $2 WHERE bot_id = $1`,
    [String(botId), String(message ?? '').slice(0, 500)], 'tg_bot_error',
  );
}

// ── Templates ────────────────────────────────────────────────────────────────

/**
 * Every stored template, as a map.
 *
 * A blank body is treated as ABSENT so the caller falls back to the shipped
 * default. An admin who clears the box means "use the default", never "send
 * nothing" — a player staring at silence after /start is the worst outcome this
 * table can produce.
 */
export async function getTemplates() {
  const { rows } = await pgQuery(
    `SELECT key, body FROM telegram_templates`, [], 'tg_template_all',
  );
  return Object.fromEntries(
    rows.filter((r) => String(r.body ?? '').trim() !== '').map((r) => [r.key, r.body]),
  );
}

/** Write a template. Upsert, because an admin edits by key, not by row id. */
/**
 * Every stored override with its metadata, keyed for a lookup.
 *
 * Distinct from `getTemplates()`, which answers only "what is the current body"
 * and drops blanks. The admin screen also has to show WHEN a key was last
 * edited, and it has to distinguish a key that was never customised from one
 * customised back to the default — so it needs the row, not the string.
 */
export async function listTemplateRows() {
  const { rows } = await pgQuery(
    `SELECT key, body, updated_at, updated_by FROM telegram_templates`,
    [], 'tg_template_rows',
  );
  return rows.map((r) => ({
    key: r.key, body: r.body, updatedAt: r.updated_at, updatedBy: r.updated_by,
  }));
}

/**
 * Remove an override, reverting the key to its shipped default.
 *
 * A DELETE rather than a blank body: the default lives in code, and storing an
 * empty string to mean "use the default" makes two representations of one
 * state — the read path would then have to treat blank as absent everywhere it
 * touches a template, which is exactly the bug that silences a bot.
 */
export async function deleteTemplate(key) {
  const { rowCount } = await pgQuery(
    `DELETE FROM telegram_templates WHERE key = $1`, [String(key)], 'tg_template_delete',
  );
  return { removed: rowCount > 0 };
}

export async function setTemplate({ key, body, updatedBy = null }) {
  const { rows } = await pgQuery(
    `INSERT INTO telegram_templates (key, body, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE
       SET body = EXCLUDED.body, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING key, body, updated_at, updated_by`,
    [String(key), String(body), updatedBy ? String(updatedBy) : null], 'tg_template_set',
  );
  return rows[0];
}

// ── Identities ───────────────────────────────────────────────────────────────

const IDENTITY_COLUMNS = `
  telegram_user_id, user_id, telegram_username, first_name, phone,
  contact_shared_at, contact_active, channel_status, channel_checked_at,
  channel_generation, linked_generation, created_at, last_seen_at`;

function toIdentity(row) {
  if (!row) return null;
  return {
    telegramUserId: row.telegram_user_id,
    userId: row.user_id,
    telegramUsername: row.telegram_username,
    firstName: row.first_name,
    phone: row.phone,
    contactSharedAt: row.contact_shared_at,
    contactActive: row.contact_active,
    channelStatus: row.channel_status,
    channelCheckedAt: row.channel_checked_at,
    channelGeneration: toInt(row.channel_generation),
    linkedGeneration: toInt(row.linked_generation),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export async function getIdentityByTelegramId(telegramUserId) {
  if (!telegramUserId) return null;
  const { rows } = await pgQuery(
    `SELECT ${IDENTITY_COLUMNS} FROM telegram_identities WHERE telegram_user_id = $1`,
    [String(telegramUserId)], 'tg_identity_get',
  );
  return toIdentity(rows[0]);
}

/**
 * The account's CURRENT Telegram identity.
 *
 * `contact_active` is not optional here. Since account recovery keeps the
 * displaced identity as history, an account can have several rows and only one
 * of them is live — an unfiltered read returns whichever the planner reaches
 * first, which after a recovery is usually the OLD one. Every caller of this is
 * asking "who do we message", and messaging the identity that just lost the
 * account is the failure recovery exists to prevent.
 *
 * `ORDER BY contact_active DESC` is the tiebreak for the one case a filter
 * cannot cover: an account whose identity was deactivated and never replaced.
 * Returning its last known identity beats returning nothing, because the caller
 * can then say "this account was linked and is not any more".
 */
export async function getIdentityByUserId(userId, { activeOnly = true } = {}) {
  if (!userId) return null;
  const { rows } = await pgQuery(
    `SELECT ${IDENTITY_COLUMNS} FROM telegram_identities
      WHERE user_id = $1 ${activeOnly ? 'AND contact_active' : ''}
      ORDER BY contact_active DESC, contact_shared_at DESC
      LIMIT 1`,
    [String(userId)], 'tg_identity_by_user',
  );
  return toIdentity(rows[0]);
}

/** Every identity an account has ever had, newest first — the takeover trail. */
export async function listIdentitiesForUser(userId) {
  const { rows } = await pgQuery(
    `SELECT ${IDENTITY_COLUMNS} FROM telegram_identities
      WHERE user_id = $1 ORDER BY contact_shared_at DESC`,
    [String(userId)], 'tg_identity_history',
  );
  return rows.map(toIdentity);
}

/** Link a Telegram account to a platform account. */
export async function createIdentity({
  telegramUserId, userId, phone, contactSharedAt = new Date(),
  telegramUsername = '', firstName = '', linkedGeneration = 0,
}) {
  const { rows } = await pgQuery(
    `INSERT INTO telegram_identities (
       telegram_user_id, user_id, telegram_username, first_name, phone,
       contact_shared_at, linked_generation, channel_generation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
     RETURNING ${IDENTITY_COLUMNS}`,
    [String(telegramUserId), String(userId), telegramUsername, firstName,
     String(phone), contactSharedAt, linkedGeneration],
    'tg_identity_create',
  );
  return toIdentity(rows[0]);
}

/**
 * Hand an account to a DIFFERENT Telegram identity — account recovery.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS IS THE SHAPE A SUCCESSFUL TAKEOVER HAS
 * ══════════════════════════════════════════════════════════════════════════
 * Everything about it is deliberate. The caller proves TWO factors before
 * reaching here — the phone resolves the account, and the Aadhaar hash is
 * checked AGAINST that account rather than used as a search key, because
 * looking an account up by Aadhaar would make the bot an enumeration oracle.
 *
 * The swap is one transaction because three unique constraints have to be
 * satisfied at once and none of them may be briefly violated:
 *
 *   • `user_id` is UNIQUE, so the old identity must release the account in the
 *     same statement sequence that gives it to the new one. Two steps leave a
 *     window in which the account has no identity, and a failure between them
 *     leaves it stranded there permanently.
 *   • `one_active_identity_per_phone` is partial on `contact_active`, so the
 *     old row must be deactivated before the new one can claim the number.
 *   • `telegram_user_id` is the PRIMARY KEY, so the same Telegram account
 *     asking twice re-points its own row rather than colliding with itself.
 *
 * Returns `{ ok: false, reason: 'TELEGRAM_ALREADY_LINKED' }` when the new
 * Telegram account already holds a DIFFERENT platform account. Handing it a
 * second one would create exactly the duplicate this design exists to prevent,
 * and it is a refusal rather than an error because the caller answers it with a
 * message rather than a stack trace.
 */
export async function relinkIdentity({
  telegramUserId, userId, phone, generation = 0,
  telegramUsername = '', firstName = '',
}) {
  return withTelegramTransaction(async (client) => {
    // Whoever the new Telegram account is currently linked to. Read INSIDE the
    // transaction: a check outside it is a decision made against a state that
    // can change before the write lands.
    const { rows: holder } = await client.query(
      'SELECT user_id FROM telegram_identities WHERE telegram_user_id = $1',
      [String(telegramUserId)],
    );
    if (holder[0] && String(holder[0].user_id) !== String(userId)) {
      return { ok: false, reason: 'TELEGRAM_ALREADY_LINKED' };
    }

    // The old identity steps aside FIRST — while it is active it holds both
    // the account's slot and the phone's. It keeps its real `user_id`: both
    // indexes are partial on `contact_active`, so an inactive row occupies
    // neither, and the record of who used to hold the account survives. That
    // record is the first thing a takeover review asks for.
    const { rows: retired } = await client.query(
      `UPDATE telegram_identities
          SET contact_active = FALSE, channel_status = 'left'
        WHERE user_id = $1 AND telegram_user_id <> $2 AND contact_active
        RETURNING telegram_user_id`,
      [String(userId), String(telegramUserId)],
    );

    const { rows } = await client.query(
      `INSERT INTO telegram_identities (
         telegram_user_id, user_id, telegram_username, first_name, phone,
         contact_shared_at, contact_active, channel_status,
         channel_generation, linked_generation)
       VALUES ($1,$2,$3,$4,$5, now(), TRUE, 'unknown', $6, $6)
       ON CONFLICT (telegram_user_id) DO UPDATE SET
         user_id = EXCLUDED.user_id, phone = EXCLUDED.phone,
         contact_shared_at = EXCLUDED.contact_shared_at,
         contact_active = TRUE, channel_status = 'unknown',
         channel_generation = EXCLUDED.channel_generation,
         linked_generation = EXCLUDED.linked_generation,
         last_seen_at = now()
       RETURNING ${IDENTITY_COLUMNS}`,
      [String(telegramUserId), String(userId), telegramUsername, firstName,
       String(phone), generation],
    );

    return {
      ok: true,
      identity: toIdentity(rows[0]),
      // Which identity lost the account, so the caller can report it. A
      // recovery that displaced nobody is a first link, not a recovery.
      displacedTelegramUserId: retired[0]?.telegram_user_id ?? null,
    };
  });
}

/**
 * Cache a channel-membership observation.
 *
 * The generation is stored WITH the status, never separately, so an admin
 * swapping the channel makes every cached answer stale by construction rather
 * than by a sweep somebody has to remember to run.
 */
export async function setChannelStatus(telegramUserId, { status, generation }) {
  const { rows } = await pgQuery(
    `UPDATE telegram_identities
        SET channel_status = $2, channel_generation = $3,
            channel_checked_at = now(), last_seen_at = now()
      WHERE telegram_user_id = $1
      RETURNING ${IDENTITY_COLUMNS}`,
    [String(telegramUserId), status, generation], 'tg_identity_channel',
  );
  return toIdentity(rows[0]);
}

/**
 * Retire an identity's contact claim.
 *
 * The row SURVIVES, marked — "was this number ever linked, and to whom?" is
 * what a recovery request asks, and deleting the row destroys the answer. The
 * partial unique index only covers contact-active rows, so retiring one frees
 * the number for the person's new Telegram account.
 */
export async function deactivateContact(telegramUserId) {
  const { rows } = await pgQuery(
    `UPDATE telegram_identities SET contact_active = FALSE
      WHERE telegram_user_id = $1 RETURNING ${IDENTITY_COLUMNS}`,
    [String(telegramUserId)], 'tg_identity_deactivate',
  );
  return toIdentity(rows[0]);
}

// ── Pending onboardings ──────────────────────────────────────────────────────

const PENDING_COLUMNS = `
  telegram_user_id, step, aadhaar_hash, aadhaar_last4, phone,
  telegram_username, first_name, referral_code, generation, created_at, expires_at`;

function toPending(row) {
  if (!row) return null;
  return {
    telegramUserId: row.telegram_user_id,
    step: row.step,
    aadhaarHash: row.aadhaar_hash,
    aadhaarLast4: row.aadhaar_last4,
    phone: row.phone,
    telegramUsername: row.telegram_username,
    firstName: row.first_name,
    referralCode: row.referral_code,
    generation: toInt(row.generation),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/**
 * The live onboarding for a Telegram account, or null.
 *
 * Filters on `expires_at` rather than trusting the sweep. An expired row that
 * has not been swept yet is NOT a usable onboarding, and a caller that treated
 * it as one would resume a conversation whose Aadhaar hash is past its
 * retention window.
 */
export async function getPendingLink(telegramUserId) {
  if (!telegramUserId) return null;
  const { rows } = await pgQuery(
    `SELECT ${PENDING_COLUMNS} FROM telegram_pending_links
      WHERE telegram_user_id = $1 AND expires_at > now()`,
    [String(telegramUserId)], 'tg_pending_get',
  );
  return toPending(rows[0]);
}

/** The captured Aadhaar ciphertext, for the one step that promotes it. */
export async function getPendingAadhaar(telegramUserId) {
  const { rows } = await pgQuery(
    `SELECT aadhaar_hash, aadhaar_encrypted, aadhaar_last4
       FROM telegram_pending_links
      WHERE telegram_user_id = $1 AND expires_at > now()`,
    [String(telegramUserId)], 'tg_pending_aadhaar',
  );
  const r = rows[0];
  return r ? {
    aadhaarHash: r.aadhaar_hash,
    aadhaarEncrypted: r.aadhaar_encrypted,
    aadhaarLast4: r.aadhaar_last4,
  } : null;
}

/**
 * Start or advance an onboarding.
 *
 * Upsert on the Telegram id: somebody who abandons a conversation and starts
 * again gets ONE row, and a restarted onboarding resets the expiry rather than
 * inheriting the abandoned one's.
 */
export async function upsertPendingLink({
  telegramUserId, step = 'AWAITING_AADHAAR', aadhaarHash = null,
  aadhaarEncrypted = null, aadhaarLast4 = '', phone = null,
  telegramUsername = '', firstName = '', referralCode = null, generation = 0,
  ttlHours = 24,
}) {
  const { rows } = await pgQuery(
    `INSERT INTO telegram_pending_links (
       telegram_user_id, step, aadhaar_hash, aadhaar_encrypted, aadhaar_last4,
       phone, telegram_username, first_name, referral_code, generation, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + ($11 || ' hours')::interval)
     ON CONFLICT (telegram_user_id) DO UPDATE SET
       step = EXCLUDED.step,
       -- COALESCE so advancing a step does not erase what an earlier one
       -- captured: the contact step sends no Aadhaar, and overwriting with NULL
       -- would lose the number the conversation already proved.
       aadhaar_hash      = COALESCE(EXCLUDED.aadhaar_hash, telegram_pending_links.aadhaar_hash),
       aadhaar_encrypted = COALESCE(EXCLUDED.aadhaar_encrypted, telegram_pending_links.aadhaar_encrypted),
       aadhaar_last4     = COALESCE(NULLIF(EXCLUDED.aadhaar_last4, ''), telegram_pending_links.aadhaar_last4),
       phone             = COALESCE(EXCLUDED.phone, telegram_pending_links.phone),
       telegram_username = COALESCE(NULLIF(EXCLUDED.telegram_username, ''), telegram_pending_links.telegram_username),
       first_name        = COALESCE(NULLIF(EXCLUDED.first_name, ''), telegram_pending_links.first_name),
       referral_code     = COALESCE(telegram_pending_links.referral_code, EXCLUDED.referral_code),
       generation        = EXCLUDED.generation,
       expires_at        = EXCLUDED.expires_at
     RETURNING ${PENDING_COLUMNS}`,
    [String(telegramUserId), step, aadhaarHash, aadhaarEncrypted, aadhaarLast4,
     phone, telegramUsername, firstName, referralCode, generation, String(ttlHours)],
    'tg_pending_upsert',
  );
  return toPending(rows[0]);
}

/** Drop an onboarding once it has produced an identity. */
export async function deletePendingLink(telegramUserId) {
  await pgQuery(
    `DELETE FROM telegram_pending_links WHERE telegram_user_id = $1`,
    [String(telegramUserId)], 'tg_pending_delete',
  );
}

/**
 * Turn a completed onboarding into an account.
 *
 * ONE transaction across three tables: the account, the Telegram identity that
 * drives it, and the Aadhaar queued for the next verification export. All three
 * or none — a half-created signup is an account nobody can sign into, or an
 * Aadhaar registered against a person who does not exist.
 *
 * ── Refusals are answers, not errors ─────────────────────────────────────────
 * Every refusal below is something the bot has to TELL somebody, so each comes
 * back as a reason rather than a thrown error. The unique indexes are what
 * decide — a courtesy check before the insert has a window a concurrent signup
 * fits through, and this path is reachable twice for the same person whenever
 * Telegram redelivers an update.
 *
 *   phone_already_linked  another live identity holds this number
 *   aadhaar_taken         this Aadhaar is registered to another account
 *   duplicate             the account already exists (a redelivered update)
 *
 * @returns {Promise<{ok:true,userId:string}|{ok:false,reason:string}>}
 */
export async function createAccountFromOnboarding({
  telegramUserId, mobile, username, aadhaarHash, aadhaarEncrypted, aadhaarLast4,
  telegramUsername = '', firstName = '', referralCode = null, referredBy = null,
  generation = 0, newUserId, kycStatus = 'PENDING_APPROVAL',
}) {
  if (!telegramUserId || !mobile) throw new Error('createAccountFromOnboarding requires telegramUserId and mobile');
  if (!aadhaarHash || !aadhaarEncrypted) throw new Error('createAccountFromOnboarding requires the captured Aadhaar');

  try {
    return await withTelegramTransaction(async (client) => {
      const userId = String(newUserId);

      const { rows: userRows } = await client.query(
        `INSERT INTO users (user_id, username, mobile, referral_code, referred_by,
                            status, kyc_status, kyc_submission_count)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, 1)
         ON CONFLICT (mobile) DO NOTHING
         RETURNING user_id`,
        [userId, username || `player${String(mobile).slice(-4)}`, String(mobile),
         referralCode, referredBy ? String(referredBy) : null, kycStatus],
      );
      // The signup IS submission one — counted here rather than in a second
      // statement, so the reapply cap cannot silently allow one more attempt
      // than it advertises.
      if (!userRows[0]) return { ok: false, reason: 'duplicate' };

      await client.query(
        `INSERT INTO telegram_identities (
           telegram_user_id, user_id, telegram_username, first_name, phone,
           contact_shared_at, linked_generation, channel_generation)
         VALUES ($1, $2, $3, $4, $5, now(), $6, $6)`,
        [String(telegramUserId), userId, telegramUsername, firstName, String(mobile), generation],
      );

      await client.query(
        `INSERT INTO kyc_verifications (user_id, aadhaar_hash, aadhaar_encrypted,
                                        aadhaar_last4, phone)
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, String(aadhaarHash), String(aadhaarEncrypted),
         String(aadhaarLast4 ?? ''), String(mobile)],
      );

      return { ok: true, userId };
    });
  } catch (e) {
    // 23505 is a unique violation. WHICH index refused decides what the bot
    // says, so the constraint name is read rather than reporting one message
    // for every collision — "this number is already linked" and "this Aadhaar
    // belongs to another account" send a person to different places.
    if (e?.code === '23505') {
      if (e.constraint === 'one_active_identity_per_phone') return { ok: false, reason: 'phone_already_linked' };
      if (e.constraint === 'kyc_verifications_aadhaar_hash_key') return { ok: false, reason: 'aadhaar_taken' };
      return { ok: false, reason: 'duplicate' };
    }
    throw e;
  }
}

// ── Login tokens ─────────────────────────────────────────────────────────────

/** Issue a one-time login token. Only the HASH is stored. */
export async function issueLoginToken({ tokenHash, telegramUserId, userId, ttlSeconds = 300 }) {
  const { rows } = await pgQuery(
    `INSERT INTO telegram_login_tokens (token_hash, telegram_user_id, user_id, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)
     RETURNING token_hash, user_id, expires_at`,
    [String(tokenHash), String(telegramUserId), String(userId), String(ttlSeconds)],
    'tg_login_issue',
  );
  return { tokenHash: rows[0].token_hash, userId: rows[0].user_id, expiresAt: rows[0].expires_at };
}

/**
 * Consume a login token, once.
 *
 * The read and the consume are ONE atomic UPDATE. Checking first and consuming
 * second is two statements, and a forwarded link redeemed twice fits between
 * them — which for a bearer credential means two sessions from one token.
 * `consumed_at IS NULL` in the WHERE clause is what makes exactly one of N
 * racing redemptions win.
 *
 * Expiry is checked HERE, not left to the sweep: a token whose row has not been
 * reclaimed yet is still expired.
 *
 * @returns {{userId: string}|null} null when unknown, already used, or expired —
 *   deliberately indistinguishable to the caller, so the endpoint cannot be
 *   used to tell a real token from a stale one.
 */
export async function consumeLoginToken({ tokenHash, telegramUserId = null }) {
  const { rows } = await pgQuery(
    `UPDATE telegram_login_tokens
        SET consumed_at = now()
      WHERE token_hash = $1
        AND consumed_at IS NULL
        AND expires_at > now()
        AND ($2::text IS NULL OR telegram_user_id = $2)
      RETURNING user_id, telegram_user_id`,
    [String(tokenHash), telegramUserId ? String(telegramUserId) : null],
    'tg_login_consume',
  );
  return rows[0] ? { userId: rows[0].user_id, telegramUserId: rows[0].telegram_user_id } : null;
}

// ── Retention ────────────────────────────────────────────────────────────────

/**
 * Reclaim space from expired rows.
 *
 * Space ONLY. Nothing here decides whether a row is usable — the reads do that,
 * and they do it on every call. This sweep being late, failing, or never
 * scheduled must not make a single expired token redeemable, which is why no
 * read consults it.
 *
 * Counts come back from the DELETE's own row count, reconstructed per pass
 * rather than accumulated across passes: an accumulator counts passes, and a
 * crash mid-pass loses the number permanently.
 */
export async function sweepExpired() {
  const pending = await pgQuery(
    `DELETE FROM telegram_pending_links WHERE expires_at <= now()`, [], 'tg_sweep_pending');
  const tokens = await pgQuery(
    `DELETE FROM telegram_login_tokens WHERE expires_at <= now()`, [], 'tg_sweep_tokens');
  return { pendingLinks: pending.rowCount ?? 0, loginTokens: tokens.rowCount ?? 0 };
}

/** Run `fn` in a transaction — for the two swaps that must be all-or-nothing. */
export async function withTelegramTransaction(fn) {
  const pool = await getPool();
  const client = await connectGuarded(pool);
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
