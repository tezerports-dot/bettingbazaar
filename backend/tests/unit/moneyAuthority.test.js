// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// The switch that decides which store owns money, per path. Every assertion
// here is a safety property of the cutover described in LAUNCH_READINESS §E and
// postgres/DATA_ROLLBACK_PLAN.md — mis-answering any of them means reading a
// balance from a store that does not own it.
import { describe, it, expect, afterEach } from 'vitest';
import {
  STORE, MONEY_PATHS, ALL_PATHS,
  authorityFor, isPostgresAuthoritative, anyPathOnPostgres,
  authorityMatrix, validateAuthorityConfig,
} from '../../postgres/moneyAuthority.js';

const PG = 'postgresql://u:p@db.example:5432/money';

// authorityFor consults the real process.env for DATABASE_URL (via
// pgConfigured), so tests that need Postgres "configured" set it and clean up.
const originalDatabaseUrl = process.env.DATABASE_URL;
afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

const withPg = (env = {}) => { process.env.DATABASE_URL = PG; return env; };
const withoutPg = (env = {}) => { delete process.env.DATABASE_URL; return env; };

describe('default posture', () => {
  it('every path is on MongoDB when nothing is configured', () => {
    const env = withoutPg();
    for (const path of ALL_PATHS) expect(authorityFor(path, env)).toBe(STORE.MONGO);
    expect(anyPathOnPostgres(env)).toBe(false);
  });

  it('stays on MongoDB even with Postgres configured but no path requested', () => {
    const env = withPg();
    for (const path of ALL_PATHS) expect(authorityFor(path, env)).toBe(STORE.MONGO);
  });

  it('flips paths in the documented order: wallet, ledger, orders, kyc last', () => {
    expect(ALL_PATHS).toEqual(['wallet', 'ledger', 'orders', 'kyc']);
  });
});

describe('opting a path into Postgres', () => {
  it('moves only the path that was asked for', () => {
    const env = withPg({ MONEY_AUTHORITY_WALLET: 'postgres' });
    expect(authorityFor(MONEY_PATHS.WALLET, env)).toBe(STORE.POSTGRES);
    expect(authorityFor(MONEY_PATHS.LEDGER, env)).toBe(STORE.MONGO);
    expect(anyPathOnPostgres(env)).toBe(true);
  });

  it('accepts any casing and surrounding whitespace', () => {
    const env = withPg({ MONEY_AUTHORITY_WALLET: '  PostgreSQL '.replace('QL', '') });
    expect(authorityFor(MONEY_PATHS.WALLET, env)).toBe(STORE.POSTGRES);
  });
});

describe('fail-safe behaviour', () => {
  it('REFUSES Postgres authority when DATABASE_URL is unset', () => {
    // Returning POSTGRES here would send the app looking for balances in a
    // database it has no connection to.
    const env = withoutPg({ MONEY_AUTHORITY_WALLET: 'postgres' });
    expect(authorityFor(MONEY_PATHS.WALLET, env)).toBe(STORE.MONGO);
    expect(isPostgresAuthoritative(MONEY_PATHS.WALLET, env)).toBe(false);
  });

  it('reports the mismatch so a deploy cannot believe it cut over when it did not', () => {
    const env = withoutPg({ MONEY_AUTHORITY_WALLET: 'postgres' });
    const result = validateAuthorityConfig(env);
    expect(result.ok).toBe(true); // safe, but not silent
    expect(result.warnings.join(' ')).toMatch(/DATABASE_URL is unset/);
  });

  it.each(['mongodb', 'postgres ', 'pg', 'true', '1', 'yes', 'POSTGRESS', ''])(
    'treats %o as MongoDB — a typo must never move the source of truth for money',
    (value) => {
      const env = withPg({ MONEY_AUTHORITY_WALLET: value });
      const expected = value.trim().toLowerCase() === 'postgres' ? STORE.POSTGRES : STORE.MONGO;
      expect(authorityFor(MONEY_PATHS.WALLET, env)).toBe(expected);
    },
  );

  it('rejects an unknown path rather than guessing', () => {
    expect(() => authorityFor('winnings', withPg())).toThrow(/Unknown money path/);
  });
});

describe('ordering constraints', () => {
  it('refuses ledger-on-Postgres while wallet is still on MongoDB', () => {
    // A settlement would read balances from one store and write accounting to
    // the other; no reconciliation could say which was right.
    const env = withPg({ MONEY_AUTHORITY_LEDGER: 'postgres' });
    const result = validateAuthorityConfig(env);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/'ledger' is set to Postgres but 'wallet'/);
    expect(result.errors[0]).toMatch(/MONEY_AUTHORITY_WALLET/); // tells you the fix
  });

  it('accepts wallet then ledger together', () => {
    const env = withPg({ MONEY_AUTHORITY_WALLET: 'postgres', MONEY_AUTHORITY_LEDGER: 'postgres' });
    expect(validateAuthorityConfig(env).ok).toBe(true);
  });

  it('refuses KYC first — the plan cuts it over last', () => {
    const env = withPg({ MONEY_AUTHORITY_KYC: 'postgres' });
    const result = validateAuthorityConfig(env);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/'wallet'.*'ledger'.*'orders'/);
  });

  it('accepts the fully cut-over configuration', () => {
    const env = withPg(Object.fromEntries(
      ALL_PATHS.map((p) => [`MONEY_AUTHORITY_${p.toUpperCase()}`, 'postgres']),
    ));
    expect(validateAuthorityConfig(env).ok).toBe(true);
    expect(authorityMatrix(env).every((r) => r.effective === STORE.POSTGRES)).toBe(true);
  });
});

describe('authorityMatrix', () => {
  it('separates what was requested from what is in effect', () => {
    const env = withoutPg({ MONEY_AUTHORITY_WALLET: 'postgres' });
    const wallet = authorityMatrix(env).find((r) => r.path === 'wallet');
    expect(wallet.requested).toBe(STORE.POSTGRES);
    expect(wallet.effective).toBe(STORE.MONGO);
  });
});
