// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * preflightFlip.js — may the money move to PostgreSQL, and what exactly to set.
 *
 *     npm run preflight:flip
 *
 * Turns the cutover from a judgement call into one command with an exit code.
 * It CHECKS and PRINTS; it changes nothing and writes nothing.
 *
 * ── Two situations, and they are not the same cutover ───────────────────────
 *
 * MIGRATION — the platform has been live and MongoDB holds real money. The
 * flip is dangerous in a specific way: every state check reads
 * `SELECT … FROM <the postgres table>`, so a table that was never mirrored is
 * invisible to it and reports clean while being empty. Authority must not move
 * until adoption has run and reconciliation is repeatedly clean.
 *
 * GREENFIELD — the platform has never launched, so there is nothing to
 * migrate. Both stores are empty, `--backfill` has nothing to adopt, and
 * "reconciliation is clean" is trivially true because there is nothing to
 * compare. Waiting for a clean migration signal here is waiting for evidence
 * that cannot exist, and treating the trivial pass as if it meant something is
 * worse — it is a green light with no information behind it.
 *
 * So this script decides which situation it is IN, from the data, and applies
 * the gates that actually mean something in that situation. It says which one
 * it chose and why, because the two conclusions carry very different weight.
 *
 * ── What it will not do ─────────────────────────────────────────────────────
 * It does not check `infrastructureTested`, because nothing in a database can.
 * That is the staging campaign in GO_LIVE_RUNBOOK §2.2 — restart Postgres under
 * load, restart Mongo's primary, kill a backend mid-transaction, run two
 * instances — and a green preflight is not a substitute for it. The report says
 * so on every run rather than letting a passing exit code imply it.
 */
import mongoose from 'mongoose';
import { pgConfigured, pgQuery, closePg, applySchema } from './pgClient.js';
import {
  ALL_PATHS, PATH_ENV, capabilityFor, certificationFor, authorityFor, STORE,
  validateAuthorityConfig,
} from './moneyAuthority.js';
import { runReconcile } from './reconcile.js';

/** Money that would have to be migrated. Emptiness here is what greenfield means. */
const MONGO_MONEY_COLLECTIONS = [
  'users', 'wallets', 'walletledgers', 'accountingevents', 'transactions',
  'paymentorders', 'bets', 'merchants', 'merchantwalletledgers',
];
const PG_MONEY_TABLES = [
  'wallets', 'wallet_ledger', 'accounting_events', 'transactions',
  'payment_orders', 'order_states', 'bets', 'user_kyc',
  'casino_transactions', 'merchant_wallets', 'treasury_entries', 'bonus_grants',
];

const ok = (b) => (b ? 'PASS' : 'FAIL');

async function countPg(table) {
  try {
    const { rows } = await pgQuery(`SELECT count(*)::int AS n FROM ${table}`, [], 'preflight_count');
    return rows[0].n;
  } catch { return null; } // table absent — reported, not thrown
}

async function countMongo(name) {
  try { return await mongoose.connection.db.collection(name).estimatedDocumentCount(); }
  catch { return 0; }
}

/**
 * Is there money in either store? A single row anywhere makes this a MIGRATION,
 * because the one thing that must never happen is treating live data as
 * greenfield and skipping adoption.
 */
async function assessPopulation() {
  const pg = {};
  for (const t of PG_MONEY_TABLES) pg[t] = await countPg(t);
  const mongo = {};
  for (const c of MONGO_MONEY_COLLECTIONS) mongo[c] = await countMongo(c);

  const pgRows = Object.values(pg).reduce((s, n) => s + (n || 0), 0);
  const mongoRows = Object.values(mongo).reduce((s, n) => s + (n || 0), 0);
  return { pg, mongo, pgRows, mongoRows, greenfield: pgRows === 0 && mongoRows === 0 };
}

export async function preflight({ json = false, silent = false } = {}) {
  const report = { checks: [], greenfield: null, ready: false, plan: [], warnings: [] };
  const check = (name, passed, detail) => {
    report.checks.push({ name, passed, detail });
    if (!json && !silent) console.log(`  [${ok(passed)}] ${name}${detail ? ` — ${detail}` : ''}`);
    return passed;
  };

  if (!json && !silent) console.log('\n── Capability gates ' + '─'.repeat(50));

  // 1. Every path must be cutover-eligible. This is the registry's own gate and
  //    it is the one the resolver already enforces at runtime, so a failure
  //    here means the flip would silently do nothing.
  let allEligible = true;
  for (const path of ALL_PATHS) {
    const cap = capabilityFor(path);
    if (!cap.cutoverEligible) {
      allEligible = false;
      check(`${path} is cutover-eligible`, false, `missing: ${cap.missing.join(', ')}`);
    }
  }
  check('all paths cutover-eligible', allEligible, `${ALL_PATHS.length} paths`);

  // 2. Concurrency evidence. Separate from capability on purpose: a path can be
  //    complete and never have been raced.
  const unraced = ALL_PATHS.filter((p) => !certificationFor(p).concurrencyTested);
  check('all paths concurrency-tested', unraced.length === 0,
    unraced.length ? `not raced: ${unraced.join(', ')}` : `${ALL_PATHS.length} paths`);

  // 3. Postgres reachable and the schema present. A missing column here is the
  //    42703 that takes down every settlement — see the note on bets.mongo_id.
  const pgUp = pgConfigured();
  check('DATABASE_URL configured', pgUp);
  if (!pgUp) return finish(report, json, silent);
  await applySchema();
  check('schema applied', true, 'idempotent; ALTERs reach an existing database');

  if (!json && !silent) console.log('\n── What is in the stores ' + '─'.repeat(45));
  const pop = await assessPopulation();
  report.greenfield = pop.greenfield;
  report.population = { pgRows: pop.pgRows, mongoRows: pop.mongoRows };

  if (pop.greenfield) {
    if (!json && !silent) {
      console.log('  GREENFIELD — both stores are empty. There is nothing to migrate.');
      console.log('  Adoption and drift checks are SKIPPED because they would pass');
      console.log('  trivially, and a trivial pass is not evidence.');
    }
    check('no money in either store', true, 'pg 0 rows, mongo 0 documents');
  } else {
    if (!json && !silent) {
      console.log(`  MIGRATION — pg ${pop.pgRows} rows, mongo ${pop.mongoRows} documents.`);
      console.log('  Adoption must have run and reconciliation must be clean.');
    }
    // 4. Reconciliation, for real. `--all` because a windowed pass silently
    //    matches only recent rows and reports the rest clean.
    const rec = await runReconcile({ all: true, backfill: false });
    check('reconcile reports no drift', !rec.drift,
      rec.drift ? 'run `reconcile:pg -- --all --backfill` and re-check' : 'clean over all rows');
    check('trial balance closes', rec.trialBalance?.ok !== false,
      JSON.stringify(rec.trialBalance ?? {}).slice(0, 120));
    check('ledgers agree across stores', rec.ledgersAgree !== false);

    // 5. The four lifecycle tables. These are reachable by no forward mirror,
    //    so an un-adopted one is empty and every check over it reads clean.
    for (const [table, mongoCount] of [
      ['order_states', pop.mongo.paymentorders],
      ['bets', pop.mongo.bets],
      ['user_kyc', pop.mongo.users],
    ]) {
      const n = await countPg(table);
      check(`${table} adopted`, !(mongoCount > 0 && (n ?? 0) === 0),
        `pg ${n} vs mongo ${mongoCount}`);
    }
    report.warnings.push(
      'Reconciliation must have been clean REPEATEDLY, not once. This checks the '
      + 'current pass only — bb_pg_reconcile_consecutive_clean is the real signal.',
    );
  }

  // 6. The ordered plan. Printed whatever the verdict, because seeing it is
  //    useful even when a gate failed.
  report.plan = ALL_PATHS.map((p) => `${PATH_ENV[p]}=postgres`);

  // 7. Coherence: would boot accept the full set?
  const env = { ...process.env };
  for (const p of ALL_PATHS) env[PATH_ENV[p]] = 'postgres';
  const validation = validateAuthorityConfig(env);
  check('the full configuration boots', validation.ok,
    validation.errors[0] ?? 'dependency order satisfied');
  const resolved = ALL_PATHS.filter((p) => authorityFor(p, env) === STORE.POSTGRES);
  check('all paths resolve to postgres', resolved.length === ALL_PATHS.length,
    `${resolved.length}/${ALL_PATHS.length}`);

  return finish(report, json, silent);
}

function finish(report, json, silent = false) {
  report.ready = report.checks.every((c) => c.passed);

  if (silent) return report;
  if (json) { console.log(JSON.stringify(report, null, 2)); return report; }

  console.log('\n── Verdict ' + '─'.repeat(59));
  if (report.ready) {
    console.log('  PREFLIGHT PASSED. Set these, in this order, one deploy at a time:\n');
    for (const line of report.plan) console.log(`     ${line}`);
    console.log('\n  Rolling back is a redeploy: unset the variable. The reverse mirrors');
    console.log('  keep MongoDB current while Postgres is authoritative, which is what');
    console.log('  makes that lossless.');
  } else {
    const failed = report.checks.filter((c) => !c.passed).map((c) => c.name);
    console.log(`  PREFLIGHT FAILED — ${failed.length} gate(s): ${failed.join('; ')}`);
    console.log('  Do not set any MONEY_AUTHORITY_* variable.');
  }

  for (const w of report.warnings) console.log(`\n  NOTE: ${w}`);
  console.log('\n  NOT CHECKED, and no database can check it: infrastructureTested is 0/11.');
  console.log('  Restart Postgres under load, restart Mongo\'s primary, kill a backend');
  console.log('  mid-transaction, run two instances. GO_LIVE_RUNBOOK.md §2.2.');
  console.log('  A passing preflight does not mean the platform is certified.\n');
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const json = process.argv.includes('--json');
  const uri = process.env.MONGODB_URI;
  // The refusal is NOT conditional on the output format. An earlier version
  // guarded only the human path, so `--json` — the form a deploy pipeline would
  // actually call — skipped the check, read every Mongo count as zero and
  // reported a live platform as greenfield. That is the single worst answer
  // this script can give, and it was reachable by adding a flag.
  if (!uri) {
    const msg = 'MONGODB_URI is not set. Mongo-side counts would read as zero, so a live '
      + 'platform would be misreported as GREENFIELD and adoption skipped. Refusing.';
    if (json) console.log(JSON.stringify({ ready: false, error: msg }, null, 2));
    else console.log(`\n  ${msg}\n  Set it, even for a greenfield check.\n`);
    process.exit(2);
  }
  await mongoose.connect(uri);
  await import('../models/index.js');
  const report = await preflight({ json });
  if (uri) await mongoose.disconnect();
  await closePg();
  process.exit(report.ready ? 0 : 1);
}
