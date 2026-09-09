// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * The authentication boundary for the USDT deposit callback.
 *
 * `POST /api/payment/usdt/webhook` carries no session. This HMAC is the ONLY
 * thing between the open internet and a MINT — the movement that creates tokens
 * from nothing and puts them in a player's wallet — so the failure modes are
 * asserted one at a time rather than trusted to review.
 *
 * The one that matters most is the FIRST test below. The inline check this
 * pattern replaced elsewhere in this codebase was `if (sig && sig !== expected)
 * return 401`, so an ABSENT header short-circuited to "no mismatch" and the
 * request walked straight into the money path. A missing signature must be a
 * reject, and "no secret configured" must be a reject too: unverifiable and
 * authentic are not the same thing.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { verifyBtcpaySignature, signBtcpayBody } from '../../domains/funding/btcpaySignature.js';

const SECRET = 'a-webhook-secret-that-is-long-enough';
const BODY = JSON.stringify({ type: 'InvoiceSettled', invoiceId: 'INV_1', deliveryId: 'D1' });
const headersFor = (body, secret = SECRET) => ({ 'btcpay-sig': signBtcpayBody(secret, body) });

describe('the BTCPay callback signature', () => {
  it('accepts a body signed with the configured secret', () => {
    expect(verifyBtcpaySignature(SECRET, headersFor(BODY), BODY)).toEqual({ ok: true });
  });

  it('accepts the same body as a Buffer, because that is how it arrives', () => {
    const buf = Buffer.from(BODY, 'utf8');
    expect(verifyBtcpaySignature(SECRET, headersFor(buf), buf)).toEqual({ ok: true });
  });

  // ── The rejects ──────────────────────────────────────────────────────────
  it('REFUSES a missing signature rather than skipping the check', () => {
    const r = verifyBtcpaySignature(SECRET, {}, BODY);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  it('REFUSES when no secret is configured — unverifiable is not authentic', () => {
    const r = verifyBtcpaySignature('', headersFor(BODY), BODY);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
  });

  it('refuses a signature made with a different secret', () => {
    const r = verifyBtcpaySignature(SECRET, headersFor(BODY, 'some-other-secret'), BODY);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  it('refuses a body altered after signing — one byte is enough', () => {
    const headers = headersFor(BODY);
    const tampered = BODY.replace('INV_1', 'INV_2');
    expect(verifyBtcpaySignature(SECRET, headers, tampered).ok).toBe(false);
  });

  it('refuses a signature with no sha256= prefix', () => {
    const bare = signBtcpayBody(SECRET, BODY).replace('sha256=', '');
    const r = verifyBtcpaySignature(SECRET, { 'btcpay-sig': bare }, BODY);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  it('refuses an empty body', () => {
    const r = verifyBtcpaySignature(SECRET, { 'btcpay-sig': signBtcpayBody(SECRET, '') }, '');
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it('answers 401, not 500, when the signature is the wrong LENGTH', () => {
    // `crypto.timingSafeEqual` THROWS on differing lengths. Without the length
    // check first, a forged short signature is an unhandled exception the
    // route's catch turns into a 500 — which tells an attacker their input
    // reached something, and looks like an outage rather than an attack.
    const r = verifyBtcpaySignature(SECRET, { 'btcpay-sig': 'sha256=abc' }, BODY);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });

  it('accepts an upper-case hex digest, because hex has no case', () => {
    const upper = signBtcpayBody(SECRET, BODY).replace(/[0-9a-f]+$/, (h) => h.toUpperCase());
    expect(verifyBtcpaySignature(SECRET, { 'btcpay-sig': upper }, BODY).ok).toBe(true);
  });

  // ── What a valid signature does NOT prove ────────────────────────────────
  it('verifies a REPLAY of a real delivery — freshness is not its job', () => {
    // Stated as a test because it is the reason the deposit row carries a
    // guarded transition and a UNIQUE tx_id. Anyone who captures one signed
    // body can send it again, forever, and it will verify here. What stops the
    // second one crediting anybody is the database, not this function.
    const headers = headersFor(BODY);
    expect(verifyBtcpaySignature(SECRET, headers, BODY).ok).toBe(true);
    expect(verifyBtcpaySignature(SECRET, headers, BODY).ok).toBe(true);
  });

  it('digests the RAW BYTES, not a re-serialisation of the parsed body', () => {
    // BTCPay signs what it sent. A verifier that re-serialised the parsed
    // object would depend on our JSON writer matching theirs — key order,
    // unicode escaping, spacing — and would reject legitimate callbacks whose
    // bytes differ from what `JSON.stringify` would produce for the same data.
    const spaced = '{ "type": "InvoiceSettled",  "invoiceId": "INV_1" }';
    expect(verifyBtcpaySignature(SECRET, headersFor(spaced), spaced).ok).toBe(true);
    // The same DATA, serialised our way, is a different byte string and does
    // not verify against that signature.
    const ours = JSON.stringify(JSON.parse(spaced));
    expect(ours).not.toBe(spaced);
    expect(verifyBtcpaySignature(SECRET, headersFor(spaced), ours).ok).toBe(false);
  });

  it('signs the way BTCPay does — HMAC-SHA256, hex, sha256= prefixed', () => {
    const expected = crypto.createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(signBtcpayBody(SECRET, BODY)).toBe(`sha256=${expected}`);
  });
});
