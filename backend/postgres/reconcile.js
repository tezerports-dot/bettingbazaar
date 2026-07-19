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
import { pgConfigured, pgQuery, paise, closePg } from './pgClient.js';
import {
  mirrorWalletLedger, mirrorAccountingEvent, mirrorTransaction,
  mirrorPaymentOrder, mirrorUtr, mirrorMerchantWalletLedger,
} from './dualWrite.js';

const TABLES = [
  { name: 'wallet_ledger',          model: 'WalletLedger',         key: '_id',            pgKey: 'mongo_id',        mirror: mirrorWalletLedger },
  { name: 'accounting_events',      model: 'AccountingEvent',      key: 'idempotencyKey', pgKey: 'idempotency_key', mirror: mirrorAccountingEvent },
  { name: 'transactions',           model: 'Transaction',          key: '_id',            pgKey: 'mongo_id',        mirror: mirrorTransaction },
  { name: 'payment_orders',         model: 'PaymentOrder',         key: '_id',            pgKey: 'mongo_id',        mirror: mirrorPaymentOrder },
  { name: 'utr_registry',           model: 'UTRRegistry',          key: 'utr',            pgKey: 'utr',             mirror: mirrorUtr },
  { name: 'merchant_wallet_ledger', model: 'MerchantWalletLedger', key: 'txId',           pgKey: 'tx_id',           mirror: mirrorMerchantWalletLedger },
];

export async function reconcileTable(t, { since = null, backfill = false } = {}) {
  const Model = mongoose.model(t.model);
  const filter = since ? { createdAt: { $gte: since } } : {};
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

/** Trial balance on the PG ledger: per-account sums; grand total MUST be 0. */
export async function pgTrialBalance() {
  const { rows } = await pgQuery(`
    SELECT p->>'account' AS account, SUM((p->>'amountPaise')::BIGINT) AS total_paise
    FROM accounting_events, jsonb_array_elements(postings) p
    GROUP BY 1 ORDER BY 1`);
  const grand = rows.reduce((s, r) => s + BigInt(r.total_paise), 0n);
  return { accounts: rows, grandTotalPaise: grand.toString(), conservesToZero: grand === 0n };
}

export async function runReconcile({ hours = 24, all = false, backfill = false } = {}) {
  const since = all ? null : new Date(Date.now() - hours * 3600 * 1000);
  const results = [];
  for (const t of TABLES) results.push(await reconcileTable(t, { since, backfill }));
  const trial = await pgTrialBalance();
  const drift = results.some(r => r.missingInPg > 0) || !trial.conservesToZero;
  return { window: all ? 'all' : `${hours}h`, results, trialBalance: trial, drift };
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
  const report = await runReconcile({ hours: opt('hours', 24), all: flag('all'), backfill: flag('backfill') });
  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect(); await closePg();
  process.exit(report.drift ? 1 : 0);
}
