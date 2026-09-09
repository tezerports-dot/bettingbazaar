// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * btcpay.client.js — the outbound half of the USDT rail: BTCPay's Greenfield
 * API, and nothing else.
 *
 * Separated from `usdtDeposit.service.js` for the reason the signature module
 * is separated from the route: this is the part that talks to a machine on the
 * internet, and the part that decides who gets tokens should be testable
 * without it. The service takes this as an injectable dependency, so the money
 * tests run against a stub and this module's own tests assert the wire shape.
 *
 * ── Through the central client, so the egress policy applies ───────────────
 * `networkClient` validates the destination against `outboundGuard`: http/https
 * only, every resolved address must be public unicast, and every redirect hop
 * is re-checked. That matters here because `BTCPAY_SERVER_URL` is operator
 * configuration, and an operator-configured URL pointed at 169.254.169.254 is
 * the classic way a stolen admin session reads cloud credentials. A self-hosted
 * BTCPay on a private network is a legitimate deployment and needs
 * `OUTBOUND_ALLOW_PRIVATE=true` — an explicit decision, not a silent default.
 *
 * ── Failures are named, not swallowed ──────────────────────────────────────
 * Every path either returns a result or throws with a `status`. A create that
 * quietly returns null would leave a player looking at a screen that says
 * nothing while a row sits in AWAITING_PAYMENT with no invoice — the
 * empty-state-as-success failure this codebase has shipped repeatedly.
 */
import { networkClient } from '../../services/networkClient.js';
import { btcpay as defaultConfig, btcpayConfigured } from '../../config/btcpay.config.js';

const notConfigured = () => Object.assign(
  new Error('USDT deposits are not available right now.'),
  { status: 503, code: 'USDT_NOT_CONFIGURED' },
);

/**
 * Create an invoice for one deposit.
 *
 * `metadata.depositId` is what ties BTCPay's invoice back to our row. The
 * webhook carries the invoice id and we resolve through the unique index on
 * `invoice_id`; the metadata is belt and braces for a human reading the BTCPay
 * dashboard during an incident.
 *
 * @returns {Promise<{invoiceId: string, checkoutLink: string|null, expiresAt: Date|null}>}
 */
export async function createInvoice({
  depositId, amount, currency, expiryMinutes, redirectUrl = null,
}, { config = defaultConfig, client = networkClient } = {}) {
  if (!btcpayConfigured(config)) throw notConfigured();

  const response = await client.request(
    `${config.serverUrl}/api/v1/stores/${encodeURIComponent(config.storeId)}/invoices`,
    {
      method: 'POST',
      headers: {
        // Greenfield's scheme. Not `Bearer` — a wrong scheme is a 401 that
        // reads like a bad key.
        authorization: `token ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        amount: String(amount),
        currency,
        metadata: { depositId, orderId: depositId },
        checkout: {
          expirationMinutes: expiryMinutes,
          ...(redirectUrl ? { redirectURL: redirectUrl } : {}),
        },
      }),
    },
  );

  if (!response?.ok) {
    const detail = await safeText(response);
    throw Object.assign(
      new Error('Could not create a USDT invoice. Try again in a moment.'),
      { status: 502, code: 'BTCPAY_CREATE_FAILED', detail, upstreamStatus: response?.status ?? null },
    );
  }

  const invoice = await response.json();
  // An invoice with no id is not an invoice. Refusing here is what stops a row
  // being marked as having one when the player has nothing to pay.
  if (!invoice?.id) {
    throw Object.assign(
      new Error('Could not create a USDT invoice. Try again in a moment.'),
      { status: 502, code: 'BTCPAY_NO_INVOICE_ID' },
    );
  }

  return {
    invoiceId: String(invoice.id),
    checkoutLink: invoice.checkoutLink ? String(invoice.checkoutLink) : null,
    // BTCPay reports `expirationTime` in SECONDS since the epoch. Multiplying is
    // not optional: read as milliseconds it lands in 1970 and every invoice is
    // already expired the moment it is created.
    expiresAt: Number.isFinite(Number(invoice.expirationTime))
      ? new Date(Number(invoice.expirationTime) * 1000)
      : null,
  };
}

/**
 * Read one invoice back from BTCPay.
 *
 * The reconciliation path: a webhook that never arrived (BTCPay down, our
 * endpoint down, a delivery dropped) leaves a paid invoice and an uncredited
 * player, and no amount of waiting fixes it. This is how a sweeper or an admin
 * asks the authority rather than assuming.
 */
export async function getInvoice(invoiceId, { config = defaultConfig, client = networkClient } = {}) {
  if (!btcpayConfigured(config)) throw notConfigured();

  const response = await client.request(
    `${config.serverUrl}/api/v1/stores/${encodeURIComponent(config.storeId)}`
    + `/invoices/${encodeURIComponent(invoiceId)}`,
    { method: 'GET', headers: { authorization: `token ${config.apiKey}` } },
  );
  if (response?.status === 404) return null;
  if (!response?.ok) {
    throw Object.assign(
      new Error('Could not read the USDT invoice.'),
      { status: 502, code: 'BTCPAY_READ_FAILED', upstreamStatus: response?.status ?? null },
    );
  }
  const invoice = await response.json();
  return { invoiceId: String(invoice?.id ?? invoiceId), status: String(invoice?.status ?? '') };
}

/** Upstream error text, best effort — a failure to read it must not mask the failure. */
async function safeText(response) {
  try { return (await response.text()).slice(0, 500); } catch { return null; }
}
