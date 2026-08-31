// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The complete cutover: every money path on PostgreSQL at once.
 *
 * `moneyAuthority.js` refuses authority that is not backed by an
 * implementation, a dual-write, a reconciler and a rollback — and refuses an
 * INCOHERENT combination, where a path is authoritative in Postgres while a
 * path it reads from is still in Mongo. Both refusals are what make a partial
 * cutover safe, and both make a FULL cutover a claim worth pinning: that all
 * eleven paths are simultaneously eligible and mutually consistent.
 *
 * Asserted per path rather than in aggregate, because the failure this guards
 * is one domain silently staying on Mongo while the others move. That is not a
 * crash — an unset path is a legal configuration and validates clean — so the
 * money for that domain simply keeps living somewhere else, and nothing says so.
 *
 * The naming test below is not hypothetical: writing this suite found it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MONEY_PATHS, PATH_ENV, STORE,
  authorityFor, capabilityFor, isCutoverEligible,
  laggingDependencies, validateAuthorityConfig, anyPathOnPostgres,
} from '../../postgres/moneyAuthority.js';

const ALL = Object.values(MONEY_PATHS);
const DSN = 'postgresql://user:pass@host:5432/db';

/**
 * `authorityFor(path, env)` honours the `env` argument for the per-path
 * variables, but the DATABASE_URL check behind it does not: `pgConfigured()`
 * reads `process.env.DATABASE_URL` directly. So a test that only passes an env
 * OBJECT gets Mongo for everything and reads as a cutover that does not work.
 * Both halves have to be driven.
 */
let savedDsn;
beforeEach(() => { savedDsn = process.env.DATABASE_URL; process.env.DATABASE_URL = DSN; });
afterEach(() => {
  if (savedDsn === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDsn;
});

/** The environment for a complete cutover, built from PATH_ENV — never derived. */
const fullCutoverEnv = () => {
  const env = { DATABASE_URL: DSN };
  for (const name of Object.values(PATH_ENV)) env[name] = 'postgres';
  return env;
};

describe('every money path is eligible for cutover', () => {
  it.each(ALL)('%s has an implementation, dual-write, reconciler and rollback', (path) => {
    const cap = capabilityFor(path);
    expect(cap.implemented, `${path}: no Postgres reader/writer`).toBe(true);
    expect(cap.dualWrite,   `${path}: Postgres would have no data to read`).toBe(true);
    expect(cap.reconciled,  `${path}: no way to prove the stores agree`).toBe(true);
    expect(cap.rollback,    `${path}: falling back would lose writes`).toBe(true);
    expect(isCutoverEligible(path)).toBe(true);
  });
});

describe('the full cutover is coherent', () => {
  it('resolves EVERY path to Postgres — none silently left behind', () => {
    const env = fullCutoverEnv();
    const stranded = ALL.filter((p) => authorityFor(p, env) !== STORE.POSTGRES);
    expect(stranded, `these paths stayed on Mongo: ${stranded.join(', ')}`).toEqual([]);
  });

  it('leaves no path waiting on a dependency still in Mongo', () => {
    const env = fullCutoverEnv();
    for (const path of ALL) {
      expect(laggingDependencies(path, env), `${path} depends on a Mongo path`).toEqual([]);
    }
  });

  it('validates without errors or warnings', () => {
    expect(validateAuthorityConfig(fullCutoverEnv())).toMatchObject({ ok: true, errors: [] });
  });

  it('falls back to Mongo and WARNS — it does not fail the boot — without DATABASE_URL', () => {
    // Pinning what the code actually does, which is not quite what its header
    // says ("refused outright ... makes a production boot fail loudly").
    // Authority IS refused — every path resolves to Mongo, so no money moves
    // to a store that isn't there — but `ok` stays true and the only signal is
    // a per-path warning in the boot log.
    //
    // That gap is worth knowing: a deploy that sets all eleven variables and
    // forgets DATABASE_URL runs happily with every rupee in the other database
    // from the one the operator configured, and nothing fails. Whether that
    // should be an error is an owner's call about boot policy, not something
    // to change while flipping paths — so this asserts today's behaviour and
    // names the discrepancy rather than hiding it.
    const env = fullCutoverEnv();
    delete env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    for (const p of ALL) expect(authorityFor(p, env)).toBe(STORE.MONGO);

    const result = validateAuthorityConfig(env);
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBe(ALL.length);
    expect(result.warnings[0]).toMatch(/DATABASE_URL is unset/);
  });
});

describe('the environment variable names', () => {
  it('cannot be derived from the path name — one of them differs', () => {
    // `bonuses_and_commissions` is set by MONEY_AUTHORITY_BONUSES. A deploy
    // script that builds `MONEY_AUTHORITY_${PATH.toUpperCase()}` leaves that
    // one domain on Mongo, and NOTHING reports it: an unset path is legal, so
    // validateAuthorityConfig still returns ok. Pinned so the mismatch is
    // discovered here rather than by a bonus that moved money in the other
    // database.
    const derived = (p) => `MONEY_AUTHORITY_${p.toUpperCase()}`;
    const mismatched = ALL.filter((p) => PATH_ENV[p] !== derived(p));
    expect(mismatched).toEqual([MONEY_PATHS.BONUSES_AND_COMMISSIONS]);
    expect(PATH_ENV[MONEY_PATHS.BONUSES_AND_COMMISSIONS]).toBe('MONEY_AUTHORITY_BONUSES');
  });

  it('strands exactly that path when the name IS derived — the failure mode', () => {
    const env = { DATABASE_URL: DSN };
    for (const p of ALL) env[`MONEY_AUTHORITY_${p.toUpperCase()}`] = 'postgres';
    const stranded = ALL.filter((p) => authorityFor(p, env) !== STORE.POSTGRES);
    expect(stranded).toEqual([MONEY_PATHS.BONUSES_AND_COMMISSIONS]);
    // ...and it still validates clean, which is the dangerous part.
    expect(validateAuthorityConfig(env).ok).toBe(true);
  });
});

describe('the default is unchanged', () => {
  it('is Mongo everywhere when nothing is set', () => {
    const env = { DATABASE_URL: DSN };
    for (const p of ALL) expect(authorityFor(p, env)).toBe(STORE.MONGO);
    expect(anyPathOnPostgres(env)).toBe(false);
  });
});
