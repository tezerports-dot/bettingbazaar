// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the AQ-1 fail-fast environment gate.
import { describe, it, expect } from 'vitest';
import { validateEnv } from '../../startup/validateEnv.js';

// Signing/HMAC secrets must be strong (≥32 chars, non-placeholder) — the gate
// rejects weak ones in production, so the "happy path" fixture uses real ones.
const STRONG_JWT   = 'a-strong-random-jwt-signing-secret-value';
const STRONG_ORDER = 'a-strong-random-order-hmac-secret-value';

const full = {
  JWT_SECRET: STRONG_JWT, ORDER_HMAC_SECRET: STRONG_ORDER, AADHAAR_HMAC_SECRET: 'a-secure-aadhaar-hmac-secret-value', IDENTITY_ENCRYPTION_KEY: 'Ej8mQ2xVbn5rT9wYzA1cD3eF6gH0iJkLmNoPqRsTuVw=', DATABASE_URL: 'postgresql://u:p@localhost:5432/bb',
  REDIS_URL: 'r', ALLOWED_ORIGINS: 'o', METRICS_TOKEN: 'a-secure-random-metrics-token-value',
  // All four S3 vars: production boot requires isS3Configured(), which needs
  // bucket + access key + secret key + endpoint, not the bucket alone.
  S3_BUCKET_NAME: 'b', S3_ACCESS_KEY: 'ak', S3_SECRET_KEY: 'sk', S3_ENDPOINT: 'https://s3.example.test',
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

  it('requires IDENTITY_ENCRYPTION_KEY in production', () => {
    // Without it, Aadhaar numbers and bot tokens cannot be encrypted — and the
    // failure would otherwise surface at the first signup rather than at boot.
    const { IDENTITY_ENCRYPTION_KEY, ...without } = full;
    expect(() => validateEnv({ ...without, NODE_ENV: 'production' }, true)).toThrow(/IDENTITY_ENCRYPTION_KEY/);
  });

  it('rejects an IDENTITY_ENCRYPTION_KEY that is not exactly 32 bytes', () => {
    // A short key would be silently derived-from by a laxer implementation,
    // which encrypts records nobody can read back once the typo is corrected.
    expect(() => validateEnv({ ...full, IDENTITY_ENCRYPTION_KEY: 'dG9vLXNob3J0', NODE_ENV: 'production' }, true))
      .toThrow(/IDENTITY_ENCRYPTION_KEY/);
  });

  it('requires AADHAAR_HMAC_SECRET in production', () => {
    const { AADHAAR_HMAC_SECRET, ...withoutAadhaarSecret } = full;
    expect(() => validateEnv({ ...withoutAadhaarSecret, NODE_ENV: 'production' }, true)).toThrow(/AADHAAR_HMAC_SECRET/);
  });

  it('rejects weak or placeholder Aadhaar HMAC secrets in production', () => {
    expect(() => validateEnv({ ...full, AADHAAR_HMAC_SECRET: 'change-this-to-a-dedicated-random-string', NODE_ENV: 'production' }, true))
      .toThrow(/AADHAAR_HMAC_SECRET/);
  });

  it('rejects a weak or placeholder JWT signing secret in production', () => {
    expect(() => validateEnv({ ...full, JWT_SECRET: 'test-only-jwt-secret', NODE_ENV: 'production' }, true))
      .toThrow(/JWT_SECRET/);
    expect(() => validateEnv({ ...full, JWT_SECRET: 'short', NODE_ENV: 'production' }, true))
      .toThrow(/at least 32 characters/);
  });

  it('rejects a weak ORDER_HMAC_SECRET in production', () => {
    expect(() => validateEnv({ ...full, ORDER_HMAC_SECRET: 'changeme', NODE_ENV: 'production' }, true))
      .toThrow(/ORDER_HMAC_SECRET/);
  });

  it('rejects a weak PASETO_SECRET_KEY when it is the one in use', () => {
    expect(() => validateEnv({ ...full, PASETO_SECRET_KEY: 'secret', NODE_ENV: 'production' }, true))
      .toThrow(/PASETO_SECRET_KEY/);
  });

  it('refuses to boot production with unverified money-DB TLS (PG_SSL=no-verify)', () => {
    expect(() => validateEnv({ ...full, PG_SSL: 'no-verify', NODE_ENV: 'production' }, true))
      .toThrow(/PG_SSL=no-verify/);
  });

  it('allows PG_SSL=no-verify only with an explicit ALLOW_INSECURE_PG_TLS override', () => {
    const r = validateEnv({ ...full, PG_SSL: 'no-verify', ALLOW_INSECURE_PG_TLS: 'true', NODE_ENV: 'production' }, true);
    expect(r.ok).toBe(true);
  });

  it('lists every missing required var in the thrown message', () => {
    expect(() => validateEnv({ NODE_ENV: 'production' }, true))
      .toThrow(/JWT_SECRET[\s\S]*DATABASE_URL/);
  });

  it('requires production hardening vars instead of silently falling back', () => {
    expect(() => validateEnv({ JWT_SECRET: STRONG_JWT, DATABASE_URL: 'postgresql://u:p@localhost:5432/bb', NODE_ENV: 'production' }, true))
      .toThrow(/ORDER_HMAC_SECRET[\s\S]*REDIS_URL[\s\S]*ALLOWED_ORIGINS[\s\S]*S3_BUCKET_NAME[\s\S]*METRICS_TOKEN/);
  });

  // server.js throws 'production storage requires a fully configured
  // S3-compatible provider' unless isS3Configured() sees all four of these.
  // This gate previously named only S3_BUCKET_NAME, so an operator could
  // satisfy every variable it printed and still crash-loop on a fresh deploy —
  // the failure mode a fail-fast env gate exists to prevent.
  for (const key of ['S3_BUCKET_NAME', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_ENDPOINT']) {
    it(`requires ${key} in production so boot cannot fail after the gate passes`, () => {
      const { [key]: _omitted, ...withoutOne } = full;
      expect(() => validateEnv({ ...withoutOne, NODE_ENV: 'production' }, true))
        .toThrow(new RegExp(key));
    });
  }

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
