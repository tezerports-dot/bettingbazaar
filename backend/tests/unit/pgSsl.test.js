// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the AQ-3 money-DB TLS resolver. The default MUST be verified
// TLS — the regression this guards against is silently accepting any cert.
import { describe, it, expect } from 'vitest';
import { resolvePgSsl } from '../../postgres/pgClient.js';

describe('resolvePgSsl', () => {
  it('DEFAULTS to verified TLS (rejectUnauthorized: true)', () => {
    const ssl = resolvePgSsl({ DATABASE_URL: 'postgresql://user:pass@managed-host:5432/db' });
    expect(ssl).toEqual({ rejectUnauthorized: true });
  });

  it('disables TLS for explicit PG_SSL=false', () => {
    expect(resolvePgSsl({ DATABASE_URL: 'postgresql://h/db', PG_SSL: 'false' })).toBe(false);
  });

  it('disables TLS for localhost / 127.0.0.1', () => {
    expect(resolvePgSsl({ DATABASE_URL: 'postgresql://localhost:5432/db' })).toBe(false);
    expect(resolvePgSsl({ DATABASE_URL: 'postgresql://127.0.0.1:5432/db' })).toBe(false);
  });

  it('pins the provided CA when PG_CA_CERT is set (verified)', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nMII...\n-----END CERTIFICATE-----';
    const ssl = resolvePgSsl({ DATABASE_URL: 'postgresql://managed:5432/db', PG_CA_CERT: ca });
    expect(ssl).toEqual({ rejectUnauthorized: true, ca });
  });

  it('only skips verification with the explicit PG_SSL=no-verify escape hatch', () => {
    const ssl = resolvePgSsl({ DATABASE_URL: 'postgresql://managed:5432/db', PG_SSL: 'no-verify' });
    expect(ssl).toEqual({ rejectUnauthorized: false });
  });

  it('CA pinning takes precedence over a remote host default', () => {
    const ca = 'PEM';
    expect(resolvePgSsl({ DATABASE_URL: 'postgresql://remote/db', PG_CA_CERT: ca }))
      .toEqual({ rejectUnauthorized: true, ca });
  });
});
