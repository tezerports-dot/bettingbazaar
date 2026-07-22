// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Order integrity HMAC must survive ORDER_HMAC_SECRET rotation: orders signed
// under the old secret must still verify (via ORDER_HMAC_PREVIOUS_SECRETS) so a
// rotation never 403s in-flight payment orders — the same overlap the PASETO and
// Aadhaar secrets already have. These tests pin that behaviour and the integrity
// guarantee (a hash from an unknown secret, or a wrong/tampered hash, is rejected).
import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { deriveOrderHmac, verifyOrderHmac } from '../../middleware/order-crypto-access.js';

const originalCurrent  = process.env.ORDER_HMAC_SECRET;
const originalPrevious = process.env.ORDER_HMAC_PREVIOUS_SECRETS;

afterEach(() => {
  if (originalCurrent === undefined) delete process.env.ORDER_HMAC_SECRET;
  else process.env.ORDER_HMAC_SECRET = originalCurrent;
  if (originalPrevious === undefined) delete process.env.ORDER_HMAC_PREVIOUS_SECRETS;
  else process.env.ORDER_HMAC_PREVIOUS_SECRETS = originalPrevious;
});

// Re-derive a stored hash exactly the way the module does, under an arbitrary secret.
const hmacWith = (secret, orderId) =>
  crypto.createHmac('sha256', secret).update(`order:${orderId}:v1`).digest('hex');

describe('order HMAC integrity + rotation', () => {
  it('derives a 64-char hex, deterministic per orderId under the active secret', () => {
    process.env.ORDER_HMAC_SECRET = 'current-order-secret';
    delete process.env.ORDER_HMAC_PREVIOUS_SECRETS;
    expect(deriveOrderHmac('ORD-1')).toHaveLength(64);
    expect(deriveOrderHmac('ORD-1')).toBe(deriveOrderHmac('ORD-1'));
    expect(deriveOrderHmac('ORD-1')).not.toBe(deriveOrderHmac('ORD-2'));
  });

  it('verifies a hash signed under the current secret', () => {
    process.env.ORDER_HMAC_SECRET = 'current-order-secret';
    delete process.env.ORDER_HMAC_PREVIOUS_SECRETS;
    expect(verifyOrderHmac('ORD-1', deriveOrderHmac('ORD-1'))).toBe(true);
  });

  it('still verifies orders signed under the OLD secret after rotation', () => {
    const oldHash = hmacWith('old-order-secret', 'ORD-9');   // order created pre-rotation
    process.env.ORDER_HMAC_SECRET = 'new-order-secret';       // rotate the active secret…
    process.env.ORDER_HMAC_PREVIOUS_SECRETS = 'old-order-secret'; // …retain the old one
    expect(verifyOrderHmac('ORD-9', oldHash)).toBe(true);
    expect(verifyOrderHmac('ORD-9', deriveOrderHmac('ORD-9'))).toBe(true); // new signs verify too
  });

  it('accepts any of several comma-separated retained rotation secrets (trimmed)', () => {
    const gen1 = hmacWith('gen1', 'ORD-7');
    process.env.ORDER_HMAC_SECRET = 'gen3';
    process.env.ORDER_HMAC_PREVIOUS_SECRETS = 'gen2, gen1';
    expect(verifyOrderHmac('ORD-7', gen1)).toBe(true);
  });

  it('rejects a hash from a secret that is neither current nor retained', () => {
    process.env.ORDER_HMAC_SECRET = 'current-order-secret';
    process.env.ORDER_HMAC_PREVIOUS_SECRETS = 'old-order-secret';
    expect(verifyOrderHmac('ORD-1', hmacWith('attacker-secret', 'ORD-1'))).toBe(false);
  });

  it('rejects a wrong-order, empty, null, or malformed-length hash', () => {
    process.env.ORDER_HMAC_SECRET = 'current-order-secret';
    delete process.env.ORDER_HMAC_PREVIOUS_SECRETS;
    expect(verifyOrderHmac('ORD-1', deriveOrderHmac('ORD-2'))).toBe(false);
    expect(verifyOrderHmac('ORD-1', '')).toBe(false);
    expect(verifyOrderHmac('ORD-1', null)).toBe(false);
    expect(verifyOrderHmac('ORD-1', 'deadbeef')).toBe(false);
  });
});
