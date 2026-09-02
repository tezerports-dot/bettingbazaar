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

export async function listProviders({ enabledOnly = false } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM game_providers ${enabledOnly ? 'WHERE enabled' : ''} ORDER BY name`,
    [], 'provider_list',
  );
  return rows.map(toProvider);
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

/** The lobby. Only LIVE games, which the row guarantees are launchable. */
export async function listGames({ categorySlug = null, featuredOnly = false, liveOnly = true, limit = 200 } = {}) {
  const where = []; const params = [];
  if (liveOnly) where.push("status = 'LIVE'");
  if (featuredOnly) where.push('featured');
  if (categorySlug) { params.push(String(categorySlug)); where.push(`category_slug = $${params.length}`); }
  const { rows } = await pgQuery(
    `SELECT * FROM games ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY sort_order, name LIMIT ${Math.min(Math.max(Number(limit) || 200, 1), 1000)}`,
    params, 'game_list',
  );
  return rows.map(toGame);
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
