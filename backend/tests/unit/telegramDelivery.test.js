// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * deliveryFor (telegramChallenge.service.js): a HANDOFF only where Verify's
 * link comes back to the app that asked, so an APK or installed web app left
 * on a retired address after a domain block gets a MATCH it can finish
 * (docs/governance/DOMAIN_FAILOVER.md).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { deliveryFor } from '../../domains/identity/telegramChallenge.service.js';

const before = process.env.PUBLIC_APP_ORIGIN;
afterEach(() => { if (before === undefined) delete process.env.PUBLIC_APP_ORIGIN; else process.env.PUBLIC_APP_ORIGIN = before; });

describe('deliveryFor', () => {
  it('grants a HANDOFF to an app at the site\'s own address, trailing slash or not', () => {
    process.env.PUBLIC_APP_ORIGIN = 'https://play.example.com/';
    expect(deliveryFor('HANDOFF', 'https://play.example.com')).toBe('HANDOFF');
    expect(deliveryFor('HANDOFF', 'https://play.example.com/')).toBe('HANDOFF');
  });

  it('answers MATCH to every other address, to no address, and with no site set', () => {
    process.env.PUBLIC_APP_ORIGIN = 'https://play.example.com';
    for (const origin of ['https://retired.example.com', 'http://play.example.com', 'https://play.example.com:8443',
      'https://localhost', 'https://play.example.com.evil.test', '', undefined, null, 42, ['https://play.example.com']]) {
      expect(deliveryFor('HANDOFF', origin)).toBe('MATCH');
    }
    delete process.env.PUBLIC_APP_ORIGIN;
    expect(deliveryFor('HANDOFF', '')).toBe('MATCH');
  });

  it('never upgrades: a MATCH, or anything unknown, stays MATCH', () => {
    process.env.PUBLIC_APP_ORIGIN = 'https://play.example.com';
    for (const asked of ['MATCH', 'handoff', undefined, 'OTHER']) expect(deliveryFor(asked, 'https://play.example.com')).toBe('MATCH');
  });
});
