// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
