// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the monolith→microservices topology seam (CAP-72). Pure — every
// function takes an explicit env, so no process.env mutation.
import { describe, it, expect } from 'vitest';
import { resolve, isRemote, isHybrid, topologySnapshot, KNOWN_SERVICES } from '../../gateway/serviceTopology.js';

describe('serviceTopology', () => {
  it('defaults every domain to local (monolith)', () => {
    expect(resolve('payment', {}).location).toBe('local');
    expect(resolve('payment', {}).baseUrl).toBe(null);
    expect(isHybrid({})).toBe(false);
    expect(topologySnapshot({}).mode).toBe('monolith');
  });

  it('resolves remote when SERVICE_<NAME>_URL is set', () => {
    const env = { SERVICE_PAYMENT_URL: 'https://pay.svc/' };
    expect(resolve('payment', env)).toEqual({ name: 'payment', location: 'remote', baseUrl: 'https://pay.svc' });
    expect(isRemote('payment', env)).toBe(true);
    expect(isHybrid(env)).toBe(true);
    expect(topologySnapshot(env).mode).toBe('hybrid');
    expect(topologySnapshot(env).remoteCount).toBe(1);
  });

  it('strips trailing slashes from the base URL', () => {
    expect(resolve('x', { SERVICE_X_URL: 'http://h///' }).baseUrl).toBe('http://h');
  });

  it('KNOWN_SERVICES covers the money + support domains', () => {
    expect(KNOWN_SERVICES).toEqual(expect.arrayContaining(['wallet', 'payment', 'support']));
  });
});
