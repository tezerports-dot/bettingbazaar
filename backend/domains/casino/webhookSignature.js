// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
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
 * ── The raw bytes, and why BOTH encodings are accepted ────────────────────
 * The digest used to be taken only over `JSON.stringify(body)` — a
 * RE-SERIALISATION of the parsed body rather than the bytes the provider
 * actually signed. Key order, whitespace and unicode escaping all have to match
 * the provider's serialiser for a legitimate call to verify, so a correct
 * caller could be rejected. The file recorded that as a known limitation and
 * deferred the fix because signing the raw body changes the wire contract.
 *
 * It is resolved here without changing that contract: when the raw bytes are
 * available the digest is checked against THEM first, and against the
 * re-serialisation second. That is a superset — every callback that verified
 * before still verifies, and one signed over the real bytes now verifies too.
 *
 * Accepting two encodings does not weaken anything. An attacker has to produce
 * a valid HMAC under a secret they do not hold; being allowed to aim at either
 * of two messages does not help them compute one.
 *
 * @param {string|undefined} secret   the provider's configured webhookSecret
 * @param {object} headers            request headers (lowercased, as Express gives them)
 * @param {*} body                    the parsed request body
 * @param {Buffer|string} [rawBody]   the exact bytes received, when captured
 * @returns {{ok: true} | {ok: false, status: number, message: string}}
 */
export function verifyWebhookSignature(secret, headers = {}, body = undefined, rawBody = undefined) {
  if (!secret) {
    return { ok: false, status: 503, message: 'Provider webhook not configured' };
  }
  const provided = String(headers['x-signature'] || headers['x-hmac'] || '');
  if (!provided) {
    return { ok: false, status: 401, message: 'Missing signature' };
  }
  // The raw bytes first when we have them, the re-serialisation second.
  const candidates = [];
  if (rawBody !== undefined && rawBody !== null && rawBody.length) candidates.push(rawBody);
  candidates.push(JSON.stringify(body));

  const a = Buffer.from(provided);
  for (const payload of candidates) {
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const b = Buffer.from(expected);
    // Length first: timingSafeEqual throws when the buffers differ in size.
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { ok: true };
  }
  return { ok: false, status: 401, message: 'Invalid signature' };
}
