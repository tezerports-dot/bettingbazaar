// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * btcpaySignature.js — the authentication boundary for the USDT deposit
 * callback.
 *
 * `POST /api/payment/usdt/webhook` carries no `authenticate` middleware: the
 * caller is BTCPay Server, not a logged-in user. That makes the HMAC below the
 * ONLY thing between the open internet and a MINT — the movement that creates
 * tokens out of nothing and puts them in a player's wallet.
 *
 * It lives in its own module importing nothing but `crypto`, exactly as
 * `domains/casino/webhookSignature.js` does, so the unit suite can assert it
 * without booting the app's secret gate or the database behind it. A security
 * boundary that can only be tested through a running server is a boundary
 * nobody tests.
 *
 * ── Over the RAW BYTES, not a re-serialisation ─────────────────────────────
 * The casino verifier digests `JSON.stringify(body)` — the parsed body turned
 * back into text — and its own header records that as a known limitation: key
 * order and unicode escaping have to match the sender's serialiser or a
 * legitimate call fails. That is a correctness bug waiting on a wire-contract
 * change there. It is not repeated here: this route is mounted with a raw body
 * parser and verifies the bytes BTCPay actually signed.
 *
 * ── What a valid signature does and does not prove ─────────────────────────
 * It proves the body came from something holding the webhook secret. It does
 * NOT prove the body is fresh — anyone who captures one delivery can replay it
 * unchanged, forever, and it will verify. Replay is therefore not handled here
 * at all; it is handled where it belongs, by the guarded transition and the
 * UNIQUE `tx_id` in `usdt_deposits`, which is the same gate a duplicate BTCPay
 * retry meets. A signature check that tried to also be a freshness check would
 * need a clock and a nonce store, and would still leave the retry case to the
 * database.
 */
import crypto from 'crypto';

/** BTCPay sends `BTCPay-Sig: sha256=<hex>`. */
const PREFIX = 'sha256=';

/**
 * Decide whether a BTCPay callback is authentic.
 *
 * @param {string|undefined} secret  the configured webhook secret
 * @param {object} headers           request headers, lowercased as Express gives them
 * @param {Buffer|string} rawBody    the bytes as received, NOT a parsed object
 * @returns {{ok: true} | {ok: false, status: number, message: string}}
 */
export function verifyBtcpaySignature(secret, headers = {}, rawBody = undefined) {
  // Unverifiable and authentic are not the same thing. With no secret
  // configured every delivery is unverifiable, so every delivery is refused —
  // never "no secret, no mismatch, carry on", which is how a route that mints
  // tokens ends up open to anyone who can reach it.
  if (!secret) {
    return { ok: false, status: 503, message: 'USDT webhook not configured' };
  }
  // A MISSING signature is a REJECT, not a skip.
  const provided = String(headers['btcpay-sig'] || '');
  if (!provided) {
    return { ok: false, status: 401, message: 'Missing signature' };
  }
  if (!provided.startsWith(PREFIX)) {
    return { ok: false, status: 401, message: 'Malformed signature' };
  }
  // Raw bytes. A Buffer passes through untouched; a string is read as utf8,
  // which is what it was when it arrived.
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  if (!body.length) {
    return { ok: false, status: 400, message: 'Empty body' };
  }

  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const a = Buffer.from(provided.slice(PREFIX.length).toLowerCase(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // Lengths first: `timingSafeEqual` THROWS when they differ, and a throw here
  // would be a 500 on a forged signature rather than a 401.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, status: 401, message: 'Invalid signature' };
  }
  return { ok: true };
}

/** The signature BTCPay would send for these bytes. Used by the tests. */
export function signBtcpayBody(secret, rawBody) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  return `${PREFIX}${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}
