// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/moneyAuthority.js — WHICH STORE IS THE SOURCE OF TRUTH, per money path.
 *
 * The hybrid-DB plan (LAUNCH_READINESS.md §E, postgres/DATA_ROLLBACK_PLAN.md)
 * does not flip Postgres on in one step. It flips **one money path at a time**,
 * reads before writes, wallet/ledger first and KYC last, with a rollback ready
 * at every step. Until this module existed there was no mechanism to express
 * that — the code had exactly one hard-wired answer (Mongo), so steps 2 and 3
 * of the documented cutover were not executable at all.
 *
 * This is the switch. It stores no data and performs no I/O; it answers one
 * question — "for path P, who is authoritative right now?" — and every money
 * path asks it instead of assuming.
 *
 * ── Phases (per path, from DATA_ROLLBACK_PLAN) ──────────────────────────────
 *   MONGO     Phase A. Mongo is write-first and the read path; Postgres is a
 *             fire-and-forget mirror (dualWrite.js). Rollback is trivial.
 *             THIS IS THE DEFAULT AND THE ONLY PHASE ANY PATH SHIPS IN.
 *   POSTGRES  Phase B. Postgres is authoritative for reads and writes on this
 *             path; Mongo is kept complete by the reverse mirror
 *             (reverseMirror.js) so falling back stays lossless (RPO zero).
 *
 * Phase C (Mongo write path removed entirely) is deliberately NOT modelled
 * here. It is a data-retention decision plus a PITR-restore drill, not a
 * routing flag, and the plan requires a full staging drill before any path
 * enters it.
 *
 * ── How a flip actually happens ─────────────────────────────────────────────
 * Environment only, one variable per path, so a flip is a deploy-time decision
 * an operator makes deliberately and can revert by redeploying:
 *
 *     MONEY_AUTHORITY_WALLET=postgres
 *     MONEY_AUTHORITY_LEDGER=postgres
 *     MONEY_AUTHORITY_ORDERS=postgres
 *     MONEY_AUTHORITY_KYC=postgres
 *
 * Unset (or any unrecognised value) means MONGO. There is no "flip everything"
 * switch by design — the plan's whole point is that paths move one at a time.
 *
 * ── The gate this module CANNOT enforce ─────────────────────────────────────
 * LAUNCH_READINESS §E: "Do not flip authority until reconciliation has been
 * clean in production repeatedly" — `bb_pg_reconcile_consecutive_clean` green
 * for ≥24h of 5-minute passes, `bb_pg_drift_rows` at 0, and
 * `bb_pg_trial_balance_ok` at 1. That is an operational judgement made by a
 * human reading Grafana; code cannot verify it happened. What this module DOES
 * enforce is that a flip cannot happen *accidentally* or *incoherently*:
 * Postgres authority without DATABASE_URL is refused outright, and an
 * inconsistent combination (ledger on Postgres while wallet is still on Mongo)
 * is refused at boot rather than discovered halfway through a settlement.
 */
import { pgConfigured } from './pgClient.js';

export const STORE = Object.freeze({ MONGO: 'mongo', POSTGRES: 'postgres' });

/**
 * The money paths, in the order the plan flips them. Order matters: `dependsOn`
 * encodes that a path cannot be authoritative in Postgres while a path it reads
 * from is still authoritative in Mongo — that would split a single settlement
 * across two sources of truth.
 */
export const MONEY_PATHS = Object.freeze({
  WALLET: 'wallet',
  LEDGER: 'ledger',
  ORDERS: 'orders',
  KYC:    'kyc',
  // Declared so the registry can report them as UNIMPLEMENTED rather than
  // leaving them invisible. An audit found `moneyAuthority` listing four paths
  // while only `wallet` had a Postgres implementation — the other three would
  // have accepted `=postgres`, passed every check, and changed nothing, which
  // is a worse failure than refusing. These five were not modelled at all even
  // though they move money, so their absence could not be seen.
  MERCHANT_WALLET:         'merchant_wallet',
  MERCHANT_SETTLEMENT:     'merchant_settlement',
  ADMIN_ISSUANCE:          'admin_issuance',
  BETS:                    'bets',
  SETTLEMENTS:             'settlements',
  BONUSES_AND_COMMISSIONS: 'bonuses_and_commissions',
});

/**
 * CAPABILITIES — what actually EXISTS for each path, independent of what an
 * operator has asked for.
 *
 * This is the registry that makes "false authority" impossible. Authority is
 * not a wish expressed in an environment variable; it is a claim that must be
 * backed by four things being true at once:
 *
 *   implemented  a real Postgres reader AND writer exist, and every production
 *                call site routes through the authority resolver
 *   dualWrite    Mongo writes are mirrored to Postgres, so Postgres has the
 *                data a cutover would start reading
 *   reconciled   a reconciliation pass compares the two stores for this path
 *                and can prove they agree
 *   rollback     a reverse mirror or equivalent keeps Mongo current after the
 *                flip, so reverting is lossless
 *
 * A path is eligible for cutover only when all four hold. `authorityFor()`
 * refuses to return Postgres for an ineligible path however the environment is
 * set, and `validateAuthorityConfig()` makes a production boot fail loudly
 * rather than run with a config that lies about where money lives.
 *
 * Keep this honest. A `true` here is a claim that someone can point at the
 * code, the reconciliation query and the rollback path. If you are tempted to
 * flip one to unblock a deploy, the deploy is the thing that is wrong.
 */
const CAPABILITIES = Object.freeze({
  [MONEY_PATHS.WALLET]: {
    implemented: true,  // postgres/walletPg.js + walletPgAuthority.js
    dualWrite:   true,  // postgres/dualWrite.js mirrorWalletLedger
    reconciled:  true,  // postgres/reconcile.js
    rollback:    true,  // postgres/reverseMirror.js
    notes: 'User balances + wallet_ledger. The only path with a complete implementation.',
  },
  [MONEY_PATHS.LEDGER]: {
    implemented: false, // dualWrite mirrors accounting_events, but nothing READS Postgres
    dualWrite:   true,
    reconciled:  true,
    rollback:    true,
    notes: 'accounting_events is mirrored and reconciled, but there is no Postgres reader and no call site consults the authority resolver.',
  },
  [MONEY_PATHS.ORDERS]: {
    implemented: false,
    dualWrite:   true,  // mirrorPaymentOrder, mirrorUtr
    reconciled:  true,
    rollback:    true,
    notes: 'payment_orders + utr_registry are mirrored. No Postgres reader; order state transitions are Mongo-only.',
  },
  [MONEY_PATHS.KYC]: {
    implemented: false,
    dualWrite:   true,  // mirrorUserKyc
    reconciled:  false,
    rollback:    true,
    notes: 'user_kyc is mirrored only. KYC decisions are Mongo-only.',
  },
  [MONEY_PATHS.MERCHANT_WALLET]: {
    // STILL false, deliberately. postgres/merchantWalletPg.js now exists — a
    // real reader and writer, 24 tests green against PostgreSQL 16 — but
    // `implemented` also requires that production call sites ROUTE through the
    // authority resolver, and merchantWallet.service.js does not yet consult
    // it. Flipping this on the strength of the implementation alone would
    // recreate exactly the false-authority hazard this registry exists to
    // prevent: code that exists but is not reached is not authority.
    implemented: false,
    dualWrite:   true,  // mirrorMerchantWalletLedger — ledger only, not the balance
    reconciled:  false, // reconcileMerchant() exists per-merchant; not yet in the reconcile pass
    rollback:    false, // no reverse mirror for merchant balances
    notes: 'Postgres implementation EXISTS (postgres/merchantWalletPg.js: merchant_wallets + merchant_wallet_entries, row-locked, ledger in the same transaction, append-only, 24 tests). Remaining before cutover: route merchantWallet.service.js through the authority resolver, mirror the BALANCE (only the ledger is mirrored today), add it to the reconcile pass, and build the reverse mirror.',
  },
  [MONEY_PATHS.MERCHANT_SETTLEMENT]: {
    implemented: false, dualWrite: false, reconciled: false, rollback: false,
    notes: 'User↔merchant settlement. No Postgres schema or implementation.',
  },
  [MONEY_PATHS.ADMIN_ISSUANCE]: {
    implemented: false, dualWrite: false, reconciled: false, rollback: false,
    notes: 'Admin↔merchant token issuance and deduction. No Postgres schema or implementation.',
  },
  [MONEY_PATHS.BETS]: {
    implemented: false, dualWrite: false, reconciled: false, rollback: false,
    notes: 'Bet lifecycle and stake reservation. Mongo-only. _mongoBetStake has no idempotency key on the balance move (M-2) and writes its ledger outside the transaction (M-4) — both must be resolved in the Postgres design rather than ported.',
  },
  [MONEY_PATHS.SETTLEMENTS]: {
    implemented: false, dualWrite: false, reconciled: false, rollback: false,
    notes: 'Cycle settlement and payout. Mongo-only.',
  },
  [MONEY_PATHS.BONUSES_AND_COMMISSIONS]: {
    implemented: false, dualWrite: false, reconciled: false, rollback: false,
    notes: 'Bonus engine and referral commission. Mongo-only.',
  },
});

/** Every capability flag that must be true before a path may carry authority. */
const REQUIRED_CAPABILITIES = Object.freeze(['implemented', 'dualWrite', 'reconciled', 'rollback']);

/**
 * capabilityFor — the registry entry for a path, plus the derived eligibility
 * and the specific reasons it is not eligible. The `missing` list is what an
 * operator needs in order to know what work remains.
 */
export function capabilityFor(path) {
  const cap = CAPABILITIES[path];
  if (!cap) throw new Error(`Unknown money path '${path}'. Known paths: ${ALL_PATHS.join(', ')}`);
  const missing = REQUIRED_CAPABILITIES.filter((flag) => !cap[flag]);
  return { ...cap, missing, cutoverEligible: missing.length === 0 };
}

/** May this path carry Postgres authority at all? */
export function isCutoverEligible(path) {
  return capabilityFor(path).cutoverEligible;
}

/**
 * Dependencies of `path` that are NOT yet authoritative in Postgres.
 *
 * Exported so the ordering rule stays directly testable. validateAuthorityConfig
 * checks capability first and stops there for an ineligible path — reporting
 * "ledger is out of order" alongside "ledger has no implementation" would be
 * noise — but that short-circuit would otherwise leave this rule uncovered
 * until a second path becomes eligible, which is exactly when a regression
 * would be most expensive.
 */
export function laggingDependencies(path, env = process.env) {
  if (!isKnownPath(path)) {
    throw new Error(`Unknown money path '${path}'. Known paths: ${ALL_PATHS.join(', ')}`);
  }
  return PATH_SPEC[path].dependsOn.filter((dep) => authorityFor(dep, env) !== STORE.POSTGRES);
}

const PATH_SPEC = Object.freeze({
  [MONEY_PATHS.WALLET]: {
    env: 'MONEY_AUTHORITY_WALLET',
    order: 1,
    dependsOn: [],
    describes: 'user balances + WalletLedger (wallets, wallet_ledger)',
  },
  [MONEY_PATHS.LEDGER]: {
    env: 'MONEY_AUTHORITY_LEDGER',
    order: 2,
    // The accounting ledger is derived from completed money movements, so it
    // cannot be authoritative in Postgres while balances still are in Mongo.
    dependsOn: [MONEY_PATHS.WALLET],
    describes: 'double-entry accounting events + merchant wallet ledger',
  },
  [MONEY_PATHS.ORDERS]: {
    env: 'MONEY_AUTHORITY_ORDERS',
    order: 3,
    dependsOn: [MONEY_PATHS.WALLET, MONEY_PATHS.LEDGER],
    describes: 'payment orders + UTR registry',
  },
  [MONEY_PATHS.KYC]: {
    env: 'MONEY_AUTHORITY_KYC',
    order: 4,
    // Plan step 7: KYC cuts over LAST, after every money path is settled.
    dependsOn: [MONEY_PATHS.WALLET, MONEY_PATHS.LEDGER, MONEY_PATHS.ORDERS],
    describes: 'KYC submissions and status',
  },

  // ── Paths that move money but were never modelled ─────────────────────────
  // Declared with an env var and a dependency edge so the registry can report
  // them, the matrix shows the true size of the remaining work, and setting one
  // to `postgres` fails the boot instead of doing nothing. None is implemented,
  // so none can currently be flipped.
  //
  // NOTE on ordering: these follow the existing 1–4 numbering, which flips
  // WALLET FIRST. A proposal to resequence with the user wallet LAST (ledger →
  // merchant wallet → orders → bets → bonuses → user wallet) is a defensible
  // and arguably safer order, but it inverts the `dependsOn` graph above and
  // would change validation for the one path that is currently eligible. That
  // resequencing is a decision, not a refactor — see
  // docs/POSTGRES_FULL_AUTHORITY_PLAN.md.
  [MONEY_PATHS.MERCHANT_WALLET]: {
    env: 'MONEY_AUTHORITY_MERCHANT_WALLET',
    order: 5,
    dependsOn: [MONEY_PATHS.LEDGER],
    describes: 'merchant token balances + merchant wallet ledger',
  },
  [MONEY_PATHS.MERCHANT_SETTLEMENT]: {
    env: 'MONEY_AUTHORITY_MERCHANT_SETTLEMENT',
    order: 6,
    dependsOn: [MONEY_PATHS.MERCHANT_WALLET, MONEY_PATHS.ORDERS],
    describes: 'user↔merchant settlement of deposits and withdrawals',
  },
  [MONEY_PATHS.ADMIN_ISSUANCE]: {
    env: 'MONEY_AUTHORITY_ADMIN_ISSUANCE',
    order: 7,
    dependsOn: [MONEY_PATHS.MERCHANT_WALLET],
    describes: 'admin↔merchant token issuance and deduction',
  },
  [MONEY_PATHS.BETS]: {
    env: 'MONEY_AUTHORITY_BETS',
    order: 8,
    dependsOn: [MONEY_PATHS.WALLET, MONEY_PATHS.LEDGER],
    describes: 'bet lifecycle + stake reservation',
  },
  [MONEY_PATHS.SETTLEMENTS]: {
    env: 'MONEY_AUTHORITY_SETTLEMENTS',
    order: 9,
    dependsOn: [MONEY_PATHS.BETS, MONEY_PATHS.WALLET, MONEY_PATHS.LEDGER],
    describes: 'cycle settlement and payout',
  },
  [MONEY_PATHS.BONUSES_AND_COMMISSIONS]: {
    env: 'MONEY_AUTHORITY_BONUSES',
    order: 10,
    dependsOn: [MONEY_PATHS.WALLET, MONEY_PATHS.LEDGER],
    describes: 'bonus engine + referral commission',
  },
});

export const ALL_PATHS = Object.freeze(
  Object.keys(PATH_SPEC).sort((a, b) => PATH_SPEC[a].order - PATH_SPEC[b].order)
);

function isKnownPath(path) {
  return Object.prototype.hasOwnProperty.call(PATH_SPEC, path);
}

/**
 * The store an operator has ASKED for on this path, before safety checks.
 * Anything other than an exact case-insensitive 'postgres' reads as Mongo —
 * a typo must never be interpreted as "move the source of truth for money".
 */
function requestedStore(path, env) {
  const raw = env[PATH_SPEC[path].env];
  return String(raw ?? '').trim().toLowerCase() === STORE.POSTGRES
    ? STORE.POSTGRES
    : STORE.MONGO;
}

/**
 * authorityFor — the store that is authoritative for `path` right now.
 *
 * Fails SAFE: if Postgres authority is requested but Postgres is not
 * configured, this returns MONGO. Returning POSTGRES there would send the app
 * looking for balances in a database it has no connection to.
 */
export function authorityFor(path, env = process.env) {
  if (!isKnownPath(path)) {
    throw new Error(`Unknown money path '${path}'. Known paths: ${ALL_PATHS.join(', ')}`);
  }
  if (requestedStore(path, env) !== STORE.POSTGRES) return STORE.MONGO;
  if (!pgConfigured()) return STORE.MONGO;
  // The capability gate. A path without a complete Postgres implementation can
  // never be authoritative, whatever the environment says — otherwise setting
  // the variable would move the *claim* without moving the *code*, and reads
  // would go to a store that does not own the data. validateAuthorityConfig
  // turns this into a boot failure rather than a silent downgrade, but the
  // runtime resolver has to fail safe on its own too: anything that calls
  // authorityFor() without having gone through boot validation (a script, a
  // test, a worker) still gets the truthful answer.
  if (!isCutoverEligible(path)) return STORE.MONGO;
  return STORE.POSTGRES;
}

export function isPostgresAuthoritative(path, env = process.env) {
  return authorityFor(path, env) === STORE.POSTGRES;
}

/** True when at least one path has moved — i.e. the reverse mirror must run. */
export function anyPathOnPostgres(env = process.env) {
  return ALL_PATHS.some((p) => isPostgresAuthoritative(p, env));
}

/** The full matrix, for /health, boot logging and the admin cutover view. */
export function authorityMatrix(env = process.env) {
  return ALL_PATHS.map((path) => {
    const capability = capabilityFor(path);
    return {
      path,
      describes: PATH_SPEC[path].describes,
      requested: requestedStore(path, env),
      // `effective` is the ONLY field anything should act on. It already
      // accounts for the capability gate, so it can never say 'postgres' for a
      // path whose writes still go to MongoDB — which is what health endpoints
      // and the metrics gauge report.
      effective: authorityFor(path, env),
      implemented:     capability.implemented,
      dualWriteCapable: capability.dualWrite,
      reconciled:      capability.reconciled,
      rollbackCapable: capability.rollback,
      cutoverEligible: capability.cutoverEligible,
      missing:         capability.missing,
      notes:           capability.notes,
    };
  });
}

/**
 * POSTGRES_FULL_FINANCIAL_AUTHORITY — one honest answer to "is the migration
 * done?", for the certification report and any dashboard that asks.
 *
 * READY requires every declared money path to be BOTH eligible and actually
 * authoritative in Postgres. Anything less is NOT_READY with the specific
 * paths named, so the gap can never be hidden behind a configuration flag.
 */
export function fullFinancialAuthorityStatus(env = process.env) {
  const matrix = authorityMatrix(env);
  const notImplemented = matrix.filter((m) => !m.implemented).map((m) => m.path);
  const eligibleNotFlipped = matrix
    .filter((m) => m.cutoverEligible && m.effective !== STORE.POSTGRES)
    .map((m) => m.path);
  const onPostgres = matrix.filter((m) => m.effective === STORE.POSTGRES).map((m) => m.path);

  return {
    status: notImplemented.length === 0 && eligibleNotFlipped.length === 0
      ? 'POSTGRES_FULL_FINANCIAL_AUTHORITY = READY'
      : 'POSTGRES_FULL_FINANCIAL_AUTHORITY = NOT READY',
    ready: notImplemented.length === 0 && eligibleNotFlipped.length === 0,
    totalPaths: matrix.length,
    onPostgres,
    eligibleNotFlipped,
    notImplemented,
  };
}

/**
 * validateAuthorityConfig — refuse an incoherent cutover configuration.
 *
 * Two failures are possible and both are worth stopping a boot for, because
 * either one means money would be read from a store that does not own it:
 *
 *  1. A path requests Postgres while DATABASE_URL is unset. The request is
 *     silently downgraded to Mongo by authorityFor(), which is the safe
 *     behaviour, but shipping a deploy that *believes* it cut over when it did
 *     not is its own hazard — so it is reported.
 *  2. A path is on Postgres while one of its dependencies is still on Mongo
 *     (e.g. ledger cut over but wallet did not). A single settlement would then
 *     read balances from one store and write accounting to another, and no
 *     reconciliation could tell you which was right.
 *
 * Returns { ok, errors[], warnings[] } rather than throwing, so the caller
 * decides whether this is fatal (production boot) or a warning (a test).
 */
export function validateAuthorityConfig(env = process.env) {
  const errors = [];
  const warnings = [];

  for (const path of ALL_PATHS) {
    const requested = requestedStore(path, env);
    if (requested !== STORE.POSTGRES) continue;

    if (!pgConfigured()) {
      warnings.push(
        `${PATH_SPEC[path].env}=postgres but DATABASE_URL is unset — '${path}' stays on MongoDB. ` +
        `Set DATABASE_URL or remove the variable so the intent matches reality.`
      );
      continue;
    }

    // The capability gate, as a BOOT FAILURE rather than a silent downgrade.
    // This is the check whose absence let `MONEY_AUTHORITY_LEDGER=postgres` be
    // accepted while every ledger read and write still went to MongoDB — the
    // config, the boot log and the metrics gauge all claiming a cutover that
    // had not happened. Refusing to start is the only response that cannot be
    // mistaken for success.
    const capability = capabilityFor(path);
    if (!capability.cutoverEligible) {
      errors.push(
        `${PATH_SPEC[path].env}=postgres but '${path}' is NOT eligible for cutover — missing: ` +
        `${capability.missing.join(', ')}. ${capability.notes} ` +
        `Setting this variable would change what the system CLAIMS without changing where money is ` +
        `read or written. Build the missing pieces (see docs/POSTGRES_FULL_AUTHORITY_PLAN.md) or ` +
        `remove ${PATH_SPEC[path].env}.`
      );
      continue; // dependency check below is meaningless for a path that cannot flip
    }

    const laggingDeps = laggingDependencies(path, env);
    if (laggingDeps.length) {
      errors.push(
        `'${path}' is set to Postgres but ${laggingDeps.map((d) => `'${d}'`).join(', ')} ` +
        `${laggingDeps.length === 1 ? 'is' : 'are'} still on MongoDB. The plan flips paths in order ` +
        `(${ALL_PATHS.join(' → ')}); a settlement that spans both stores has no single source of truth. ` +
        `Cut over ${laggingDeps.map((d) => PATH_SPEC[d].env).join(' and ')} first, or revert ${PATH_SPEC[path].env}.`
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Called once at boot. Logs the matrix when anything has moved, and returns the
 * validation result so server.js can refuse to start on an incoherent config.
 * Silent in the default all-Mongo case — the overwhelmingly common state should
 * not add noise to every boot.
 */
export function reportAuthorityAtBoot(env = process.env) {
  const result = validateAuthorityConfig(env);

  for (const w of result.warnings) console.warn(`⚠️  [money-authority] ${w}`);
  for (const e of result.errors)   console.error(`❌ [money-authority] ${e}`);

  if (anyPathOnPostgres(env)) {
    const moved = authorityMatrix(env).filter((r) => r.effective === STORE.POSTGRES);
    console.log(
      `💰 [money-authority] Postgres is the source of truth for: ${moved.map((r) => r.path).join(', ')}. ` +
      `Mongo is kept complete by the reverse mirror — rollback per postgres/DATA_ROLLBACK_PLAN.md Phase B.`
    );
  }

  return result;
}
