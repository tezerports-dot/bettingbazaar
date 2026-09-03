// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/casino/webhookSignature.js — the authentication boundary for the
 * game-provider wallet callback.
 *
 * `POST /api/game/wallet/:providerKey` deliberately carries no `authenticate`
 * middleware: the caller is a game provider, not a logged-in user. That makes
 * the HMAC below the ONLY thing between the open internet and the
 * `debitForGameProviderBet()` / `creditWinnings()` / `refundOrder()` calls in
 * gameProvider.routes.js.
 *
 * It lives in its own module, importing nothing but `crypto`, so the unit suite
 * can assert it directly. Importing gameProvider.routes.js instead would pull in
 * auth.middleware → paseto.util, which throws at import time without
 * PASETO_SECRET_KEY — a security boundary should be provable without booting the
 * app's secret gate or the database behind it.
 */
import crypto from 'crypto';

/**
 * Decide whether a provider callback is authentic.
 *
 * Three rules, each of which the previous inline check got wrong:
 *
 *   1. A MISSING signature is a REJECT, not a skip. The old guard was
 *      `if (sig && sig !== expected) return 401`, so an absent `x-signature`
 *      header short-circuited to "no mismatch" and the request proceeded to the
 *      money paths — anyone who could reach the route could credit an arbitrary
 *      balance to any playerId.
 *   2. A provider with NO configured secret is refused, not trusted.
 *      Unverifiable and authentic are not the same thing.
 *   3. The comparison is constant-time, matching how the rest of the codebase
 *      compares secrets (middleware/order-crypto-access.js,
 *      identity/totp.service.js). Lengths are compared first because
 *      `timingSafeEqual` throws when they differ.
 *
 * NOTE — known limitation, deliberately preserved: the digest is taken over
 * `JSON.stringify(body)`, a RE-SERIALISATION of the parsed body rather than the
 * bytes the provider actually signed. Key order and unicode escaping must match
 * the provider's serialiser for a legitimate call to verify. Signing the raw
 * body is the correct fix but changes the wire contract, so it is left to the
 * provider-integration work rather than folded into a security patch.
 *
 * @param {string|undefined} secret   the provider's configured webhookSecret
 * @param {object} headers            request headers (lowercased, as Express gives them)
 * @param {*} body                    the parsed request body
 * @returns {{ok: true} | {ok: false, status: number, message: string}}
 */
export function verifyWebhookSignature(secret, headers = {}, body = undefined) {
  if (!secret) {
    return { ok: false, status: 503, message: 'Provider webhook not configured' };
  }
  const provided = String(headers['x-signature'] || headers['x-hmac'] || '');
  if (!provided) {
    return { ok: false, status: 401, message: 'Missing signature' };
  }
  const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 401, message: 'Invalid signature' };
  }
  return { ok: true };
}
