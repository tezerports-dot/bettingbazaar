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
});

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
  return ALL_PATHS.map((path) => ({
    path,
    describes: PATH_SPEC[path].describes,
    requested: requestedStore(path, env),
    effective: authorityFor(path, env),
  }));
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

    const laggingDeps = PATH_SPEC[path].dependsOn.filter(
      (dep) => authorityFor(dep, env) !== STORE.POSTGRES
    );
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
