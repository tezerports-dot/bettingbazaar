// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the AQ-1 fail-fast environment gate.
import { describe, it, expect } from 'vitest';
import { validateEnv } from '../../startup/validateEnv.js';

const full = {
  JWT_SECRET: 's', ORDER_HMAC_SECRET: 'h', AADHAAR_HMAC_SECRET: 'a-secure-aadhaar-hmac-secret-value', MONGODB_URI: 'mongodb://x', DATABASE_URL: 'postgresql://u:p@localhost:5432/bb',
  REDIS_URL: 'r', ALLOWED_ORIGINS: 'o', S3_BUCKET_NAME: 'b', METRICS_TOKEN: 'a-secure-random-metrics-token-value',
  PUBLIC_APP_ORIGIN: 'https://app.example.test', PUBLIC_APP_ALLOWED_ORIGINS: 'https://app.example.test',
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

  it('requires AADHAAR_HMAC_SECRET in production', () => {
    const { AADHAAR_HMAC_SECRET, ...withoutAadhaarSecret } = full;
    expect(() => validateEnv({ ...withoutAadhaarSecret, NODE_ENV: 'production' }, true)).toThrow(/AADHAAR_HMAC_SECRET/);
  });

  it('rejects weak or placeholder Aadhaar HMAC secrets in production', () => {
    expect(() => validateEnv({ ...full, AADHAAR_HMAC_SECRET: 'change-this-to-a-dedicated-random-string', NODE_ENV: 'production' }, true))
      .toThrow(/AADHAAR_HMAC_SECRET/);
  });

  it('lists every missing required var in the thrown message', () => {
    expect(() => validateEnv({ NODE_ENV: 'production' }, true))
      .toThrow(/JWT_SECRET[\s\S]*MONGODB_URI[\s\S]*DATABASE_URL/);
  });

  it('requires production hardening vars instead of silently falling back', () => {
    expect(() => validateEnv({ JWT_SECRET: 's', MONGODB_URI: 'm', DATABASE_URL: 'postgresql://u:p@localhost:5432/bb', NODE_ENV: 'production' }, true))
      .toThrow(/ORDER_HMAC_SECRET[\s\S]*REDIS_URL[\s\S]*ALLOWED_ORIGINS[\s\S]*S3_BUCKET_NAME[\s\S]*METRICS_TOKEN/);
  });

  it('rejects weak or placeholder metrics tokens in production', () => {
    expect(() => validateEnv({ ...full, METRICS_TOKEN: 'change-this-to-a-random-metrics-token', NODE_ENV: 'production' }, true))
      .toThrow(/METRICS_TOKEN/);
  });

  it('rejects invalid public origins in production', () => {
    expect(() => validateEnv({ ...full, PUBLIC_APP_ORIGIN: 'not-an-origin', NODE_ENV: 'production' }, true))
      .toThrow(/invalid public application origin/i);
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

  it('has no advisory production security gaps left', () => {
    const r = validateEnv({ ...full, NODE_ENV: 'production' }, true);
    expect(r.ok).toBe(true);
    expect(r.advisedMissing).toEqual([]);
  });
});
