// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the AQ-1 fail-fast environment gate.
import { describe, it, expect } from 'vitest';
import { validateEnv } from '../../startup/validateEnv.js';

const full = {
  JWT_SECRET: 's', ORDER_HMAC_SECRET: 'h', MONGODB_URI: 'mongodb://x',
  REDIS_URL: 'r', ALLOWED_ORIGINS: 'o', S3_BUCKET_NAME: 'b',
};

describe('validateEnv', () => {
  it('passes when all required vars are present', () => {
    const r = validateEnv({ ...full, NODE_ENV: 'production' }, true);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('THROWS in production when a required var is missing', () => {
    const { JWT_SECRET, ...noJwt } = full;
    expect(() => validateEnv({ ...noJwt, NODE_ENV: 'production' }, true)).toThrow(/JWT_SECRET/);
  });

  it('lists every missing required var in the thrown message', () => {
    expect(() => validateEnv({ NODE_ENV: 'production' }, true))
      .toThrow(/JWT_SECRET[\s\S]*ORDER_HMAC_SECRET[\s\S]*MONGODB_URI/);
  });

  it('does NOT throw outside production, but reports what is missing', () => {
    const r = validateEnv({ NODE_ENV: 'development' }, false);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('JWT_SECRET');
  });

  it('treats an empty string as missing (not merely undefined)', () => {
    expect(() => validateEnv({ ...full, JWT_SECRET: '   ', NODE_ENV: 'production' }, true))
      .toThrow(/JWT_SECRET/);
  });

  it('reports advised-but-missing vars without failing', () => {
    const required = { JWT_SECRET: 's', ORDER_HMAC_SECRET: 'h', MONGODB_URI: 'm' };
    const r = validateEnv({ ...required, NODE_ENV: 'production' }, true);
    expect(r.ok).toBe(true);
    expect(r.advisedMissing).toEqual(expect.arrayContaining(['REDIS_URL', 'S3_BUCKET_NAME']));
  });
});
