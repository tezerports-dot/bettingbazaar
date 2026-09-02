// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * repositories/games.js — third-party providers, live sessions, and the
 * catalogue players browse.
 *
 * ── Two things kept apart ───────────────────────────────────────────────────
 * PROVIDER CREDENTIALS are read by a separate function from provider metadata.
 * A route that renders a provider list calls `listProviders`; only the code
 * that actually calls the provider calls `getProviderSecrets`. That separation
 * is what stops an API secret reaching a response body by accident — a caller
 * has to ask for it by name.
 *
 * A GAME THAT CANNOT BE LAUNCHED IS NOT LIVE. The row enforces it: a LIVE game
 * must carry whatever its launch strategy needs. The alternative is a tile in
 * the lobby that 404s, and the player finds out, not the operator.
 */
import { pgQuery } from '../client.js';
import { rupeesToPaise, paiseToRupees } from '../../backend/shared/money.js';

// ── Providers ───────────────────────────────────────────────────────────────

const toProvider = (r) => (r ? {
  key: r.provider_key, providerKey: r.provider_key,
  name: r.name, category: r.category, enabled: r.enabled,
  apiUrl: r.api_url, merchantId: r.provider_merchant_id,
  extraConfig: r.extra_config, logoUrl: r.logo_url, description: r.description,
  updatedBy: r.updated_by, updatedAt: r.updated_at, createdAt: r.created_at,
} : null);

export async function upsertProvider({
  providerKey, name, category = 'SLOTS', enabled = false, apiUrl = null,
  apiKeyEncrypted = null, apiSecretEncrypted = null, webhookSecretEncrypted = null,
  providerMerchantId = null, extraConfig = {}, logoUrl = null, description = '',
  updatedBy = null,
}) {
  if (!providerKey || !name) throw new Error('upsertProvider requires a providerKey and a name');
  const { rows } = await pgQuery(
    `INSERT INTO game_providers (provider_key, name, category, enabled, api_url,
       api_key_encrypted, api_secret_encrypted, webhook_secret_encrypted,
       provider_merchant_id, extra_config, logo_url, description, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (provider_key) DO UPDATE SET
       name = EXCLUDED.name, category = EXCLUDED.category, enabled = EXCLUDED.enabled,
       api_url = EXCLUDED.api_url,
       -- A null credential means "unchanged", not "cleared". An admin editing a
       -- provider's name must not silently wipe the key that makes it work.
       api_key_encrypted        = COALESCE(EXCLUDED.api_key_encrypted, game_providers.api_key_encrypted),
       api_secret_encrypted     = COALESCE(EXCLUDED.api_secret_encrypted, game_providers.api_secret_encrypted),
       webhook_secret_encrypted = COALESCE(EXCLUDED.webhook_secret_encrypted, game_providers.webhook_secret_encrypted),
       provider_merchant_id = EXCLUDED.provider_merchant_id,
       extra_config = EXCLUDED.extra_config, logo_url = EXCLUDED.logo_url,
       description = EXCLUDED.description, updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING *`,
    [String(providerKey), String(name), String(category), Boolean(enabled), apiUrl,
      apiKeyEncrypted, apiSecretEncrypted, webhookSecretEncrypted, providerMerchantId,
      JSON.stringify(extraConfig ?? {}), logoUrl, String(description), updatedBy],
    'provider_upsert',
  );
  return toProvider(rows[0]);
}

export async function getProvider(providerKey) {
  const { rows } = await pgQuery(
    'SELECT * FROM game_providers WHERE provider_key = $1', [String(providerKey)], 'provider_get',
  );
  return toProvider(rows[0]);
}

/**
 * Providers, without a credential in the result set.
 *
 * The three `has*` flags are computed IN THE DATABASE, so an operator screen
 * can show which providers are configured without the secret travelling to
 * render a row of dots. The route used to SELECT the secrets and then blank
 * them out in JavaScript for sub-admins — one forgotten field, one new
 * credential column, or one caller that skipped the masking loop, and the key
 * is in a response body. Not selecting it cannot be forgotten.
 */
export async function listProviders({ enabledOnly = false } = {}) {
  const { rows } = await pgQuery(
    `SELECT provider_key, name, category, enabled, api_url, provider_merchant_id,
            extra_config, logo_url, description, updated_by, updated_at, created_at,
            (api_key_encrypted        IS NOT NULL) AS has_api_key,
            (api_secret_encrypted     IS NOT NULL) AS has_api_secret,
            (webhook_secret_encrypted IS NOT NULL) AS has_webhook_secret
       FROM game_providers ${enabledOnly ? 'WHERE enabled' : ''}
      ORDER BY category, name`,
    [], 'provider_list',
  );
  return rows.map((r) => ({
    ...toProvider(r),
    hasApiKey: r.has_api_key,
    hasApiSecret: r.has_api_secret,
    hasWebhookSecret: r.has_webhook_secret,
  }));
}

/**
 * What an unauthenticated visitor may see: enabled providers, public fields
 * only.
 *
 * Separate from `listProviders` because the operator list carries `hasApiKey`
 * and friends. Those are booleans, not secrets, but "which of our suppliers is
 * configured but switched off" is commercial information and there is no reason
 * for it to leave the admin surface. The lobby needs a name, a category and a
 * picture.
 */
export async function listPublicProviders() {
  const { rows } = await pgQuery(
    `SELECT provider_key, name, category, logo_url, description
       FROM game_providers WHERE enabled ORDER BY category, name`,
    [], 'provider_list_public',
  );
  return rows.map((r) => ({
    key: r.provider_key, providerKey: r.provider_key, name: r.name,
    category: r.category, logoUrl: r.logo_url, description: r.description,
    enabled: true,
  }));
}

/** The columns an operator may edit, and the body key each is written from. */
const PROVIDER_UPDATABLE = Object.freeze({
  name: 'name',
  category: 'category',
  enabled: 'enabled',
  apiUrl: 'api_url',
  apiKeyEncrypted: 'api_key_encrypted',
  apiSecretEncrypted: 'api_secret_encrypted',
  webhookSecretEncrypted: 'webhook_secret_encrypted',
  providerMerchantId: 'provider_merchant_id',
  extraConfig: 'extra_config',
  logoUrl: 'logo_url',
  description: 'description',
});

/**
 * Create a provider. The PRIMARY KEY decides whether the name is free.
 *
 * `findOne` then `create` is two admins pressing the button at once: both reads
 * miss, both writes run, and the second either overwrites the first's
 * credentials or 500s on the index. `ON CONFLICT DO NOTHING` gives one of them
 * the row and the other a clean `null`, and there is no window between.
 *
 * Created DISABLED regardless of what the caller asks for. A provider is
 * enabled once its credentials have been entered and tested — not in the same
 * request that names it.
 */
export async function createProvider({
  providerKey, name, category = 'SLOTS', apiUrl = null,
  apiKeyEncrypted = null, apiSecretEncrypted = null, webhookSecretEncrypted = null,
  providerMerchantId = null, extraConfig = {}, logoUrl = null, description = '',
  updatedBy = null,
}) {
  if (!providerKey || !name) throw new Error('createProvider requires a providerKey and a name');
  const { rows } = await pgQuery(
    `INSERT INTO game_providers (provider_key, name, category, enabled, api_url,
       api_key_encrypted, api_secret_encrypted, webhook_secret_encrypted,
       provider_merchant_id, extra_config, logo_url, description, updated_by)
     VALUES ($1,$2,$3,FALSE,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (provider_key) DO NOTHING
     RETURNING *`,
    [String(providerKey), String(name), String(category), apiUrl,
      apiKeyEncrypted, apiSecretEncrypted, webhookSecretEncrypted, providerMerchantId,
      JSON.stringify(extraConfig ?? {}), logoUrl, String(description), updatedBy],
    'provider_create',
  );
  return rows[0] ? toProvider(rows[0]) : null;
}

/**
 * Edit a provider. Only the listed columns move, and only the ones supplied.
 *
 * An absent key means "leave it": an admin renaming a provider must not blank
 * the API secret they cannot see on the form. Passing an explicit empty string
 * for a credential clears it, which is how a credential is retired.
 *
 * Returns null when the key does not exist, so the route answers 404 rather
 * than reporting success for a provider it never touched.
 */
export async function updateProvider(providerKey, patch = {}, { updatedBy = null } = {}) {
  const sets = []; const params = [String(providerKey)];
  for (const [key, column] of Object.entries(PROVIDER_UPDATABLE)) {
    if (patch[key] === undefined) continue;
    const value = column === 'extra_config'
      ? JSON.stringify(patch[key] ?? {})
      : (column === 'enabled' ? Boolean(patch[key]) : patch[key]);
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return getProvider(providerKey);
  params.push(updatedBy);
  const { rows } = await pgQuery(
    `UPDATE game_providers SET ${sets.join(', ')}, updated_by = $${params.length}, updated_at = now()
      WHERE provider_key = $1 RETURNING *`,
    params, 'provider_update',
  );
  return rows[0] ? toProvider(rows[0]) : null;
}

/**
 * Remove a provider.
 *
 * Refused while any game in the catalogue still points at it: deleting the
 * provider under a live tile leaves a game nobody can launch and an operator
 * with no clue why. The count and the delete are one statement, so a game
 * added between them cannot slip through.
 */
export async function deleteProvider(providerKey) {
  const { rows } = await pgQuery(
    `WITH blocking AS (
       SELECT count(*)::int AS n FROM games WHERE provider_key = $1
     ), gone AS (
       DELETE FROM game_providers
        WHERE provider_key = $1 AND (SELECT n FROM blocking) = 0
        RETURNING name
     )
     SELECT (SELECT n FROM blocking) AS games, (SELECT name FROM gone) AS deleted_name`,
    [String(providerKey)], 'provider_delete',
  );
  const r = rows[0];
  if (r.deleted_name) return { ok: true, name: r.deleted_name };
  return Number(r.games) > 0
    ? { ok: false, reason: 'HAS_GAMES', games: Number(r.games) }
    : { ok: false, reason: 'NOT_FOUND' };
}

/**
 * The credentials, for the code that calls the provider.
 *
 * Separate from `getProvider` so a secret cannot reach a response body by
 * accident: no route that renders a provider calls this function.
 */
export async function getProviderSecrets(providerKey) {
  const { rows } = await pgQuery(
    `SELECT provider_key, api_url, api_key_encrypted, api_secret_encrypted,
            webhook_secret_encrypted, provider_merchant_id, extra_config
       FROM game_providers WHERE provider_key = $1`,
    [String(providerKey)], 'provider_secrets',
  );
  const r = rows[0];
  return r ? {
    providerKey: r.provider_key, apiUrl: r.api_url,
    apiKeyEncrypted: r.api_key_encrypted,
    apiSecretEncrypted: r.api_secret_encrypted,
    webhookSecretEncrypted: r.webhook_secret_encrypted,
    merchantId: r.provider_merchant_id, extraConfig: r.extra_config,
  } : null;
}

export async function setProviderEnabled(providerKey, enabled) {
  const { rows } = await pgQuery(
    'UPDATE game_providers SET enabled = $2, updated_at = now() WHERE provider_key = $1 RETURNING *',
    [String(providerKey), Boolean(enabled)], 'provider_set_enabled',
  );
  return toProvider(rows[0]);
}

// ── Sessions ────────────────────────────────────────────────────────────────

const toSession = (r) => (r ? {
  sessionId: r.session_id, userId: r.user_id, providerKey: r.provider_key,
  gameId: r.game_id, gameName: r.game_name, currency: r.currency,
  status: r.status, launchUrl: r.launch_url,
  createdAt: r.created_at, expiresAt: r.expires_at,
} : null);

export async function openSession({
  sessionId, userId, providerKey, gameId = null, gameName = null,
  currency = 'INR', launchUrl = null, ttlMinutes = 60,
}) {
  const { rows } = await pgQuery(
    `INSERT INTO game_sessions (session_id, user_id, provider_key, game_id, game_name,
       currency, launch_url, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' minutes')::interval)
     RETURNING *`,
    [String(sessionId), String(userId), String(providerKey), gameId, gameName,
      String(currency), launchUrl, String(Math.max(Number(ttlMinutes) || 60, 1))],
    'session_open',
  );
  return toSession(rows[0]);
}

/**
 * A live session, or null.
 *
 * Expiry is in the READ — a provider callback arriving against a session whose
 * sweep has not run yet must still be refused, and one whose sweep is overdue
 * must still work.
 */
export async function getLiveSession(sessionId) {
  const { rows } = await pgQuery(
    `SELECT * FROM game_sessions
      WHERE session_id = $1 AND status = 'ACTIVE'
        AND (expires_at IS NULL OR expires_at > now())`,
    [String(sessionId)], 'session_get_live',
  );
  return toSession(rows[0]);
}

export async function closeSession(sessionId) {
  const { rows } = await pgQuery(
    `UPDATE game_sessions SET status = 'CLOSED' WHERE session_id = $1 AND status = 'ACTIVE'
      RETURNING *`,
    [String(sessionId)], 'session_close',
  );
  return toSession(rows[0]);
}

export async function listUserSessions(userId, { limit = 50 } = {}) {
  const { rows } = await pgQuery(
    'SELECT * FROM game_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [String(userId), Math.min(Math.max(Number(limit) || 50, 1), 200)], 'session_list',
  );
  return rows.map(toSession);
}

/** Reclaim space. The expiry itself is already enforced by every read. */
export async function sweepExpiredSessions() {
  const { rowCount } = await pgQuery(
    `UPDATE game_sessions SET status = 'EXPIRED'
      WHERE status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at <= now()`,
    [], 'session_sweep',
  );
  return rowCount;
}

// ── Provider transactions ───────────────────────────────────────────────────

/**
 * Record a provider callback that moved money.
 *
 * `tx_id` UNIQUE is the idempotency gate: a redelivered callback collides
 * inside the transaction rather than debiting a player twice. The caller moves
 * the wallet only when this returns `recorded: true`.
 */
export async function recordGameTransaction({
  txId, roundId = null, sessionId = null, userId, providerKey, txType,
  amountRupees, balanceBeforeRupees = null, balanceAfterRupees = null,
  gameId = null, gameName = null,
}) {
  if (!txId) throw new Error('recordGameTransaction requires a txId (idempotency key)');
  const { rows } = await pgQuery(
    `INSERT INTO game_transactions (tx_id, round_id, session_id, user_id, provider_key,
       tx_type, amount_paise, balance_before_paise, balance_after_paise, game_id, game_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (tx_id) DO NOTHING
     RETURNING id, created_at`,
    [String(txId), roundId, sessionId, String(userId), String(providerKey), String(txType),
      rupeesToPaise(amountRupees),
      balanceBeforeRupees === null ? null : rupeesToPaise(balanceBeforeRupees),
      balanceAfterRupees === null ? null : rupeesToPaise(balanceAfterRupees),
      gameId, gameName], 'game_tx_record',
  );
  return rows[0]
    ? { recorded: true, id: Number(rows[0].id), createdAt: rows[0].created_at }
    : { recorded: false, idempotent: true };
}

/**
 * What a round has been debited and refunded so far.
 *
 * ── Why this is a sum and not a lookup ──────────────────────────────────────
 * A hostile or buggy provider can mint money two ways: by rolling back a round
 * that never had a bet, or by rolling back more than was staked. The duplicate
 * `tx_id` gate does not help — it stops the SAME callback applying twice and
 * says nothing about a DIFFERENT callback that should never have been honoured.
 *
 * Both totals are computed over every transaction recorded for the round, so
 * partial rollbacks accumulate correctly. Checking a single callback against
 * the bet alone would let any number of them through.
 */
export async function roundTotals(roundId, userId) {
  const { rows } = await pgQuery(
    `SELECT
       COALESCE(SUM(amount_paise) FILTER (WHERE tx_type = 'BET'), 0)                    AS debited,
       COALESCE(SUM(amount_paise) FILTER (WHERE tx_type IN ('ROLLBACK','REFUND')), 0)   AS refunded,
       COALESCE(SUM(amount_paise) FILTER (WHERE tx_type = 'WIN'), 0)                    AS won
     FROM game_transactions WHERE round_id = $1 AND user_id = $2`,
    [String(roundId), String(userId)], 'game_round_totals',
  );
  const r = rows[0];
  return {
    debited: paiseToRupees(Number(r.debited)),
    refunded: paiseToRupees(Number(r.refunded)),
    won: paiseToRupees(Number(r.won)),
  };
}

/** One provider transaction by its id — the replay lookup. */
export async function getGameTransaction(txId) {
  const { rows } = await pgQuery(
    'SELECT * FROM game_transactions WHERE tx_id = $1', [String(txId)], 'game_tx_get',
  );
  const r = rows[0];
  return r ? {
    txId: r.tx_id, roundId: r.round_id, userId: r.user_id,
    providerKey: r.provider_key, type: r.tx_type,
    amount: paiseToRupees(Number(r.amount_paise)),
    balanceAfter: r.balance_after_paise === null ? null : paiseToRupees(Number(r.balance_after_paise)),
    createdAt: r.created_at,
  } : null;
}

export async function listGameTransactions({ userId = null, roundId = null, limit = 100 } = {}) {
  const where = []; const params = [];
  if (userId) { params.push(String(userId)); where.push(`user_id = $${params.length}`); }
  if (roundId) { params.push(String(roundId)); where.push(`round_id = $${params.length}`); }
  const { rows } = await pgQuery(
    `SELECT * FROM game_transactions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC LIMIT ${Math.min(Math.max(Number(limit) || 100, 1), 500)}`,
    params, 'game_tx_list',
  );
  return rows.map((r) => ({
    id: Number(r.id), txId: r.tx_id, roundId: r.round_id, sessionId: r.session_id,
    userId: r.user_id, providerKey: r.provider_key, type: r.tx_type,
    amount: paiseToRupees(Number(r.amount_paise)),
    balanceBefore: r.balance_before_paise === null ? null : paiseToRupees(Number(r.balance_before_paise)),
    balanceAfter: r.balance_after_paise === null ? null : paiseToRupees(Number(r.balance_after_paise)),
    gameId: r.game_id, gameName: r.game_name, createdAt: r.created_at,
  }));
}

/**
 * The operator's transaction ledger view: one page and its total, from ONE
 * query.
 *
 * `find()` plus a separate `countDocuments()` are two reads of a table that
 * accepts a provider callback between them, so the total belonged to a
 * different instant than the page — a footer that says 41 above a list whose
 * last page holds 43. `COUNT(*) OVER ()` is computed over the same filtered
 * set in the same snapshot, so the page and its total cannot disagree.
 *
 * The username comes from a LEFT JOIN, not a second round trip per row: a
 * populate over a 30-row page is 30 lookups, and a transaction whose player has
 * since been deleted still has to render.
 */
export async function adminGameTransactions({
  providerKey = null, userId = null, txType = null, page = 1, limit = 30,
} = {}) {
  const where = []; const params = [];
  if (providerKey) { params.push(String(providerKey)); where.push(`t.provider_key = $${params.length}`); }
  if (userId) { params.push(String(userId)); where.push(`t.user_id = $${params.length}`); }
  if (txType) { params.push(String(txType)); where.push(`t.tx_type = $${params.length}`); }

  const size = Math.min(Math.max(Number(limit) || 30, 1), 200);
  const offset = Math.max((Number(page) || 1) - 1, 0) * size;
  params.push(size, offset);

  const { rows } = await pgQuery(
    `SELECT t.*, u.username, u.mobile, COUNT(*) OVER () AS total_rows
       FROM game_transactions t
       LEFT JOIN users u ON u.user_id = t.user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params, 'game_tx_admin_list',
  );

  return {
    total: rows.length ? Number(rows[0].total_rows) : 0,
    page: Math.max(Number(page) || 1, 1),
    limit: size,
    transactions: rows.map((r) => ({
      id: Number(r.id), txId: r.tx_id, roundId: r.round_id, sessionId: r.session_id,
      userId: r.user_id, username: r.username, mobile: r.mobile,
      providerKey: r.provider_key, type: r.tx_type,
      amount: paiseToRupees(Number(r.amount_paise)),
      balanceBefore: r.balance_before_paise === null ? null : paiseToRupees(Number(r.balance_before_paise)),
      balanceAfter: r.balance_after_paise === null ? null : paiseToRupees(Number(r.balance_after_paise)),
      gameId: r.game_id, gameName: r.game_name, createdAt: r.created_at,
    })),
  };
}

// ── Catalogue ───────────────────────────────────────────────────────────────

const toGame = (r) => (r ? {
  slug: r.slug, name: r.name, providerKey: r.provider_key, categorySlug: r.category_slug,
  launchStrategy: r.launch_strategy, externalGameId: r.external_game_id,
  launchUrl: r.launch_url, thumbnail: r.thumbnail, banner: r.banner, badge: r.badge,
  rtp: r.rtp === null ? null : Number(r.rtp), tags: r.tags,
  minBet: paiseToRupees(Number(r.min_bet_paise)),
  maxBet: paiseToRupees(Number(r.max_bet_paise)),
  status: r.status, featured: r.featured, order: r.sort_order,
  createdAt: r.created_at, updatedAt: r.updated_at,
  createdBy: r.created_by, updatedBy: r.updated_by,
} : null);

export async function upsertCategory({ slug, name, icon = null, order = 0, enabled = true, updatedBy = null }) {
  const { rows } = await pgQuery(
    `INSERT INTO game_categories (slug, name, icon, sort_order, enabled, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name, icon = EXCLUDED.icon, sort_order = EXCLUDED.sort_order,
       enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING *`,
    [String(slug), String(name), icon, Number(order) || 0, Boolean(enabled), updatedBy],
    'category_upsert',
  );
  const r = rows[0];
  return { slug: r.slug, name: r.name, icon: r.icon, order: r.sort_order, enabled: r.enabled };
}

export async function listCategories({ enabledOnly = true } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM game_categories ${enabledOnly ? 'WHERE enabled' : ''} ORDER BY sort_order, name`,
    [], 'category_list',
  );
  return rows.map((r) => ({ slug: r.slug, name: r.name, icon: r.icon, order: r.sort_order, enabled: r.enabled }));
}

export async function upsertGame(spec) {
  const { rows } = await pgQuery(
    `INSERT INTO games (slug, name, provider_key, category_slug, launch_strategy,
       external_game_id, launch_url, thumbnail, banner, badge, rtp, tags,
       min_bet_paise, max_bet_paise, status, featured, sort_order, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name, provider_key = EXCLUDED.provider_key,
       category_slug = EXCLUDED.category_slug, launch_strategy = EXCLUDED.launch_strategy,
       external_game_id = EXCLUDED.external_game_id, launch_url = EXCLUDED.launch_url,
       thumbnail = EXCLUDED.thumbnail, banner = EXCLUDED.banner, badge = EXCLUDED.badge,
       rtp = EXCLUDED.rtp, tags = EXCLUDED.tags,
       min_bet_paise = EXCLUDED.min_bet_paise, max_bet_paise = EXCLUDED.max_bet_paise,
       status = EXCLUDED.status, featured = EXCLUDED.featured,
       sort_order = EXCLUDED.sort_order, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING *`,
    [String(spec.slug), String(spec.name), spec.providerKey ?? null, spec.categorySlug ?? null,
      String(spec.launchStrategy || 'PROVIDER'), spec.externalGameId ?? null, spec.launchUrl ?? null,
      spec.thumbnail ?? null, spec.banner ?? null, spec.badge ?? null,
      spec.rtp ?? null, spec.tags ?? [],
      rupeesToPaise(spec.minBet ?? 10), rupeesToPaise(spec.maxBet ?? 100000),
      String(spec.status || 'DRAFT'), Boolean(spec.featured), Number(spec.order) || 0,
      spec.createdBy ?? null, spec.updatedBy ?? null],
    'game_upsert',
  );
  return toGame(rows[0]);
}

export async function getGame(slug) {
  const { rows } = await pgQuery('SELECT * FROM games WHERE slug = $1', [String(slug)], 'game_get');
  return toGame(rows[0]);
}

/**
 * The catalogue.
 *
 * `visibleOnly` means ACTIVE or MAINTENANCE — a game under maintenance is still
 * shown, greyed out, because removing the tile makes players think it is gone
 * for good. Only INACTIVE is hidden.
 */
export async function listGames({
  categorySlug = null, providerKey = null, featuredOnly = false,
  tag = null, search = null, visibleOnly = true, status = null, limit = 200,
} = {}) {
  const where = []; const params = [];
  if (status) { params.push(String(status)); where.push(`status = $${params.length}`); }
  else if (visibleOnly) where.push("status IN ('ACTIVE', 'MAINTENANCE')");
  if (featuredOnly) where.push('featured');
  if (categorySlug) { params.push(String(categorySlug)); where.push(`category_slug = $${params.length}`); }
  if (providerKey) { params.push(String(providerKey)); where.push(`provider_key = $${params.length}`); }
  if (tag) { params.push(String(tag)); where.push(`$${params.length} = ANY(tags)`); }
  if (search) {
    // Anchored, so the index stays usable and a search box cannot be turned
    // into a leading-wildcard scan of the whole catalogue.
    params.push(String(search).slice(0, 60));
    where.push(`name ILIKE $${params.length} || '%'`);
  }
  const { rows } = await pgQuery(
    `SELECT * FROM games ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY featured DESC, sort_order, name
      LIMIT ${Math.min(Math.max(Number(limit) || 200, 1), 1000)}`,
    params, 'game_list',
  );
  return rows.map(toGame);
}

/**
 * Categories with a live count of the games in each.
 *
 * ONE query. It was a category fetch plus a separate aggregation, so a category
 * created between them appeared with a count of zero — and a game moved between
 * categories could be counted twice or not at all.
 */
export async function listCategoriesWithCounts({ enabledOnly = true } = {}) {
  const { rows } = await pgQuery(
    `SELECT c.slug, c.name, c.icon, c.sort_order, c.enabled,
            COUNT(g.slug) FILTER (WHERE g.status IN ('ACTIVE','MAINTENANCE'))::int AS game_count
       FROM game_categories c
       LEFT JOIN games g ON g.category_slug = c.slug
      ${enabledOnly ? 'WHERE c.enabled' : ''}
      GROUP BY c.slug, c.name, c.icon, c.sort_order, c.enabled
      ORDER BY c.sort_order, c.name`,
    [], 'category_list_counts',
  );
  return rows.map((r) => ({
    slug: r.slug, name: r.name, icon: r.icon,
    order: r.sort_order, enabled: r.enabled, gameCount: r.game_count,
  }));
}

/**
 * Delete a category.
 *
 * Refuses while games still reference it, in ONE statement — a count followed
 * by a delete lets a game be assigned in between, and the games are then
 * pointing at a category that no longer exists.
 */
export async function deleteCategory(slug) {
  const { rows } = await pgQuery(
    `DELETE FROM game_categories c
      WHERE c.slug = $1
        AND NOT EXISTS (SELECT 1 FROM games g WHERE g.category_slug = c.slug)
      RETURNING slug`,
    [String(slug)], 'category_delete',
  );
  if (rows.length) return { ok: true };
  const { rows: used } = await pgQuery(
    'SELECT COUNT(*)::int AS n FROM games WHERE category_slug = $1', [String(slug)], 'category_in_use',
  );
  return used[0].n > 0
    ? { ok: false, reason: 'IN_USE', gameCount: used[0].n }
    : { ok: false, reason: 'NOT_FOUND' };
}

export async function setGameStatus(slug, status) {
  const { rows } = await pgQuery(
    'UPDATE games SET status = $2, updated_at = now() WHERE slug = $1 RETURNING *',
    [String(slug), String(status)], 'game_set_status',
  );
  return toGame(rows[0]);
}

export async function deleteGame(slug) {
  const { rowCount } = await pgQuery('DELETE FROM games WHERE slug = $1', [String(slug)], 'game_delete');
  return rowCount > 0;
}
