// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for inter-service auth (CAP-73). The secret is read lazily at
// mint/verify time, so setting it in beforeEach is enough.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { mintServiceToken, verifyServiceToken, serviceAuthConfigured } from '../../gateway/serviceAuth.js';

let saved;
beforeEach(() => { saved = process.env.SERVICE_JWT_SECRET; process.env.SERVICE_JWT_SECRET = 'svc-secret'; });
afterEach(() => { if (saved === undefined) delete process.env.SERVICE_JWT_SECRET; else process.env.SERVICE_JWT_SECRET = saved; });

describe('serviceAuth', () => {
  it('mint → verify round trip carries the caller identity', () => {
    const t = mintServiceToken({ from: 'payment', to: 'wallet' });
    const r = verifyServiceToken(t, 'wallet');
    expect(r.ok).toBe(true);
    expect(r.from).toBe('payment');
  });

  it('rejects a token addressed to a different service (audience mismatch)', () => {
    const t = mintServiceToken({ from: 'payment', to: 'wallet' });
    expect(verifyServiceToken(t, 'markets').ok).toBe(false);
  });

  it('rejects a tampered token', () => {
    const t = mintServiceToken({ from: 'a', to: 'b' });
    expect(verifyServiceToken(t + 'x', 'b').ok).toBe(false);
  });

  it('rejects an expired token', () => {
    const t = mintServiceToken({ from: 'a', to: 'b', ttl: -10 }); // already expired
    const r = verifyServiceToken(t, 'b');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expired/i);
  });

  it('rejects a plain (non-service) JWT even with the right audience', () => {
    const t = jwt.sign({ foo: 1 }, 'svc-secret', { algorithm: 'HS256', audience: 'svc:b' });
    const r = verifyServiceToken(t, 'b');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/service token/);
  });

  it('rejects a missing token', () => {
    expect(verifyServiceToken(null, 'b').ok).toBe(false);
  });

  it('serviceAuthConfigured reflects a dedicated secret', () => {
    expect(serviceAuthConfigured()).toBe(true);
    delete process.env.SERVICE_JWT_SECRET;
    expect(serviceAuthConfigured()).toBe(false);
  });
});
