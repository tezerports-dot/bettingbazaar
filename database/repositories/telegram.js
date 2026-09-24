// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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

// ── The audience, and why it is REQUIRED everywhere below ──────────────────
//
// A player, a merchant and a staff member are three separate entities (§33.5),
// and as of 2026-09-24 each gets its own bot and its own channel: "one bot with
// its own channel for merchant and one bot with its own channel for admin thus
// it will be complete separate from user panel" (owner).
//
// The values are `ACCOUNT_TYPES` — IMPORTED, not re-declared. An account's type
// IS its audience, so a second list here would be a second owner of the same
// vocabulary (§5) and the drift would show up as a merchant who can never
// verify.
//
// `assertAudience` THROWS rather than defaulting, for the reason
// `getUserByMobile` does: a default would make every un-updated caller silently
// correct for players and silently wrong for the other two — failing only on
// the two populations that were added last and are tested least.
import { ACCOUNT_TYPES } from './users.js';

function assertAudience(audience, fn) {
  if (!ACCOUNT_TYPES.includes(audience)) {
    throw new Error(`${fn} requires an audience (one of ${ACCOUNT_TYPES.join(', ')}); got ${audience}`);
  }
  return audience;
}

const CONFIG_PUBLIC = `
  generation, audience, bot_username, recovery_bot_username,
  channel_id, channel_username, channel_invite_link,
  active, activated_at, activated_by, reason, created_at`;

function toConfig(row) {
  if (!row) return null;
  return {
    generation: toInt(row.generation),
    audience: row.audience,
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

/**
 * The live generation for ONE panel, or null when that panel has never been
 * configured — which for STAFF is the state every install starts in and the
 * state the bootstrap exemption exists to survive.
 */
export async function getActiveConfig(audience) {
  assertAudience(audience, 'getActiveConfig');
  const { rows } = await pgQuery(
    `SELECT ${CONFIG_PUBLIC} FROM telegram_configs WHERE active AND audience = $1 LIMIT 1`,
    [audience], 'tg_config_active',
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
export async function listConfigHistory({ limit = 10, audience = null } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 10, 1), 100);
  // Optional here, and only here: the history screen legitimately shows every
  // panel's swaps side by side, and `audience` is a column on each row so a
  // reader can tell them apart. Every other read below is scoped, because
  // every other read is a DECISION about one person.
  const params = audience ? [assertAudience(audience, 'listConfigHistory')] : [];
  const { rows } = await pgQuery(
    `SELECT ${CONFIG_PUBLIC} FROM telegram_configs
      ${audience ? 'WHERE audience = $1' : ''}
      ORDER BY generation DESC LIMIT ${capped}`, params, 'tg_config_history',
  );
  return rows.map(toConfig);
}

/**
 * The live generation's SECRETS. Separate function, deliberately: no route that
 * renders a config calls this one.
 */
export async function getActiveConfigSecrets(audience) {
  assertAudience(audience, 'getActiveConfigSecrets');
  const { rows } = await pgQuery(
    `SELECT generation, audience, bot_token_encrypted, webhook_secret,
            recovery_bot_token_encrypted, recovery_webhook_secret
       FROM telegram_configs WHERE active AND audience = $1 LIMIT 1`,
    [audience], 'tg_config_secrets',
  );
  const r = rows[0];
  return r ? {
    generation: toInt(r.generation),
    audience: r.audience,
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
export async function getActiveConfigWithSecrets(audience) {
  assertAudience(audience, 'getActiveConfigWithSecrets');
  const { rows } = await pgQuery(
    `SELECT ${CONFIG_PUBLIC},
            bot_token_encrypted, webhook_secret,
            recovery_bot_token_encrypted, recovery_webhook_secret
       FROM telegram_configs WHERE active AND audience = $1 LIMIT 1`,
    [audience], 'tg_config_active_secrets',
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
  audience,
  channelId, channelUsername = '', channelInviteLink = '',
  botTokenEncrypted = null, botUsername = '', webhookSecret = null,
  recoveryBotTokenEncrypted = null, recoveryBotUsername = '', recoveryWebhookSecret = null,
  activatedBy = null, reason = '',
}) {
  if (!channelId) throw new Error('activateConfig requires a channelId');
  assertAudience(audience, 'activateConfig');
  return withTelegramTransaction(async (client) => {
    // ── Scoped to the audience, and this line is the expensive one to get
    // wrong. Unscoped, activating the merchant channel deactivates the PLAYER
    // channel in the same transaction — which, because a cached membership is
    // stamped with the generation it was observed in, silently re-gates the
    // entire player base at the moment an operator thought they were
    // configuring something else.
    await client.query(
      'UPDATE telegram_configs SET active = FALSE WHERE active AND audience = $1', [audience]);
    const { rows } = await client.query(
      `INSERT INTO telegram_configs (
         generation, audience, bot_token_encrypted, bot_username, webhook_secret,
         recovery_bot_token_encrypted, recovery_bot_username, recovery_webhook_secret,
         channel_id, channel_username, channel_invite_link,
         active, activated_at, activated_by, reason)
       VALUES ((SELECT COALESCE(MAX(generation), 0) + 1 FROM telegram_configs),
               $12, $1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, now(), $10, $11)
       RETURNING ${CONFIG_PUBLIC}`,
      [botTokenEncrypted, botUsername, webhookSecret,
       recoveryBotTokenEncrypted, recoveryBotUsername, recoveryWebhookSecret,
       String(channelId), channelUsername, channelInviteLink,
       activatedBy ? String(activatedBy) : null, reason, audience],
    );
    return toConfig(rows[0]);
  });
}

// ── The bot registry ─────────────────────────────────────────────────────────

const BOT_PUBLIC = `
  bot_id, label, role, audience, username, status, live_slot, webhook_url,
  webhook_registered_at, last_error, added_by, added_at,
  activated_at, activated_by, retired_at, retired_by, notes`;

function toBot(row) {
  if (!row) return null;
  return {
    botId: row.bot_id, label: row.label, role: row.role, audience: row.audience,
    username: row.username,
    status: row.status, liveSlot: row.live_slot, webhookUrl: row.webhook_url,
    webhookRegisteredAt: row.webhook_registered_at, lastError: row.last_error,
    addedBy: row.added_by, addedAt: row.added_at,
    activatedAt: row.activated_at, activatedBy: row.activated_by,
    retiredAt: row.retired_at, retiredBy: row.retired_by, notes: row.notes,
  };
}

/** Every registered bot, live and reserve. Secrets excluded. */
export async function listBots({ role = null, status = null, audience = null } = {}) {
  const where = [];
  const params = [];
  if (role) { params.push(role); where.push(`role = $${params.length}`); }
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  // Optional, like `listConfigHistory`'s: the Bot Fleet screen renders all
  // three panels' fleets together and `audience` is on every row, so an
  // operator sees at a glance that the merchant panel has no bot yet. A read
  // that DECIDES something is scoped; a read that DISPLAYS may not be.
  if (audience) {
    params.push(assertAudience(audience, 'listBots'));
    where.push(`audience = $${params.length}`);
  }
  const { rows } = await pgQuery(
    `SELECT ${BOT_PUBLIC} FROM telegram_bots
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY audience, role, status, added_at DESC`, params, 'tg_bot_list',
  );
  return rows.map(toBot);
}

/**
 * A live bot for a role, or null.
 *
 * ── Why this no longer reads `live_slot` ──────────────────────────────────
 * It used to, because at most one bot per role could be live and the generated
 * column enforced it. `signin` is a FLEET now, so its `live_slot` is always
 * NULL and that query would answer null for every sign-in bot the operator
 * has running — silently turning a working fleet into "Telegram is not
 * configured".
 *
 * So the question this answers is stated as what it actually is: give me A live
 * bot in this role. For `recovery` the partial unique index still guarantees
 * there is at most one, so the answer is identical to what it always was. For
 * `signin` it is the first of the fleet, deterministically, and WHICH one does
 * not matter to any caller: this is read for channel questions (getChatMember)
 * and for resolving a @username to show, never to decide who a player's
 * conversation belongs to. That decision is the ROTATION's, and a player's
 * replies are answered by the bot whose webhook they arrived on.
 */
export async function getLiveBot(role, audience) {
  assertAudience(audience, 'getLiveBot');
  const { rows } = await pgQuery(
    `SELECT ${BOT_PUBLIC} FROM telegram_bots
      WHERE status = 'ACTIVE' AND role = $1 AND audience = $2
      ORDER BY added_at, bot_id LIMIT 1`, [role, audience], 'tg_bot_live',
  );
  return toBot(rows[0]);
}

/** A live bot's credentials, for the send and channel-read paths only. */
export async function getLiveBotSecrets(role, audience) {
  assertAudience(audience, 'getLiveBotSecrets');
  const { rows } = await pgQuery(
    `SELECT bot_id, username, audience, token_encrypted, webhook_secret
       FROM telegram_bots
      WHERE status = 'ACTIVE' AND role = $1 AND audience = $2
      ORDER BY added_at, bot_id LIMIT 1`, [role, audience], 'tg_bot_live_secrets',
  );
  const r = rows[0];
  return r ? {
    botId: r.bot_id, username: r.username, audience: r.audience,
    tokenEncrypted: r.token_encrypted, webhookSecret: r.webhook_secret,
  } : null;
}

/** Register a bot. Parked as STANDBY unless told otherwise — that is the point. */
export async function addBot({
  botId, label, role, audience, username, tokenEncrypted, webhookSecret,
  status = 'STANDBY', addedBy = null, notes = '',
}) {
  assertAudience(audience, 'addBot');
  const { rows } = await pgQuery(
    `INSERT INTO telegram_bots (bot_id, label, role, audience, username, token_encrypted,
                                webhook_secret, status, added_by, notes)
     VALUES ($1,$2,$3,$10,$4,$5,$6,$7,$8,$9)
     RETURNING ${BOT_PUBLIC}`,
    [String(botId), label, role, username, tokenEncrypted, webhookSecret,
     status, addedBy ? String(addedBy) : null, notes, audience],
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
    // ── The audience comes from the BOT'S OWN ROW, never from the caller ────
    // A promotion is not a place to re-decide which panel a bot serves: the
    // audience was fixed when it was registered, and taking it from an argument
    // would let a mistyped field stand down the PLAYER recovery bot while
    // promoting a merchant one — the incumbent of a door nobody meant to touch.
    const { rows: subject } = await client.query(
      'SELECT audience FROM telegram_bots WHERE bot_id = $1', [String(botId)],
    );
    if (!subject[0]) throw new Error(`promoteBot: no promotable bot ${botId} in role ${role}`);
    const audience = subject[0].audience;

    const { rows: stoodDown } = await client.query(
      `UPDATE telegram_bots
          SET status = 'STANDBY', activated_at = NULL, activated_by = NULL
        WHERE live_slot = $1 AND bot_id <> $2
        RETURNING ${BOT_PUBLIC}, token_encrypted, webhook_secret`,
      [`${audience}:${role}`, String(botId)],
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
    `SELECT bot_id, username, role, audience, status, token_encrypted, webhook_secret
       FROM telegram_bots WHERE bot_id = $1`,
    [String(botId)], 'tg_bot_secrets',
  );
  const r = rows[0];
  return r ? {
    botId: r.bot_id, username: r.username, role: r.role, audience: r.audience, status: r.status,
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
        AND (
          -- The signin role is a FLEET, so live_slot is always NULL for it and
          -- the guard above cannot see it. An operator may retire any sign-in
          -- bot they like EXCEPT the last live one, which is the same refusal
          -- the generated column gives a singular role, expressed the only way
          -- a fleet allows: by counting what would be left.
          -- Scoped to the bot's OWN audience: the player fleet having spares
          -- says nothing about whether retiring this merchant bot leaves the
          -- merchant panel with no front door. Unscoped, it would have allowed
          -- exactly that, and the first merchant to try verifying would meet a
          -- gate with no bot to open.
          status <> 'ACTIVE' OR role <> 'signin'
          OR EXISTS (SELECT 1 FROM telegram_bots sibling
                      WHERE sibling.status = 'ACTIVE' AND sibling.role = 'signin'
                        AND sibling.audience = telegram_bots.audience
                        AND sibling.bot_id <> $1)
        )
      RETURNING ${BOT_PUBLIC}`,
    [String(botId), actor ? String(actor) : null], 'tg_bot_retire',
  );
  if (rows[0]) return { ok: true, bot: toBot(rows[0]) };
  const current = await getBot(botId);
  if (!current) return { ok: false, reason: 'NOT_FOUND' };
  if (current.status === 'RETIRED') return { ok: false, reason: 'ALREADY_RETIRED' };
  return { ok: false, reason: 'IS_LIVE', role: current.role, audience: current.audience };
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

// `audience` is half the PRIMARY KEY and it has to be in here.
//
// `toIdentity` has always mapped it; this list did not SELECT it, so every
// identity this repository returned carried `audience: undefined` — a mapper
// naming a column its own query never fetched, which no type and no gate can
// see (§32 S9's mirror: the projection omits what its consumer needs).
//
// MEASURED, on a fully configured platform with all three channels active and
// all three actors linked and members: `membershipFor` takes its scope from
// `identity.audience`, got `undefined`, and answered `unconfigured` for every
// account. The verification gate turns that into `no_channel` — the reason
// that renders as the platform's own fault WITH NO BUTTON — so every player
// and every merchant was blocked out of the whole app, permanently, and the
// screen could not tell them anything they could act on.
//
// It was invisible from the admin panel, which is the worst part: STAFF pass
// `no_channel` through the bootstrap exemption (§33.7), so an operator saw a
// working admin panel while the entire player base sat behind a modal.
const IDENTITY_COLUMNS = `
  telegram_user_id, audience, user_id, telegram_username, first_name, phone,
  contact_shared_at, contact_active, channel_status, channel_checked_at,
  channel_generation, linked_generation, created_at, last_seen_at`;

function toIdentity(row) {
  if (!row) return null;
  return {
    telegramUserId: row.telegram_user_id,
    audience: row.audience,
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

/**
 * One Telegram account's link FOR ONE PANEL.
 *
 * The audience is required and it is half the key. One person opens the player
 * bot, the merchant bot and the staff bot from the SAME Telegram account —
 * that is what a Telegram account is — so "which account does this Telegram
 * user hold" has up to three answers and a caller that does not say which one
 * it means is asking a question with no answer.
 */
export async function getIdentityByTelegramId(telegramUserId, audience) {
  if (!telegramUserId) return null;
  assertAudience(audience, 'getIdentityByTelegramId');
  const { rows } = await pgQuery(
    `SELECT ${IDENTITY_COLUMNS} FROM telegram_identities
      WHERE telegram_user_id = $1 AND audience = $2`,
    [String(telegramUserId), audience], 'tg_identity_get',
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
// NOT audience-scoped, and deliberately: `user_id` already belongs to exactly
// one `account_type`, so the row it finds is in that account's audience by
// construction. Adding the parameter would invite a caller to pass one that
// disagrees with the user — a second owner of a value the users table already
// decides (§2).
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
  telegramUserId, audience, userId, phone, contactSharedAt = new Date(),
  telegramUsername = '', firstName = '', linkedGeneration = 0,
}) {
  assertAudience(audience, 'createIdentity');
  const { rows } = await pgQuery(
    `INSERT INTO telegram_identities (
       telegram_user_id, audience, user_id, telegram_username, first_name, phone,
       contact_shared_at, linked_generation, channel_generation)
     VALUES ($1,$8,$2,$3,$4,$5,$6,$7,$7)
     RETURNING ${IDENTITY_COLUMNS}`,
    [String(telegramUserId), String(userId), telegramUsername, firstName,
     String(phone), contactSharedAt, linkedGeneration, audience],
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
  telegramUserId, audience, userId, phone, generation = 0,
  telegramUsername = '', firstName = '',
}) {
  assertAudience(audience, 'relinkIdentity');
  return withTelegramTransaction(async (client) => {
    // Whoever the new Telegram account is currently linked to. Read INSIDE the
    // transaction: a check outside it is a decision made against a state that
    // can change before the write lands.
    const { rows: holder } = await client.query(
      `SELECT user_id FROM telegram_identities
        WHERE telegram_user_id = $1 AND audience = $2`,
      [String(telegramUserId), audience],
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
    // No audience filter on the stand-down above, and that is correct rather
    // than an omission: `user_id` is already one account in one audience, so
    // every row it matches is in this audience by construction. Filtering would
    // read as though the account could have identities elsewhere.

    const { rows } = await client.query(
      `INSERT INTO telegram_identities (
         telegram_user_id, user_id, telegram_username, first_name, phone,
         contact_shared_at, contact_active, channel_status,
         channel_generation, linked_generation, audience)
       VALUES ($1,$2,$3,$4,$5, now(), TRUE, 'unknown', $6, $6, $7)
       ON CONFLICT (telegram_user_id, audience) DO UPDATE SET
         user_id = EXCLUDED.user_id, phone = EXCLUDED.phone,
         contact_shared_at = EXCLUDED.contact_shared_at,
         contact_active = TRUE, channel_status = 'unknown',
         channel_generation = EXCLUDED.channel_generation,
         linked_generation = EXCLUDED.linked_generation,
         last_seen_at = now()
       RETURNING ${IDENTITY_COLUMNS}`,
      [String(telegramUserId), String(userId), telegramUsername, firstName,
       String(phone), generation, audience],
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
export async function setChannelStatus(telegramUserId, { status, generation, audience }) {
  assertAudience(audience, 'setChannelStatus');
  const { rows } = await pgQuery(
    `UPDATE telegram_identities
        SET channel_status = $2, channel_generation = $3,
            channel_checked_at = now(), last_seen_at = now()
      WHERE telegram_user_id = $1 AND audience = $4
      RETURNING ${IDENTITY_COLUMNS}`,
    [String(telegramUserId), status, generation, audience], 'tg_identity_channel',
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
export async function deactivateContact(telegramUserId, audience) {
  assertAudience(audience, 'deactivateContact');
  const { rows } = await pgQuery(
    `UPDATE telegram_identities SET contact_active = FALSE
      WHERE telegram_user_id = $1 AND audience = $2 RETURNING ${IDENTITY_COLUMNS}`,
    [String(telegramUserId), audience], 'tg_identity_deactivate',
  );
  return toIdentity(rows[0]);
}

// ── Pending onboardings, login tokens and login codes — REMOVED 2026-09-23 ──
//
// Ten functions went, across three tables that are gone from schema.sql:
//
//   getPendingLink · getPendingAadhaar · upsertPendingLink · deletePendingLink
//   createAccountFromOnboarding
//   issueLoginToken · consumeLoginToken
//   getLoginTargetByMobile · issueLoginCode · consumeLoginCode
//
// The account is created by a FORM now (createAccountFromSignup, in
// repositories/identity.js), so there is no half-finished conversation to
// park; and players have passwords, so no bot mints a credential. The one
// function that survived the change is `linkTelegramToAccount` at the bottom
// of this file, which matches a contact share against an account that already
// exists rather than creating one.
//
// Deleted rather than kept for a caller that might come back (§30: do not
// accommodate; remove). Nothing imports them — check:dead-code proves it.

// ── Recovery sessions ────────────────────────────────────────────────────────
//
// The Aadhaar a person sent the recovery bot, held until their contact share
// arrives. HASHES only — `attemptRecovery` compares and never reads the number,
// so the plaintext is not stored anywhere (schema.sql explains why this is not
// merged into `telegram_pending_links`).

/**
 * Start or replace a recovery session.
 *
 * Replaces on conflict rather than refusing: sending the bot a second Aadhaar
 * means correcting a typo, and a person who has already lost their account
 * should not also be told they must wait out a TTL to fix one.
 */
export async function putRecoverySession({ telegramUserId, audience, aadhaarHashes, ttlSeconds }) {
  if (!telegramUserId) throw new Error('putRecoverySession requires a telegramUserId');
  assertAudience(audience, 'putRecoverySession');
  if (!Array.isArray(aadhaarHashes) || !aadhaarHashes.length) {
    throw new Error('putRecoverySession requires at least one aadhaar hash');
  }
  const { rows } = await pgQuery(
    `INSERT INTO telegram_recovery_sessions (telegram_user_id, audience, aadhaar_hashes, expires_at)
     VALUES ($1, $4, $2, now() + ($3 || ' seconds')::interval)
     ON CONFLICT (telegram_user_id, audience) DO UPDATE
       SET aadhaar_hashes = EXCLUDED.aadhaar_hashes,
           created_at     = now(),
           expires_at     = EXCLUDED.expires_at
     RETURNING expires_at`,
    [String(telegramUserId), aadhaarHashes.map(String),
     String(Math.max(Number(ttlSeconds) || 600, 1)), audience],
    'tg_recovery_put',
  );
  return { expiresAt: rows[0].expires_at };
}

/**
 * The live session, or null.
 *
 * Expiry is in the STATEMENT, so a sweep that is late, failed or never
 * scheduled cannot make a stale session usable.
 */
export async function getRecoverySession(telegramUserId, audience) {
  assertAudience(audience, 'getRecoverySession');
  const { rows } = await pgQuery(
    `SELECT aadhaar_hashes, expires_at FROM telegram_recovery_sessions
      WHERE telegram_user_id = $1 AND audience = $2 AND expires_at > now()`,
    [String(telegramUserId), audience], 'tg_recovery_get',
  );
  return rows[0] ? { aadhaarHashes: rows[0].aadhaar_hashes, expiresAt: rows[0].expires_at } : null;
}

/** Consume it. Called whether the attempt succeeded or failed — one try per send. */
export async function deleteRecoverySession(telegramUserId, audience) {
  assertAudience(audience, 'deleteRecoverySession');
  await pgQuery(
    'DELETE FROM telegram_recovery_sessions WHERE telegram_user_id = $1 AND audience = $2',
    [String(telegramUserId), audience], 'tg_recovery_delete',
  );
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
  // Two tables. Three others (pending links, login tokens, login codes) were
  // swept here and no longer exist — a sweep naming a dropped table throws
  // 42P01 on every pass, which would take the whole retention job down rather
  // than just this line.
  const recovery = await pgQuery(
    `DELETE FROM telegram_recovery_sessions WHERE expires_at <= now()`, [], 'tg_sweep_recovery');
  const resets = await pgQuery(
    `DELETE FROM password_resets WHERE expires_at <= now()`, [], 'tg_sweep_resets');
  return { recoverySessions: recovery.rowCount ?? 0, passwordResets: resets.rowCount ?? 0 };
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

/**
 * Link a Telegram account to a user who ALREADY EXISTS, by their phone number.
 *
 * ── The new shape of onboarding ────────────────────────────────────────────
 * Identity is established by the signup FORM — Aadhaar, the mobile it is linked
 * to, and a password. Telegram's job is no longer to create the account; it is
 * to prove that the mobile typed into that form is a mobile the person actually
 * holds, which is exactly what a shared contact is. So this matches, it does not
 * create: no contact ever produces a user row.
 *
 * `reason` on a refusal is what the bot says next, and the three are different
 * conversations:
 *
 *   no_account        — nobody signed up with that number. Send them to the site.
 *   already_linked    — that Telegram account is already somebody's.
 *   phone_taken       — that NUMBER is already proven by a different Telegram
 *                       account, which is the one case worth a human looking at.
 *
 * ── A re-share from the same Telegram account is not an error ──────────────
 * People tap the button twice, and a bot swap or a channel change sends them
 * back through it. A repeat from the SAME telegram id against the SAME user is
 * idempotent and refreshes what Telegram last told us about them, because the
 * alternative — refusing — reads to the person as though their verification had
 * failed.
 */
export async function linkTelegramToAccount({
  telegramUserId, audience, phone, telegramUsername = '', firstName = '', generation = 0,
}) {
  if (!telegramUserId || !phone) {
    throw new Error('linkTelegramToAccount requires a telegramUserId and a phone');
  }
  assertAudience(audience, 'linkTelegramToAccount');
  const tgId = String(telegramUserId);
  const number = String(phone);

  try {
    return await withTelegramTransaction(async (client) => {
      // The account must already exist. This is the whole difference from what
      // this replaced: a contact that matches nothing is a person who has not
      // filled the form yet, and the answer is to send them to it.
      //
      // ── The account_type filter is load-bearing, and it is now the AUDIENCE
      // ────────────────────────────────────────────────────────────────────
      // A mobile can hold a PLAYER, a STAFF and a MERCHANT account (§33.5), and
      // without this predicate the query matched whichever the planner reached
      // first. MEASURED, before the fix: a player sharing their contact linked
      // the STAFF row on the same number — and the bot's password-reset button
      // then issued a reset link for an ADMIN account to somebody who had
      // proved nothing but possession of the phone. A privilege escalation out
      // of an unfiltered SELECT (§32 S30).
      //
      // The literal 'PLAYER' that fixed it has become the bot's own audience,
      // which is stronger rather than looser: the STAFF bot has its own token
      // and its own webhook path, so a contact arriving there can only ever
      // reach a STAFF row, and a contact arriving at a player bot still cannot
      // reach anything else. The predicate and the door now say the same thing.
      const { rows: userRows } = await client.query(
        `SELECT user_id FROM users
          WHERE mobile = $1 AND account_type = $2 AND status <> 'DELETED'`, [number, audience],
      );
      if (!userRows[0]) return { ok: false, reason: 'no_account' };
      const userId = userRows[0].user_id;

      const { rows: mine } = await client.query(
        `SELECT user_id FROM telegram_identities
          WHERE telegram_user_id = $1 AND audience = $2`, [tgId, audience],
      );
      if (mine[0]) {
        if (String(mine[0].user_id) !== String(userId)) {
          return { ok: false, reason: 'already_linked' };
        }
        // Same person, same account — refresh and move on.
        await client.query(
          `UPDATE telegram_identities
              SET telegram_username = $2, first_name = $3, phone = $4,
                  contact_active = TRUE, contact_shared_at = now(), last_seen_at = now()
            WHERE telegram_user_id = $1 AND audience = $5`,
          [tgId, telegramUsername, firstName, number, audience],
        );
        return { ok: true, userId, relinked: true };
      }

      await client.query(
        `INSERT INTO telegram_identities (
           telegram_user_id, audience, user_id, telegram_username, first_name, phone,
           contact_shared_at, linked_generation, channel_generation)
         VALUES ($1, $7, $2, $3, $4, $5, now(), $6, $6)`,
        [tgId, userId, telegramUsername, firstName, number, generation, audience],
      );
      return { ok: true, userId, relinked: false };
    });
  } catch (e) {
    if (e?.code === '23505') {
      if (e.constraint === 'one_active_identity_per_phone') return { ok: false, reason: 'phone_taken' };
      return { ok: false, reason: 'already_linked' };
    }
    throw e;
  }
}

// ── The sign-in bot FLEET, and whose turn it is ─────────────────────────────

/**
 * Every live sign-in bot, in the rotation's own order.
 *
 * The order is `added_at, bot_id` — stable, and stable across a restart, which
 * a rotation needs: an order that changed between two signups would hand the
 * same position to two different bots.
 */
export async function listLiveSigninBots(audience) {
  assertAudience(audience, 'listLiveSigninBots');
  const { rows } = await pgQuery(
    `SELECT ${BOT_PUBLIC} FROM telegram_bots
      WHERE status = 'ACTIVE' AND role = 'signin' AND audience = $1
      ORDER BY added_at, bot_id`, [audience], 'tg_signin_fleet',
  );
  return rows.map(toBot);
}

/**
 * Which bot this account must open — assigned once, in rotation, and KEPT.
 *
 * ── The rotation, in the owner's words ─────────────────────────────────────
 * "Assign 1, assign 2, then 3rd, 4th, 5th and so on, and once it reaches all,
 * again start from 1." That is `nextval % (number of live bots)`, over the
 * fleet ordered as `listLiveSigninBots` orders it.
 *
 * The cursor is a SEQUENCE, not a counter row and not a number in a process.
 * Trap 6 forbids accumulating a counter in memory; a counter ROW would put
 * every signup behind one lock. `nextval` is non-transactional by design, so
 * two signups arriving together take two different positions without either
 * waiting — and a rolled-back signup skips a number, which costs one bot one
 * place in one cycle and is the right price for not serialising signups.
 *
 * ── Why the answer is STORED ───────────────────────────────────────────────
 * The player is TOLD which bot to open, and they open it. Recomputing the
 * answer on their next page load would send them to a different conversation
 * while the one holding their contact share sat in the first bot. So the
 * assignment is written to `users.telegram_bot_id` and re-read.
 *
 * ── Why it is also SELF-HEALING ────────────────────────────────────────────
 * An admin may retire or replace any bot at any time. An assignment pointing at
 * a bot that is no longer live is not an assignment, so this function re-reads
 * it against the CURRENT fleet on every call: a player whose bot was retired is
 * moved to a live one the next time they are asked to verify, with nothing to
 * migrate and no sweep to run. `keep` is exactly that check, expressed as a
 * join against the live fleet rather than as a status read the caller performs.
 *
 * All of it is ONE statement, so "keep the one they have, otherwise take the
 * next turn" cannot be interleaved with a concurrent call to itself.
 *
 * @returns {Promise<string|null>} the bot id, or null when the operator has not
 *   registered a live sign-in bot yet — a real state at launch, and one the
 *   caller reports rather than treating as an error.
 */
export async function assignSigninBot(userId, audience) {
  assertAudience(audience, 'assignSigninBot');
  const { rows } = await pgQuery(
    `WITH tick AS (SELECT nextval('telegram_signin_rotation') - 1 AS n),
          -- The fleet is PER PANEL. One sequence still drives all three, which
          -- is fine and deliberate: the modulo is taken over this audience's
          -- own live count, so three fleets of different sizes each rotate
          -- through their own bots. A shared cursor skips positions rather than
          -- mis-assigning them, and a skipped position costs one bot one place
          -- in one cycle.
          live AS (
            SELECT bot_id,
                   row_number() OVER (ORDER BY added_at, bot_id) - 1 AS pos,
                   count(*)     OVER ()                              AS total
              FROM telegram_bots
             WHERE status = 'ACTIVE' AND role = 'signin' AND audience = $2
          ),
          -- Whose turn it is. Evaluated once: tick is its own single-row CTE
          -- because nextval written into this predicate directly would be
          -- called once PER CANDIDATE ROW and burn a whole cycle per signup.
          pick AS (
            SELECT l.bot_id FROM live l, tick t WHERE l.pos = t.n % l.total
          ),
          -- The assignment they already hold, but only if it is still live.
          keep AS (
            SELECT u.telegram_bot_id AS bot_id
              FROM users u JOIN live l ON l.bot_id = u.telegram_bot_id
             WHERE u.user_id = $1
          )
     UPDATE users u
        SET telegram_bot_id = COALESCE((SELECT bot_id FROM keep),
                                       (SELECT bot_id FROM pick))
      WHERE u.user_id = $1
     RETURNING u.telegram_bot_id`,
    [String(userId), audience], 'tg_assign_signin_bot',
  );
  return rows[0]?.telegram_bot_id ?? null;
}

/**
 * How many accounts each live bot is currently carrying.
 *
 * The admin panel's reason for existing on this screen: a fleet is a throughput
 * decision, and an operator deciding whether to add bots needs the load, not a
 * list of names. LEFT JOIN so a bot carrying nobody is reported as 0 rather
 * than missing — the row an operator is looking for when they have just added
 * one.
 */
export async function signinBotLoads({ audience = null } = {}) {
  const params = audience ? [assertAudience(audience, 'signinBotLoads')] : [];
  const { rows } = await pgQuery(
    `SELECT b.bot_id, b.username, b.label, b.audience, count(u.user_id) AS assigned
       FROM telegram_bots b
       LEFT JOIN users u ON u.telegram_bot_id = b.bot_id
      WHERE b.status = 'ACTIVE' AND b.role = 'signin'
        ${audience ? 'AND b.audience = $1' : ''}
      GROUP BY b.bot_id, b.username, b.label, b.audience
      ORDER BY b.audience, b.added_at, b.bot_id`, params, 'tg_signin_loads',
  );
  // `count(*)` is BIGINT and node-postgres hands BIGINT back as a STRING
  // (trap 5). Uncast, `'900' >= 1000` is true and every comparison a caller
  // makes on this figure is wrong. Cast at the boundary, once, here.
  return rows.map((r) => ({
    botId: r.bot_id, username: r.username, label: r.label,
    audience: r.audience, assigned: Number(r.assigned),
  }));
}

// ── Password resets, issued by a bot to a number Telegram has verified ──────

/**
 * Issue a single-use reset token.
 *
 * ── What this is, stated plainly ───────────────────────────────────────────
 * A bearer credential, travelling through a chat, for the minutes it lives. It
 * is deliberately narrower than the login link it does NOT resurrect: it grants
 * the right to CHOOSE A PASSWORD and nothing else (owner, 2026-09-24), so a
 * compromised bot cannot sign anybody in — it can at most force somebody to
 * notice that their password changed.
 *
 * Stored as a SHA-256 hash, so a database dump yields nothing usable: the
 * plaintext exists only in the message Telegram delivered.
 *
 * ── One live token per account ────────────────────────────────────────────
 * Asking again INVALIDATES the previous one, in the same statement. Without
 * that, every request a nervous person makes leaves another live credential in
 * their chat history — and the one they eventually use is not necessarily the
 * newest. The delete is not a sweep: it is part of issuing.
 */
export async function issuePasswordReset({ tokenHash, userId, telegramUserId, ttlSeconds = 900 }) {
  return withTelegramTransaction(async (client) => {
    await client.query(
      `DELETE FROM password_resets WHERE user_id = $1 AND consumed_at IS NULL`,
      [String(userId)],
    );
    const { rows } = await client.query(
      `INSERT INTO password_resets (token_hash, user_id, telegram_user_id, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)
       RETURNING expires_at`,
      [String(tokenHash), String(userId), String(telegramUserId), Number(ttlSeconds)],
    );
    return { expiresAt: rows[0].expires_at };
  });
}

/**
 * Redeem it — ONCE.
 *
 * `consumed_at` is set in the SAME atomic UPDATE that reads the row, so twenty
 * racing redemptions produce exactly one winner and nineteen nulls. A read
 * followed by a write is a token two requests can both spend, which on this
 * path means two people setting a password on one account.
 *
 * Expiry is in the WHERE, not in a caller's comparison: a sweep that has not
 * run must never make a stale link usable.
 */
export async function consumePasswordReset(tokenHash) {
  const { rows } = await pgQuery(
    `UPDATE password_resets
        SET consumed_at = now()
      WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING user_id, telegram_user_id`,
    [String(tokenHash)], 'pw_reset_consume',
  );
  const r = rows[0];
  return r ? { userId: r.user_id, telegramUserId: r.telegram_user_id } : null;
}
