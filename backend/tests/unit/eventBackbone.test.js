// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the event-backbone seam (CAP-74). Proves the safety property
// the design leans on: with no drivers it is a no-op, and a broken driver never
// breaks forwarding.
import { describe, it, expect, afterEach } from 'vitest';
import { registerDriver, forward, hasDrivers, listDrivers, resetBackbone } from '../../services/eventBackbone.js';

afterEach(async () => { await resetBackbone(); });

describe('eventBackbone', () => {
  it('no drivers → forward is a no-op and does not throw', () => {
    expect(hasDrivers()).toBe(false);
    expect(() => forward({ event: 'x', payload: {}, ts: 1 })).not.toThrow();
  });

  it('forwards envelopes to a registered driver', () => {
    const seen = [];
    registerDriver({ name: 't', publish: (e, env) => seen.push([e, env.payload]) });
    forward({ event: 'wallet.credited', payload: { userId: 'u' }, ts: 1 });
    expect(seen).toEqual([['wallet.credited', { userId: 'u' }]]);
  });

  it('a throwing driver does not break forward', () => {
    registerDriver({ name: 'bad', publish: () => { throw new Error('boom'); } });
    expect(() => forward({ event: 'e', payload: {}, ts: 1 })).not.toThrow();
  });

  it('a rejecting async driver does not break forward', () => {
    registerDriver({ name: 'async-bad', publish: () => Promise.reject(new Error('later')) });
    expect(() => forward({ event: 'e', payload: {}, ts: 1 })).not.toThrow();
  });

  it('rejects a driver without a publish() method', () => {
    expect(() => registerDriver({ name: 'x' })).toThrow(/publish/);
  });

  it('lists registered driver names', () => {
    registerDriver({ name: 'k', publish() {} });
    expect(listDrivers()).toContain('k');
  });
});
