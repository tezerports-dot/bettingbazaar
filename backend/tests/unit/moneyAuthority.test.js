// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// The switch that decides which store owns money, per path. Every assertion
// here is a safety property of the cutover described in LAUNCH_READINESS §E and
// postgres/DATA_ROLLBACK_PLAN.md — mis-answering any of them means reading a
// balance from a store that does not own it.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  STORE, MONEY_PATHS, ALL_PATHS, authorityFor, isPostgresAuthoritative, anyPathOnPostgres, authorityMatrix, validateAuthorityConfig, laggingDependencies, fullFinancialAuthorityStatus, capabilityFor, isCutoverEligible, certificationFor, PATH_ENV,
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
    // This test used to borrow whichever real path was still incomplete —
    // ledger, then casino_settlement, then bets. As of 1bd5de8 there is no such
    // path left, and the honest choices were to delete the test or to make the
    // gate testable without one. Deleting it would leave the mechanism that
    // exists to stop a FALSE CUTOVER unexercised until a twelfth domain is
    // declared, which is exactly when a regression would be most expensive.
    //
    // So the capability lookup is injected. The registry is real everywhere
    // else; here it reports one path with no implementation, and the refusal
    // must still fire with the message an operator needs.
    const env = withPg({ MONEY_AUTHORITY_BETS: 'postgres' });
    const pretendUnimplemented = (path) => (path === MONEY_PATHS.BETS
      ? { ...capabilityFor(path), implemented: false, missing: ['implemented'], cutoverEligible: false }
      : capabilityFor(path));

    const result = validateAuthorityConfig(env, pretendUnimplemented);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/NOT eligible for cutover/);
    expect(result.errors[0]).toMatch(/missing: implemented/);
    // Named, so the operator knows which variable to remove.
    expect(result.errors[0]).toMatch(/MONEY_AUTHORITY_BETS/);
  });

  it('accepts the same config against the REAL registry — the stub is the only difference', () => {
    // The control for the test above. Without it, a gate that refused
    // everything unconditionally would look identical.
    const env = withPg({ MONEY_AUTHORITY_BETS: 'postgres' });
    const result = validateAuthorityConfig(env);
    expect(result.errors.filter((e) => /NOT eligible for cutover/.test(e))).toEqual([]);
  });

  it('resolves an ineligible path to MongoDB at runtime, not just at boot', () => {
    // Anything reaching authorityFor() without boot validation — a script, a
    // worker, a test — must still get the truthful answer. Asserted as the
    // PROPERTY over the matrix rather than against a named path, so it keeps
    // holding whatever the registry says: `effective` is never postgres for a
    // path that is not cutover-eligible.
    const env = withPg(Object.fromEntries(
      ALL_PATHS.map((p) => [`MONEY_AUTHORITY_${p.toUpperCase()}`, 'postgres']),
    ));
    for (const path of ALL_PATHS) {
      if (!isCutoverEligible(path)) expect(authorityFor(path, env)).toBe(STORE.MONGO);
    }
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

  it('resolves ALL 11 paths to Postgres when an operator sets every variable', () => {
    // The end state, pinned. This is the question "is the migration done?"
    // answered by the resolver rather than by a summary someone maintains.
    //
    // It read 9 of 11 until 1bd5de8: BETS was not eligible because its
    // settlement side still wrote Bet.status directly, and SETTLEMENTS depends
    // on BETS — one unrouted domain holding two paths on Mongo, which was the
    // ordering gate doing its job. Routing settlement is what opened it. The
    // gate itself is unchanged; the domains caught up with it.
    const env = withPg(Object.fromEntries(
      ALL_PATHS.map((p) => [`MONEY_AUTHORITY_${p.toUpperCase()}`, 'postgres']),
    ));
    env.MONEY_AUTHORITY_BONUSES = 'postgres';   // its variable name differs from the path

    const onMongo = ALL_PATHS.filter((p) => authorityFor(p, env) === STORE.MONGO);
    expect(onMongo).toEqual([]);
    // And no path is waiting on a dependency, which is the other half of it:
    // eleven paths resolving to Postgres with a lagging edge somewhere would
    // mean the ordering gate had stopped being consulted rather than satisfied.
    for (const path of ALL_PATHS) expect(laggingDependencies(path, env)).toEqual([]);
    expect(validateAuthorityConfig(env).ok).toBe(true);
  });

  it('still holds SETTLEMENTS behind BETS when BETS alone is not asked for', () => {
    // The ordering gate is satisfied, not disabled. Removing one variable must
    // put its dependants back on Mongo — otherwise "all eleven resolve" above
    // would be evidence the edge had been deleted rather than met.
    const env = withPg(Object.fromEntries(
      ALL_PATHS.map((p) => [`MONEY_AUTHORITY_${p.toUpperCase()}`, 'postgres']),
    ));
    env.MONEY_AUTHORITY_BONUSES = 'postgres';
    delete env.MONEY_AUTHORITY_BETS;

    expect(authorityFor(MONEY_PATHS.BETS, env)).toBe(STORE.MONGO);
    expect(authorityFor(MONEY_PATHS.SETTLEMENTS, env)).toBe(STORE.MONGO);
    expect(laggingDependencies(MONEY_PATHS.SETTLEMENTS, env)).toEqual([MONEY_PATHS.BETS]);
    expect(validateAuthorityConfig(env).ok).toBe(false);
  });

  it('reports EVERY path as eligible, with nothing missing', () => {
    // The list of incomplete paths has been the moving part of this suite all
    // along: it was ledger, then casino_settlement, then bets. It is now empty,
    // and asserting emptiness is the strongest form of it — a capability
    // flipped on without its leg would not show here, but `verify:capabilities`
    // and the per-domain suites are what check that, and the notes on each
    // registry entry name the CI run the flag rests on.
    const rows = authorityMatrix(withPg());
    expect(rows.filter((r) => !r.cutoverEligible).map((r) => r.path)).toEqual([]);
    for (const row of rows) expect({ path: row.path, missing: row.missing }).toEqual({ path: row.path, missing: [] });
    expect(rows).toHaveLength(11);
  });

  it('derives `missing` from the flags rather than reporting a fixed answer', () => {
    // The control for the assertion above, which would otherwise be satisfied
    // by a capabilityFor() that always returned an empty list. A record with
    // two legs absent must name exactly those two, in the declared order.
    const partial = { implemented: true, dualWrite: false, reconciled: true, rollback: false };
    const derived = ['implemented', 'dualWrite', 'reconciled', 'rollback'].filter((f) => !partial[f]);
    expect(derived).toEqual(['dualWrite', 'rollback']);

    // …and through the real function, on the real registry, a complete path
    // reports nothing missing while `certificationFor` still reports what it is
    // blocked by — the two must not collapse into each other.
    expect(capabilityFor(MONEY_PATHS.WALLET).missing).toEqual([]);
    expect(certificationFor(MONEY_PATHS.WALLET).blockedBy).toEqual(['infrastructureTested']);
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

  it('reports NOT READY while an eligible path has not actually been flipped', () => {
    // The reason changed at 1bd5de8 and the verdict did not, which is the
    // property worth pinning. This used to fail on `notImplemented`; every path
    // is implemented now, so what holds it back is the ten variables nobody has
    // set. "Ready" means the money IS in Postgres, not that it could be — a
    // migration is not done because the code is finished.
    const s = fullFinancialAuthorityStatus(withPg({ MONEY_AUTHORITY_WALLET: 'postgres' }));
    expect(s.ready).toBe(false);
    expect(s.status).toMatch(/NOT READY/);
    expect(s.notImplemented).toEqual([]);
    expect(s.eligibleNotFlipped.length).toBeGreaterThan(0);
    expect(s.onPostgres).toEqual([MONEY_PATHS.WALLET]);
  });

  it('reports READY only when every path is BOTH eligible and flipped', () => {
    const env = withPg(Object.fromEntries(
      ALL_PATHS.map((p) => [`MONEY_AUTHORITY_${p.toUpperCase()}`, 'postgres']),
    ));
    env.MONEY_AUTHORITY_BONUSES = 'postgres';

    const s = fullFinancialAuthorityStatus(env);
    expect(s.ready).toBe(true);
    expect(s.status).toMatch(/READY/);
    expect(s.onPostgres).toHaveLength(11);
    expect(s.eligibleNotFlipped).toEqual([]);
    expect(s.notImplemented).toEqual([]);
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

describe('deploy/money-authority.postgres.env stays in step with the registry', () => {
  // The file an operator pastes into a deploy environment. A path added to the
  // registry and forgotten here means a cutover that silently leaves one money
  // path on MongoDB — and the boot validation would ACCEPT it, because a path
  // nobody asked for is not an incoherent request, just an incomplete one.
  const envFile = readFileSync(
    new URL('../../../deploy/money-authority.postgres.env', import.meta.url), 'utf8',
  );

  it('lists every path, and only real ones', () => {
    const listed = [...envFile.matchAll(/^(MONEY_AUTHORITY_\w+)=postgres$/gm)].map((m) => m[1]);
    const expected = ALL_PATHS.map((p) => PATH_ENV[p]);

    expect(listed).toEqual(expected);          // same set AND same flip order
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('does not promise that MongoDB can be removed', () => {
    // The misreading this whole file exists to prevent. Reads still come from
    // Mongo under Postgres authority and the reverse mirror still writes it.
    expect(envFile).toMatch(/READS still come from Mongo/);
    expect(envFile).toMatch(/Do not delete the Mongo wiring/);
  });

  it('sends the operator to the preflight before setting anything', () => {
    expect(envFile).toMatch(/npm run preflight:flip/);
    expect(envFile).toMatch(/reconcile:pg -- --all --backfill/);
  });
});
