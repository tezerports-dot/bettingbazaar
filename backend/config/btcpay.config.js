// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * config/btcpay.config.js — where the USDT rail's credentials come from.
 *
 * ── Env, not the admin panel, and the split is not arbitrary ───────────────
 * The API key and the webhook secret are DEPLOYMENT SECRETS: whoever holds them
 * can create invoices on the platform's store and, with the webhook secret,
 * sign a callback that mints tokens. A stolen admin session must not be able to
 * read them back or repoint them, which is exactly what putting them in
 * `system_config` would allow — every other admin-editable value on this
 * platform is readable by an admin, by design.
 *
 * What IS admin-editable stays admin-editable and lives where it already lives:
 * the USDT price per token is `usdtPricing.userMerchantBuyInr`, read through
 * `tokenRates.js`, one owner. Nothing about the price is duplicated here.
 *
 * ── Absent is a valid state ────────────────────────────────────────────────
 * A deployment with no BTCPay configured is not broken. `configured()` is
 * false, the provider adapter reports itself inactive, the create route answers
 * 503 with a sentence a player can act on, and the webhook refuses everything —
 * rather than the rail half-working and a player paying an invoice nothing on
 * this side can settle.
 */

const trim = (v) => String(v ?? '').trim();

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const btcpay = {
  /** The BTCPay Server base URL, e.g. https://pay.example.com */
  serverUrl: trim(process.env.BTCPAY_SERVER_URL).replace(/\/+$/, ''),
  /** The store the invoices belong to. */
  storeId: trim(process.env.BTCPAY_STORE_ID),
  /** Greenfield API key. Sent as `Authorization: token <key>`. */
  apiKey: trim(process.env.BTCPAY_API_KEY),
  /** The HMAC secret BTCPay signs callbacks with. */
  webhookSecret: trim(process.env.BTCPAY_WEBHOOK_SECRET),
  /**
   * What the invoice is DENOMINATED in on the BTCPay side. The store decides
   * which chains and tokens can actually pay it; this is only the unit of the
   * amount we ask for.
   */
  invoiceCurrency: trim(process.env.BTCPAY_INVOICE_CURRENCY) || 'USDT',
  /**
   * How long a player has to pay, in minutes. Crypto confirmation times are not
   * UPI's — the merchant rails measure this window in minutes because a person
   * is waiting at a machine; here the wait is a chain's.
   */
  invoiceExpiryMinutes: positiveInteger(process.env.BTCPAY_INVOICE_EXPIRY_MINUTES, 60),
};

/**
 * True when every credential needed to both CREATE and SETTLE an invoice is
 * present.
 *
 * All four together, deliberately. A deployment with a server URL and an API
 * key but no webhook secret can create invoices a player can pay and can never
 * confirm one — it would take money and credit nothing, which is worse than
 * refusing to start.
 */
export function btcpayConfigured(cfg = btcpay) {
  return Boolean(cfg.serverUrl && cfg.storeId && cfg.apiKey && cfg.webhookSecret);
}
