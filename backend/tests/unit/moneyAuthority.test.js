// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// The switch that decides which store owns money, per path. Every assertion
// here is a safety property of the cutover described in LAUNCH_READINESS §E and
// postgres/DATA_ROLLBACK_PLAN.md — mis-answering any of them means reading a
// balance from a store that does not own it.
import { describe, it, expect, afterEach } from 'vitest';
import {
  STORE, MONEY_PATHS, ALL_PATHS, authorityFor, isPostgresAuthoritative, anyPathOnPostgres, authorityMatrix, validateAuthorityConfig, laggingDependencies, fullFinancialAuthorityStatus, capabilityFor,
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

  it('flips the user wallet first and the merchant wallet second', () => {
    // merchant_wallet moved ahead of ledger/orders/kyc when its real dependency
    // was identified: a deposit confirmation debits the merchant and credits
    // the user in ONE session, so those two balances must live in the same
    // store. It never touches accounting_events, so it never needed the
    // double-entry ledger to move first.
    expect(ALL_PATHS.slice(0, 5)).toEqual(['wallet', 'merchant_wallet', 'ledger', 'orders', 'kyc']);
  });

  it('declares the money paths that were previously unmodelled', () => {
    // These move money but had no entry at all, so their absence from the
    // matrix could not be seen. Declaring them makes the remaining work
    // visible and makes setting their env var a boot failure rather than a
    // silent no-op.
    expect(ALL_PATHS).toEqual(expect.arrayContaining([
      'merchant_wallet', 'merchant_settlement', 'admin_issuance',
      'bets', 'settlements', 'bonuses_and_commissions',
    ]));
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

describe('capability gate — authority requires an implementation', () => {
  // The gate that did not exist. moneyAuthority declared four paths while only
  // `wallet` had a Postgres reader/writer, so MONEY_AUTHORITY_LEDGER=postgres
  // was accepted, passed every check, and changed nothing — the config, the
  // boot log and the metrics gauge all reporting a cutover that had not
  // happened. Silent downgrade is a worse failure than refusing to start.

  it('refuses to boot when an unimplemented path is set to Postgres', () => {
    const env = withPg({ MONEY_AUTHORITY_LEDGER: 'postgres' });
    const result = validateAuthorityConfig(env);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/NOT eligible for cutover/);
    expect(result.errors[0]).toMatch(/missing: implemented/);
  });

  it('resolves an ineligible path to MongoDB at runtime, not just at boot', () => {
    // Anything reaching authorityFor() without boot validation — a script, a
    // worker, a test — must still get the truthful answer.
    const env = withPg({ MONEY_AUTHORITY_LEDGER: 'postgres' });
    expect(authorityFor(MONEY_PATHS.LEDGER, env)).toBe(STORE.MONGO);
  });

  it('never reports Postgres in the matrix for a path whose writes go to Mongo', () => {
    // Health endpoints and the metrics gauge read `effective`.
    const env = withPg(Object.fromEntries(
      ALL_PATHS.map((p) => [`MONEY_AUTHORITY_${p.toUpperCase()}`, 'postgres']),
    ));
    for (const row of authorityMatrix(env)) {
      if (!row.cutoverEligible) expect(row.effective).toBe(STORE.MONGO);
    }
  });

  it('reports every unimplemented path with what it is missing', () => {
    const rows = authorityMatrix(withPg());
    const ledger = rows.find((r) => r.path === MONEY_PATHS.LEDGER);
    expect(ledger.cutoverEligible).toBe(false);
    expect(ledger.missing).toContain('implemented');

    // Bets is mirrored, reconciled and rollback-capable now; only `implemented`
    // is outstanding, because that flag also requires CI evidence for the
    // cross-store suite. Asserting the exact list rather than "contains
    // implemented" is deliberate — it is what would catch a capability being
    // flipped on without the leg behind it actually landing.
    const bets = rows.find((r) => r.path === MONEY_PATHS.BETS);
    expect(bets.cutoverEligible).toBe(false);
    expect(bets.missing).toEqual(['implemented']);

    // A path with genuinely nothing built still reports all four, which is what
    // makes the list above meaningful rather than vacuous.
    const casino = rows.find((r) => r.path === MONEY_PATHS.CASINO_SETTLEMENT);
    expect(casino.missing).toEqual(
      expect.arrayContaining(['implemented', 'dualWrite', 'reconciled', 'rollback']));
  });

  it('holds merchant settlement on its DEPENDENCIES, not on its capabilities', () => {
    // All four capabilities now hold: the state inversion landed (settleHold
    // gates on the settlement's own RESERVED→SETTLED guard and writes Mongo
    // afterwards as a mirror), it is mirrored both ways, and it reconciles.
    // So the capability gate is satisfied and the path is cutover-ELIGIBLE.
    const env = withPg();
    const settlement = authorityMatrix(env).find((r) => r.path === MONEY_PATHS.MERCHANT_SETTLEMENT);
    expect(settlement.cutoverEligible).toBe(true);
    expect(settlement.missing).toEqual([]);

    // And it is still Mongo, which is the point of this test. Being ready is
    // not the same as being next: settlements are composed out of orders, so a
    // settlement reading Postgres while order state still lived in Mongo would
    // be authoritative over a lifecycle it cannot see. The ORDERING gate — not
    // the capability gate — is what holds it, and the two must stay separable
    // or a flip could be justified by the wrong evidence.
    //
    // Both dependencies lag here, and for DIFFERENT reasons: orders is not
    // eligible at all, while merchant_wallet is eligible but has not been
    // asked for. Lagging means "not actually on Postgres", not "not ready" —
    // a dependency nobody flipped is just as absent as one that cannot be.
    expect(laggingDependencies(MONEY_PATHS.MERCHANT_SETTLEMENT, env))
      .toEqual([MONEY_PATHS.MERCHANT_WALLET, MONEY_PATHS.ORDERS]);
    expect(authorityFor(MONEY_PATHS.MERCHANT_SETTLEMENT, env)).toBe(STORE.MONGO);

    // Flip the entire chain that CAN be flipped, and ask for this path
    // explicitly. Orders is the one thing left, and it is enough — a flag
    // cannot buy its way past the order.
    const forced = withPg({
      MONEY_AUTHORITY_WALLET: 'postgres',
      MONEY_AUTHORITY_MERCHANT_WALLET: 'postgres',
      MONEY_AUTHORITY_MERCHANT_SETTLEMENT: 'postgres',
    });
    expect(laggingDependencies(MONEY_PATHS.MERCHANT_SETTLEMENT, forced)).toEqual([MONEY_PATHS.ORDERS]);
    expect(authorityFor(MONEY_PATHS.MERCHANT_SETTLEMENT, forced)).toBe(STORE.MONGO);
  });

  it('reports the merchant wallet as eligible now that all four capabilities hold', () => {
    // Flipped only after each was separately evidenced: the adapter and its
    // routing (implemented), mirrorMerchantBalance (dualWrite),
    // reconcileMerchantBalances (reconciled), reverseMirrorMerchantMovement
    // (rollback). If any of those is deleted, this test is the alarm.
    const merchant = authorityMatrix(withPg()).find((r) => r.path === MONEY_PATHS.MERCHANT_WALLET);
    expect(merchant.cutoverEligible).toBe(true);
    expect(merchant.missing).toEqual([]);
  });

  it('keeps the one implemented path flippable — the gate must not block real work', () => {
    const env = withPg({ MONEY_AUTHORITY_WALLET: 'postgres' });
    expect(validateAuthorityConfig(env).ok).toBe(true);
    expect(authorityFor(MONEY_PATHS.WALLET, env)).toBe(STORE.POSTGRES);
  });

  it('reports NOT READY while any path lacks an implementation', () => {
    const s = fullFinancialAuthorityStatus(withPg({ MONEY_AUTHORITY_WALLET: 'postgres' }));
    expect(s.ready).toBe(false);
    expect(s.status).toMatch(/NOT READY/);
    expect(s.notImplemented.length).toBeGreaterThan(0);
  });
});

describe('ordering constraints', () => {
  // The dependency rule is enforced in TWO places, and both matter:
  // validateAuthorityConfig turns an out-of-order config into a boot failure,
  // and authorityFor() independently refuses to answer 'postgres' for a path
  // whose dependency still lives in Mongo. The second exists because scripts,
  // workers and crons never run boot validation — reconcile.js picks its repair
  // DIRECTION from the resolver, so a wrong answer there would overwrite good
  // balances with stale ones.

  it('refuses Postgres at the resolver when a dependency has not cut over', () => {
    // merchant_wallet is fully eligible, so only the ordering rule can stop it.
    const env = withPg({ MONEY_AUTHORITY_MERCHANT_WALLET: 'postgres' });
    expect(authorityFor(MONEY_PATHS.MERCHANT_WALLET, env)).toBe(STORE.MONGO);
    expect(validateAuthorityConfig(env).ok).toBe(false);
  });

  it('allows it once the dependency has moved', () => {
    const env = withPg({
      MONEY_AUTHORITY_WALLET: 'postgres',
      MONEY_AUTHORITY_MERCHANT_WALLET: 'postgres',
    });
    expect(authorityFor(MONEY_PATHS.MERCHANT_WALLET, env)).toBe(STORE.POSTGRES);
    expect(validateAuthorityConfig(env).ok).toBe(true);
  });

  it('names the merchant wallet\'s real dependency as the user wallet', () => {
    expect(laggingDependencies(MONEY_PATHS.MERCHANT_WALLET, withPg())).toEqual([MONEY_PATHS.WALLET]);
  });

  it('reports a dependency that has not cut over yet', () => {
    const env = withPg(); // nothing on Postgres
    expect(laggingDependencies(MONEY_PATHS.LEDGER, env)).toEqual([MONEY_PATHS.WALLET]);
  });

  it('reports no lag once the dependency is authoritative', () => {
    const env = withPg({ MONEY_AUTHORITY_WALLET: 'postgres' });
    expect(laggingDependencies(MONEY_PATHS.LEDGER, env)).toEqual([]);
  });

  it('KYC lags on all three of its predecessors — it cuts over last', () => {
    const lagging = laggingDependencies(MONEY_PATHS.KYC, withPg());
    expect(lagging).toEqual([MONEY_PATHS.WALLET, MONEY_PATHS.LEDGER, MONEY_PATHS.ORDERS]);
  });

  it('rejects an unknown path rather than guessing', () => {
    expect(() => laggingDependencies('winnings', withPg())).toThrow(/Unknown money path/);
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
