// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/reconcile.js — hybrid-DB reconciliation (plan steps 3+4). 2026-07-13.
 *
 * Answers, repeatably (staging requirement — not a one-time manual check):
 * "do Mongo and Postgres agree for the money tables?" This is the trust gate
 * before ANY cutover step, and the verification layer the plan wants CDC for —
 * it compares actual store contents (stronger than tailing a change feed;
 * Debezium can be layered on later for continuous streaming verification
 * without changing this contract).
 *
 * Usage:
 *   npm run reconcile:pg                 # verify last 24h; exit 1 on drift
 *   npm run reconcile:pg -- --hours 168  # bigger window
 *   npm run reconcile:pg -- --all --backfill   # initial sync: copy missing Mongo→PG
 *   npm run reconcile:pg -- --reverse          # also check PG→Mongo (auto once a path is on PG)
 *   npm run reconcile:pg -- --repair-mongo     # Phase B fallback: write PG-only rows back to Mongo
 *
 * Checks per table: Mongo-side count vs PG-side count in the window, missing
 * keys (Mongo docs absent from PG), and for accounting_events the trial
 * balance — every event's postings conserve to zero and the per-account sums
 * match between stores (the Postgres equivalent of getTrialBalance /
 * ledgerReconcile.integration.test.js).
 *
 * Also exported as functions so the integration test drives it directly.
 */
import mongoose from 'mongoose';
import { pgConfigured, pgQuery, closePg } from './pgClient.js';
import {
  mirrorWalletLedger, mirrorAccountingEvent, mirrorTransaction,
  mirrorPaymentOrder, mirrorUtr, mirrorMerchantWalletLedger,
} from './dualWrite.js';
import { REVERSE_TABLES } from './reverseMirror.js';
import { anyPathOnPostgres } from './moneyAuthority.js';

// `since` names THIS MODEL'S Mongo timestamp field. It is not `createdAt`
// everywhere: Transaction calls it `timestamp` and UTRRegistry calls it
// `registeredAt`. This used to be hardcoded to `createdAt` for all six, so an
// incremental (--since) reconcile of those two matched ZERO documents and
// reported the table clean while repairing nothing — a silent false negative
// on the exact check that gates the money cutover (§E). The reverse direction
// already modelled this correctly via REVERSE_TABLES' own `since`; this is the
// forward direction catching up. Fixed 2026-07-29.
export const TABLES = [
  { name: 'wallet_ledger',          model: 'WalletLedger',         key: '_id',            pgKey: 'mongo_id',        since: 'createdAt',    mirror: mirrorWalletLedger },
  { name: 'accounting_events',      model: 'AccountingEvent',      key: 'idempotencyKey', pgKey: 'idempotency_key', since: 'createdAt',    mirror: mirrorAccountingEvent },
  { name: 'transactions',           model: 'Transaction',          key: '_id',            pgKey: 'mongo_id',        since: 'timestamp',    mirror: mirrorTransaction },
  { name: 'payment_orders',         model: 'PaymentOrder',         key: '_id',            pgKey: 'mongo_id',        since: 'createdAt',    mirror: mirrorPaymentOrder },
  { name: 'utr_registry',           model: 'UTRRegistry',          key: 'utr',            pgKey: 'utr',             since: 'registeredAt', mirror: mirrorUtr },
  { name: 'merchant_wallet_ledger', model: 'MerchantWalletLedger', key: 'txId',           pgKey: 'tx_id',           since: 'createdAt',    mirror: mirrorMerchantWalletLedger },
];

/** Alias for tests/tooling that assert on the forward reconcile's shape. */
export { TABLES as RECONCILE_TABLES };

export async function reconcileTable(t, { since = null, backfill = false } = {}) {
  const Model = mongoose.model(t.model);
  // Fail loudly rather than silently scanning nothing if a table is ever added
  // to TABLES without declaring which field carries its timestamp.
  if (since && !t.since) {
    throw new Error(`reconcileTable(${t.name}): no 'since' field declared — an incremental run would match zero documents`);
  }
  const filter = since ? { [t.since]: { $gte: since } } : {};
  const docs = await Model.find(filter).limit(50000).lean();

  const keys = docs.map(d => String(d[t.key]));
  let missing = [];
  if (keys.length) {
    const { rows } = await pgQuery(
      `SELECT ${t.pgKey} AS k FROM ${t.name} WHERE ${t.pgKey} = ANY($1)`, [keys]);
    const have = new Set(rows.map(r => r.k));
    missing = docs.filter(d => !have.has(String(d[t.key])));
  }

  let backfilled = 0;
  if (backfill && missing.length) {
    for (const d of missing) { await t.mirror(d); backfilled++; }
    missing = [];
  }

  return { table: t.name, mongoCount: docs.length, missingInPg: missing.length, backfilled,
           sampleMissing: missing.slice(0, 5).map(d => String(d[t.key])) };
}

/**
 * The other direction: Postgres rows with no counterpart in Mongo.
 *
 * Phase A cannot produce these — Mongo is where writes originate, so Postgres
 * is always a subset. They appear only once a path is authoritative in
 * Postgres (Phase B) and the reverse mirror has dropped a row. That is exactly
 * the case DATA_ROLLBACK_PLAN Phase B step 2 has to repair before falling back:
 *
 *   "every PG row since cutover-start missing in Mongo is written back"
 *
 * `repair: true` performs that write-back through the same reverse mirrors the
 * live path uses, so replay stays idempotent against Mongo's unique indexes.
 */
export async function reconcileTableReverse(t, { since = null, repair = false } = {}) {
  // t.since names this table's timestamp column — utr_registry uses
  // registered_at, not created_at. Both are internal identifiers from
  // REVERSE_TABLES, never user input, so interpolating them is safe.
  const tsColumn = t.since;
  const where = since ? `WHERE ${tsColumn} >= $1` : '';
  const { rows } = await pgQuery(
    `SELECT * FROM ${t.table} ${where} ORDER BY ${tsColumn} DESC LIMIT 50000`,
    since ? [since] : [],
  );

  let missing = [];
  if (rows.length) {
    const keys = rows.map((r) => String(r[t.pgKey]));
    const Model = mongoose.model(t.model);
    const found = await Model.find({ [t.mongoKey]: { $in: keys } })
      .select(t.mongoKey).lean();
    const have = new Set(found.map((d) => String(d[t.mongoKey])));
    missing = rows.filter((r) => !have.has(String(r[t.pgKey])));
  }

  let repaired = 0;
  if (repair && missing.length) {
    for (const row of missing) { await t.mirror(row); repaired++; }
    missing = [];
  }

  return {
    table: t.table, pgCount: rows.length, missingInMongo: missing.length, repaired,
    sampleMissing: missing.slice(0, 5).map((r) => String(r[t.pgKey])),
  };
}

/**
 * Trial balance from the MONGO ledger, in the same shape as pgTrialBalance().
 *
 * DATA_ROLLBACK_PLAN Phase B step 3 requires, before falling back, that "the
 * Mongo trial balance (getTrialBalance) equals the PG trial balance". Comparing
 * them needs both sides computed the same way — per account, in integer minor
 * units, summing to zero. Amounts are already integer paise in both stores
 * (AccountingEvent.postings[].amountMinor), so this is an exact comparison with
 * no float rounding anywhere in it.
 */
export async function mongoTrialBalance() {
  const rows = await mongoose.model('AccountingEvent').aggregate([
    { $unwind: '$postings' },
    { $group: { _id: '$postings.account', total_paise: { $sum: '$postings.amountMinor' } } },
    { $sort: { _id: 1 } },
  ]);
  const accounts = rows.map((r) => ({ account: r._id, total_paise: String(r.total_paise) }));
  const grand = accounts.reduce((s, r) => s + BigInt(r.total_paise), 0n);
  return { accounts, grandTotalPaise: grand.toString(), conservesToZero: grand === 0n };
}

/**
 * Do the two ledgers agree, account by account? This is the check that decides
 * whether a cutover may proceed or a fallback is safe — a per-account equality,
 * not just "both sum to zero", because two ledgers can each conserve to zero
 * while disagreeing about which accounts hold the money.
 */
export function compareTrialBalances(mongoTb, pgTb) {
  const toMap = (tb) => new Map(tb.accounts.map((a) => [a.account, BigInt(a.total_paise)]));
  const m = toMap(mongoTb);
  const p = toMap(pgTb);
  const accounts = [...new Set([...m.keys(), ...p.keys()])].sort();

  const differences = accounts
    .map((account) => ({
      account,
      mongoPaise: (m.get(account) ?? 0n).toString(),
      pgPaise: (p.get(account) ?? 0n).toString(),
    }))
    .filter((d) => d.mongoPaise !== d.pgPaise);

  return {
    agree: differences.length === 0
      && mongoTb.conservesToZero
      && pgTb.conservesToZero,
    differences,
  };
}

/** Trial balance on the PG ledger: per-account sums; grand total MUST be 0. */
export async function pgTrialBalance() {
  const { rows } = await pgQuery(`
    SELECT p->>'account' AS account, SUM((p->>'amountPaise')::BIGINT) AS total_paise
    FROM accounting_events, jsonb_array_elements(postings) p
    GROUP BY 1 ORDER BY 1`);
  const grand = rows.reduce((s, r) => s + BigInt(r.total_paise), 0n);
  return { accounts: rows, grandTotalPaise: grand.toString(), conservesToZero: grand === 0n };
}

/**
 * runReconcile — the trust gate.
 *
 * Always checks Mongo→PG (the Phase A direction). Once any path is
 * authoritative in Postgres, ALSO checks PG→Mongo and compares both ledgers
 * account by account, because from that moment Mongo is the copy that can fall
 * behind and the rollback plan depends on it being complete.
 *
 * `reverse` / `repairMongo` force the reverse pass on regardless of the
 * configured authority — needed when running the fallback drill, and when
 * verifying a window after reverting a path to Mongo.
 */
export async function runReconcile({
  hours = 24, all = false, backfill = false,
  reverse = false, repairMongo = false,
} = {}) {
  const since = all ? null : new Date(Date.now() - hours * 3600 * 1000);

  const results = [];
  for (const t of TABLES) results.push(await reconcileTable(t, { since, backfill }));

  const pgTrial = await pgTrialBalance();
  const forwardDrift = results.some((r) => r.missingInPg > 0) || !pgTrial.conservesToZero;

  // The reverse direction only means something once Postgres owns a path — or
  // when an operator explicitly asks for it during a drill or a fallback.
  const checkReverse = reverse || repairMongo || anyPathOnPostgres();
  let reverseResults = null;
  let mongoTrial = null;
  let ledgersAgree = null;
  let reverseDrift = false;

  if (checkReverse) {
    reverseResults = [];
    for (const t of REVERSE_TABLES) {
      reverseResults.push(await reconcileTableReverse(t, { since, repair: repairMongo }));
    }
    mongoTrial = await mongoTrialBalance();
    ledgersAgree = compareTrialBalances(mongoTrial, pgTrial);
    reverseDrift = reverseResults.some((r) => r.missingInMongo > 0) || !ledgersAgree.agree;
  }

  return {
    window: all ? 'all' : `${hours}h`,
    results,
    trialBalance: pgTrial,
    reverse: reverseResults,
    mongoTrialBalance: mongoTrial,
    ledgersAgree,
    drift: forwardDrift || reverseDrift,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (n) => args.includes(`--${n}`);
  const opt  = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d; };

  if (!pgConfigured()) { console.error('DATABASE_URL not set — nothing to reconcile.'); process.exit(1); }
  if (!process.env.MONGODB_URI) { console.error('MONGODB_URI not set.'); process.exit(1); }

  await mongoose.connect(process.env.MONGODB_URI);
  await import('../models/index.js');
  const report = await runReconcile({
    hours: opt('hours', 24), all: flag('all'), backfill: flag('backfill'),
    reverse: flag('reverse'), repairMongo: flag('repair-mongo'),
  });
  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect(); await closePg();
  process.exit(report.drift ? 1 : 0);
}
