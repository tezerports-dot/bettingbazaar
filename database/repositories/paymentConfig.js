// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * repositories/paymentConfig.js — merchant token purchases from the platform,
 * and the payment-gateway credentials.
 *
 * A merchant token order is a REQUEST to buy platform inventory with USDT. It
 * moves no money by itself; approving it does, through `adminIssuance`. What
 * this module guarantees is that the decision has an owner: an approved or
 * rejected order names who reviewed it and when, because the row refuses
 * otherwise.
 */
import { pgQuery } from '../client.js';
import { rupeesToPaise, paiseToRupees } from '../../backend/shared/money.js';

const toOrder = (r) => (r ? {
  orderId: r.order_id, _id: r.order_id, merchantId: r.merchant_id,
  tokenAmount: paiseToRupees(Number(r.token_paise)), tokenPaise: Number(r.token_paise),
  usdtRate: r.usdt_rate === null ? null : Number(r.usdt_rate),
  usdtAmount: r.usdt_amount === null ? null : Number(r.usdt_amount),
  usdtTxHash: r.usdt_tx_hash, status: r.status,
  requestedAt: r.requested_at, reviewedAt: r.reviewed_at,
  reviewedBy: r.reviewed_by, reviewNote: r.review_note,
} : null);

export async function createTokenOrder({
  orderId, merchantId, tokenAmountRupees, usdtRate = null, usdtAmount = null, usdtTxHash = null,
}) {
  if (!orderId || !merchantId) throw new Error('createTokenOrder requires an orderId and a merchantId');
  const { rows } = await pgQuery(
    `INSERT INTO merchant_admin_token_orders
       (order_id, merchant_id, token_paise, usdt_rate, usdt_amount, usdt_tx_hash)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (order_id) DO NOTHING
     RETURNING *`,
    [String(orderId), String(merchantId), rupeesToPaise(tokenAmountRupees),
      usdtRate, usdtAmount, usdtTxHash], 'token_order_create',
  );
  return rows[0] ? { ok: true, order: toOrder(rows[0]) } : { ok: true, idempotent: true, order: await getTokenOrder(orderId) };
}

export async function getTokenOrder(orderId) {
  const { rows } = await pgQuery(
    'SELECT * FROM merchant_admin_token_orders WHERE order_id = $1', [String(orderId)],
    'token_order_get',
  );
  return toOrder(rows[0]);
}

/**
 * Approve a token order.
 *
 * Guarded on PENDING in the statement, so two admins reviewing the same request
 * produce one decision rather than a last-write-wins overwrite — and the second
 * is told, instead of believing they approved it. The issuance that follows is
 * keyed on this order id, so it is idempotent even if the caller retries.
 */
export async function approveTokenOrder(orderId, { actor, usdtTxHash = null, note = null }) {
  if (!actor) throw new Error('approveTokenOrder requires an actor');
  const { rows } = await pgQuery(
    `UPDATE merchant_admin_token_orders SET
       status = 'APPROVED', reviewed_by = $2, reviewed_at = now(),
       review_note = $3, usdt_tx_hash = COALESCE($4, usdt_tx_hash)
      WHERE order_id = $1 AND status = 'PENDING'
      RETURNING *`,
    [String(orderId), String(actor), note, usdtTxHash], 'token_order_approve',
  );
  if (rows[0]) return { ok: true, order: toOrder(rows[0]) };
  const current = await getTokenOrder(orderId);
  return current
    ? { ok: false, reason: 'ALREADY_REVIEWED', status: current.status }
    : { ok: false, reason: 'NOT_FOUND' };
}

/** Reject one, with the reason the row requires. */
export async function rejectTokenOrder(orderId, { actor, note }) {
  if (!String(note ?? '').trim()) throw new Error('rejectTokenOrder requires a note');
  const { rows } = await pgQuery(
    `UPDATE merchant_admin_token_orders SET
       status = 'REJECTED', reviewed_by = $2, reviewed_at = now(), review_note = $3
      WHERE order_id = $1 AND status = 'PENDING'
      RETURNING *`,
    [String(orderId), String(actor), String(note).trim()], 'token_order_reject',
  );
  return rows[0] ? { ok: true, order: toOrder(rows[0]) } : { ok: false, reason: 'ALREADY_REVIEWED_OR_MISSING' };
}

export async function listTokenOrders({ merchantId = null, status = null, limit = 100 } = {}) {
  const where = []; const params = [];
  if (merchantId) { params.push(String(merchantId)); where.push(`merchant_id = $${params.length}`); }
  if (status) { params.push(String(status)); where.push(`status = $${params.length}`); }
  const { rows } = await pgQuery(
    `SELECT * FROM merchant_admin_token_orders
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY requested_at DESC LIMIT ${Math.min(Math.max(Number(limit) || 100, 1), 500)}`,
    params, 'token_order_list',
  );
  return rows.map(toOrder);
}

/** The review queue, oldest first. */
export async function listPendingTokenOrders({ limit = 100 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM merchant_admin_token_orders WHERE status = 'PENDING'
      ORDER BY requested_at ASC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 100, 1), 500)], 'token_order_queue',
  );
  return rows.map(toOrder);
}

// ── Gateway configuration ───────────────────────────────────────────────────

const toGatewayConfig = (r) => (r ? {
  key: r.config_key, activeMode: r.active_mode,
  p2pEnabled: r.p2p_enabled, gatewayEnabled: r.gateway_enabled,
  gatewayProvider: r.gateway_provider,
  gatewayCallbackUrl: r.gateway_callback_url,
  gatewayMerchantId: r.gateway_merchant_id,
  updatedBy: r.updated_by, updatedAt: r.updated_at,
} : null);

/**
 * The gateway settings a panel renders.
 *
 * Credentials are NOT here — see `getGatewaySecrets`. A settings screen that
 * ships an API secret to a browser has published it, whatever the field is
 * labelled.
 */
export async function getGatewayConfig(key = 'main') {
  const { rows } = await pgQuery(
    'SELECT * FROM payment_gateway_configs WHERE config_key = $1', [String(key)],
    'gateway_config_get',
  );
  // Never null: a platform with no row configured is P2P-only, which is what a
  // fresh install genuinely is.
  return toGatewayConfig(rows[0]) ?? {
    key, activeMode: 'P2P', p2pEnabled: true, gatewayEnabled: false,
    gatewayProvider: null, gatewayCallbackUrl: null, gatewayMerchantId: null,
    updatedBy: null, updatedAt: null,
  };
}

/** The credentials, for the code that calls the gateway. Asked for by name. */
export async function getGatewaySecrets(key = 'main') {
  const { rows } = await pgQuery(
    `SELECT gateway_api_key_encrypted, gateway_api_secret_encrypted,
            gateway_webhook_secret_encrypted, gateway_merchant_id, gateway_callback_url
       FROM payment_gateway_configs WHERE config_key = $1`,
    [String(key)], 'gateway_secrets',
  );
  const r = rows[0];
  return r ? {
    apiKeyEncrypted: r.gateway_api_key_encrypted,
    apiSecretEncrypted: r.gateway_api_secret_encrypted,
    webhookSecretEncrypted: r.gateway_webhook_secret_encrypted,
    merchantId: r.gateway_merchant_id, callbackUrl: r.gateway_callback_url,
  } : null;
}

/**
 * Change the gateway settings.
 *
 * The row refuses to have BOTH rails off: an admin who turns off P2P and the
 * gateway together leaves no way for a player to fund an account, and finds out
 * from the support queue rather than from the form. A null credential means
 * "unchanged", so editing the callback URL cannot silently wipe the API key.
 */
export async function setGatewayConfig({
  key = 'main', activeMode, p2pEnabled, gatewayEnabled, gatewayProvider,
  apiKeyEncrypted = null, apiSecretEncrypted = null, webhookSecretEncrypted = null,
  callbackUrl, merchantId, updatedBy = null,
}) {
  const { rows } = await pgQuery(
    `INSERT INTO payment_gateway_configs (config_key, active_mode, p2p_enabled,
       gateway_enabled, gateway_provider, gateway_api_key_encrypted,
       gateway_api_secret_encrypted, gateway_webhook_secret_encrypted,
       gateway_callback_url, gateway_merchant_id, updated_by)
     VALUES ($1, COALESCE($2,'P2P'), COALESCE($3,TRUE), COALESCE($4,FALSE),
             $5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (config_key) DO UPDATE SET
       active_mode     = COALESCE(EXCLUDED.active_mode, payment_gateway_configs.active_mode),
       p2p_enabled     = COALESCE($3, payment_gateway_configs.p2p_enabled),
       gateway_enabled = COALESCE($4, payment_gateway_configs.gateway_enabled),
       gateway_provider = COALESCE(EXCLUDED.gateway_provider, payment_gateway_configs.gateway_provider),
       gateway_api_key_encrypted = COALESCE(EXCLUDED.gateway_api_key_encrypted,
                                            payment_gateway_configs.gateway_api_key_encrypted),
       gateway_api_secret_encrypted = COALESCE(EXCLUDED.gateway_api_secret_encrypted,
                                               payment_gateway_configs.gateway_api_secret_encrypted),
       gateway_webhook_secret_encrypted = COALESCE(EXCLUDED.gateway_webhook_secret_encrypted,
                                                   payment_gateway_configs.gateway_webhook_secret_encrypted),
       gateway_callback_url = COALESCE(EXCLUDED.gateway_callback_url, payment_gateway_configs.gateway_callback_url),
       gateway_merchant_id  = COALESCE(EXCLUDED.gateway_merchant_id, payment_gateway_configs.gateway_merchant_id),
       updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING *`,
    [String(key), activeMode ?? null,
      p2pEnabled === undefined ? null : Boolean(p2pEnabled),
      gatewayEnabled === undefined ? null : Boolean(gatewayEnabled),
      gatewayProvider ?? null, apiKeyEncrypted, apiSecretEncrypted, webhookSecretEncrypted,
      callbackUrl ?? null, merchantId ?? null, updatedBy],
    'gateway_config_set',
  );
  return toGatewayConfig(rows[0]);
}
