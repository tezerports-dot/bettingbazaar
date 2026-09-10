// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * POST /api/game/wallet/:providerKey is an UNAUTHENTICATED route that reaches
 * creditWinnings() and refundOrder() — the HMAC is its entire access control.
 *
 * The guard used to read `if (sig && sig !== expected) return 401`, so a request
 * with NO signature header fell through to the money paths. The first test below
 * is that bypass; it fails against the old guard and passes against the current
 * one.
 *
 * These assert the boundary function directly rather than through the route,
 * because the route needs a live database and an authentication boundary
 * should be provable without one.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { verifyWebhookSignature } from '../../domains/casino/webhookSignature.js';

const SECRET = 'provider-webhook-secret';
const BODY = { transactionId: 'tx-1', playerId: 'u1', type: 'WIN', amount: 5000 };
const sign = (secret, body) =>
  crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');

describe('game provider webhook signature', () => {
  it('rejects a request that omits the signature header entirely', () => {
    // The bypass: no header at all used to mean "nothing to compare, proceed".
    expect(verifyWebhookSignature(SECRET, {}, BODY)).toMatchObject({ ok: false, status: 401 });
  });

  it('rejects an empty signature header', () => {
    expect(verifyWebhookSignature(SECRET, { 'x-signature': '' }, BODY))
      .toMatchObject({ ok: false, status: 401 });
  });

  it('rejects a provider with no configured secret rather than trusting it', () => {
    expect(verifyWebhookSignature('', { 'x-signature': 'anything' }, BODY))
      .toMatchObject({ ok: false, status: 503 });
    expect(verifyWebhookSignature(undefined, { 'x-signature': 'anything' }, BODY))
      .toMatchObject({ ok: false, status: 503 });
  });

  it('rejects a signature computed with the wrong secret', () => {
    expect(verifyWebhookSignature(SECRET, { 'x-signature': sign('wrong-secret', BODY) }, BODY))
      .toMatchObject({ ok: false, status: 401 });
  });

  it('rejects a valid signature replayed against a tampered body', () => {
    const sig = sign(SECRET, BODY);
    const tampered = { ...BODY, amount: 50_000_000 };
    expect(verifyWebhookSignature(SECRET, { 'x-signature': sig }, tampered))
      .toMatchObject({ ok: false, status: 401 });
  });

  it('rejects a truncated signature (length mismatch must not throw)', () => {
    const sig = sign(SECRET, BODY).slice(0, 32);
    expect(() => verifyWebhookSignature(SECRET, { 'x-signature': sig }, BODY)).not.toThrow();
    expect(verifyWebhookSignature(SECRET, { 'x-signature': sig }, BODY))
      .toMatchObject({ ok: false, status: 401 });
  });

  it('accepts a correctly signed request', () => {
    expect(verifyWebhookSignature(SECRET, { 'x-signature': sign(SECRET, BODY) }, BODY))
      .toEqual({ ok: true });
  });

  it('accepts the x-hmac header alias providers also send', () => {
    expect(verifyWebhookSignature(SECRET, { 'x-hmac': sign(SECRET, BODY) }, BODY))
      .toEqual({ ok: true });
  });
});

describe('the raw bytes the provider actually signed', () => {
  // The digest used to be taken ONLY over JSON.stringify(body), a
  // re-serialisation. Key order, whitespace and unicode escaping all have to
  // match the provider's serialiser for a legitimate call to verify — so a
  // correct caller could be rejected. Both encodings are accepted now.
  const raw = '{"amount":100,"transactionId":"t1"}';
  const reordered = '{ "transactionId":"t1",  "amount":100 }';
  const parsed = JSON.parse(raw);
  const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('hex');

  it('accepts a signature over the RAW bytes, whatever key order they used', () => {
    // Signed over bytes whose key order and spacing differ from ours. Before
    // this, every callback from such a provider was a 401.
    const parsedFromReordered = JSON.parse(reordered);
    const verdict = verifyWebhookSignature(
      SECRET, { 'x-signature': sign(reordered) }, parsedFromReordered, reordered,
    );
    expect(verdict).toEqual({ ok: true });
  });

  it('still accepts a signature over the re-serialisation — nothing regresses', () => {
    const verdict = verifyWebhookSignature(
      SECRET, { 'x-signature': sign(JSON.stringify(parsed)) }, parsed, raw,
    );
    expect(verdict).toEqual({ ok: true });
  });

  it('works when no raw body was captured at all', () => {
    const verdict = verifyWebhookSignature(
      SECRET, { 'x-signature': sign(JSON.stringify(parsed)) }, parsed, undefined,
    );
    expect(verdict).toEqual({ ok: true });
  });

  it('accepting two encodings does NOT accept a wrong signature', () => {
    // The point being asserted: an attacker aiming at either message still has
    // to produce an HMAC under a secret they do not hold.
    for (const bad of [sign('something else'), 'deadbeef', crypto.createHmac('sha256', 'wrong-secret').update(raw).digest('hex')]) {
      expect(verifyWebhookSignature(SECRET, { 'x-signature': bad }, parsed, raw))
        .toMatchObject({ ok: false, status: 401 });
    }
  });

  it('an empty raw buffer falls through to the re-serialisation rather than matching', () => {
    const verdict = verifyWebhookSignature(
      SECRET, { 'x-signature': sign(JSON.stringify(parsed)) }, parsed, Buffer.alloc(0),
    );
    expect(verdict).toEqual({ ok: true });
  });
});
