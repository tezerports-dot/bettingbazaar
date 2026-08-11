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
 *                                              # (also ADOPTS order_states,
 *                                              #  user_kyc, casino_* and bets —
 *                                              #  the tables no other path
 *                                              #  reaches; see
 *                                              #  backfillLifecycleTables)
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
import { rupeesToPaise, paiseToRupees } from '../shared/money.js';
import {
  mirrorWalletLedger, mirrorAccountingEvent, mirrorTransaction,
  mirrorPaymentOrder, mirrorUtr, mirrorMerchantWalletLedger, mirrorMerchantBalance,
  mirrorMerchantSettlement,
} from './dualWrite.js';
import {
  REVERSE_TABLES, reverseMirrorMerchantBalance, reverseMirrorMerchantSettlement,
} from './reverseMirror.js';
import { anyPathOnPostgres, isPostgresAuthoritative, MONEY_PATHS } from './moneyAuthority.js';

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
  // `where` excludes rows the mirror deliberately does not copy. A merchant
  // ledger row with a null balanceAfter is an in-flight RESERVATION: the
  // service has not yet learned the resulting balance, and the row may still
  // be deleted. Without this filter every concurrent reservation would read
  // as drift and the cutover-readiness streak would reset on ordinary traffic.
  { name: 'merchant_wallet_ledger', model: 'MerchantWalletLedger', key: 'txId',           pgKey: 'tx_id',           since: 'createdAt',    mirror: mirrorMerchantWalletLedger, where: { balanceAfter: { $ne: null } } },
];

/** Alias for tests/tooling that assert on the forward reconcile's shape. */
export { TABLES as RECONCILE_TABLES };

/**
 * ── The settling window ─────────────────────────────────────────────────────
 *
 * Every mirror except the admin-issuance one is FIRE-AND-FORGET: the write
 * commits in the authoritative store, the mirror is dispatched, and the caller
 * returns without waiting. That is deliberate — a Postgres round-trip inside
 * every wallet movement is a worse trade than a brief inconsistency, and the
 * Mongoose post-save hooks the forward mirrors hang off cannot be awaited at
 * all.
 *
 * The consequence is that a reconcile running at the wrong instant sees a row
 * in one store and not yet the other, and calls it drift. That is a FALSE
 * POSITIVE on ordinary traffic, and a drift alarm that fires on ordinary
 * traffic is one an operator learns to ignore — which costs more than the
 * check is worth.
 *
 * So findings younger than this window are reported SEPARATELY as `settling`
 * rather than counted as drift. Three properties make that safe rather than a
 * way of hiding problems:
 *
 *  1. It is a DELAY, not an exemption. The same row is checked at full strength
 *     on the next pass, by which time it is older than the window. Nothing is
 *     permanently excused.
 *  2. `settling` is REPORTED, not dropped. A mirror that is genuinely broken
 *     produces a settling count that keeps growing instead of returning to
 *     zero, which is a stronger and earlier signal than a drift count that was
 *     always noisy.
 *  3. The window is bounded to seconds. Anything a mirror has not managed in
 *     that time is not "in flight", it has failed — and the reconcile is the
 *     backstop that repairs it.
 *
 * Deliberately NOT solved with a retry queue. A durable queue would make the
 * retry survive a restart, which is worth having eventually, but it does not
 * remove this window — a queued write is still a write that has not landed, so
 * the reconciler would need exactly the same tolerance on top of it.
 */
export const DEFAULT_SETTLING_WINDOW_MS = 30_000;

/**
 * Read per call rather than captured at import, so an operator can widen it on
 * a struggling replica — or a test can set it to 0 — without a restart. This is
 * a batch reconciler, so the cost of reading an env var per pass is nothing.
 *
 * A non-numeric or negative value falls back to the default rather than
 * disabling the window by accident; 0 is honoured, because "check everything
 * immediately" is a legitimate thing to ask for.
 */
export function settlingWindowMs() {
  const raw = Number(process.env.RECONCILE_SETTLING_WINDOW_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SETTLING_WINDOW_MS;
}

/** The instant before which a missing mirror is a real failure, not lag. */
const settledBefore = () => new Date(Date.now() - settlingWindowMs());

/**
 * Split findings into the ones old enough to mean something and the ones still
 * in flight. `at` extracts the row's own timestamp; a row with no usable
 * timestamp counts as SETTLED, because "we cannot tell how old this is" must
 * not silently become "assume it is new and ignore it".
 */
function splitBySettling(items, at) {
  const cutoff = settledBefore();
  const settled = [];
  const settling = [];
  for (const item of items) {
    const ts = at(item);
    const date = ts ? new Date(ts) : null;
    if (date && !Number.isNaN(date.getTime()) && date > cutoff) settling.push(item);
    else settled.push(item);
  }
  return { settled, settling };
}

export async function reconcileTable(t, { since = null, backfill = false } = {}) {
  const Model = mongoose.model(t.model);
  // Fail loudly rather than silently scanning nothing if a table is ever added
  // to TABLES without declaring which field carries its timestamp.
  if (since && !t.since) {
    throw new Error(`reconcileTable(${t.name}): no 'since' field declared — an incremental run would match zero documents`);
  }
  const filter = { ...(t.where ?? {}), ...(since ? { [t.since]: { $gte: since } } : {}) };
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
    // A backfill repairs everything, in flight or not — it is an explicit
    // operator action, and re-mirroring a row the async mirror was about to
    // write is idempotent by every key in this system.
    for (const d of missing) { await t.mirror(d); backfilled++; }
    missing = [];
  }

  // Rows written moments ago whose mirror has not landed yet are not drift.
  const { settled, settling } = splitBySettling(missing, (d) => d[t.since]);

  return { table: t.name, mongoCount: docs.length, missingInPg: settled.length, backfilled,
           settling: settling.length,
           sampleMissing: settled.slice(0, 5).map(d => String(d[t.key])) };
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

  const { settled, settling } = splitBySettling(missing, (r) => r[t.since]);

  return {
    table: t.table, pgCount: rows.length, missingInMongo: settled.length, repaired,
    settling: settling.length,
    sampleMissing: settled.slice(0, 5).map((r) => String(r[t.pgKey])),
  };
}

/**
 * reconcileMerchantBalances — do the two stores agree on what each merchant HAS?
 *
 * The row-presence checks above cannot answer this. `merchant_wallet_ledger`
 * can hold every row Mongo holds, and `merchant_wallets` can hold a row for
 * every merchant, while the NUMBERS differ — a mirror that dropped one update,
 * a movement that landed in one store only. Presence reconciliation reports
 * clean and the cutover gate advances on a balance that is wrong.
 *
 * This is the balance equivalent of the trial balance, and it is the check that
 * `capabilities.merchant_wallet.reconciled` actually means. It runs in both
 * phases and needs no window: a balance is a current position, not an event, so
 * "drift in the last 24h" is not a meaningful question — every merchant is
 * compared, every pass.
 *
 * Repair direction follows authority, and is never guessed:
 *   - `backfill`    Mongo → Postgres (Phase A: Mongo owns the number)
 *   - `repairMongo` Postgres → Mongo (Phase B: Postgres owns it)
 * Asking for both is a contradiction and is refused rather than resolved.
 */
export async function reconcileMerchantBalances({ backfill = false, repairMongo = false } = {}) {
  if (backfill && repairMongo) {
    throw new Error('reconcileMerchantBalances: backfill and repairMongo are opposite directions — pick one');
  }

  const merchants = await mongoose.model('Merchant').find({})
    .select('tokenBalance').limit(50000).lean();

  const { rows } = await pgQuery(
    `SELECT merchant_id, available_paise, reserved_paise, settlement_paise, updated_at
       FROM merchant_wallets`,
    [], 'merchant_balance_reconcile',
  );
  const pgById = new Map(rows.map((r) => [String(r.merchant_id), r]));

  const found = [];
  let repaired = 0;

  for (const m of merchants) {
    const id = String(m._id);
    // Mongo stores float rupees; Postgres integer paise. Compare in paise, the
    // exact representation — comparing in rupees would call a half-paise
    // difference equality.
    const mongoPaise = rupeesToPaise(Number(m.tokenBalance) || 0);
    const row = pgById.get(id);
    const pgPaise = row
      ? Number(row.available_paise) + Number(row.reserved_paise) + Number(row.settlement_paise)
      : 0;

    // A merchant with no wallet row and a zero balance is not drift — Postgres
    // materialises the row on first movement, and absent means zero.
    if (mongoPaise === pgPaise) continue;

    found.push({
      merchantId: id, mongoPaise, pgPaise, deltaPaise: mongoPaise - pgPaise,
      // The Mongo document's own mtime is not reliable here (tokenBalance is
      // moved by $inc, which does not always touch updatedAt), so the age comes
      // from the Postgres row — the side the mirror writes. A merchant with no
      // PG row at all has no timestamp and is therefore treated as SETTLED,
      // which is the conservative direction: a wallet that has never been
      // mirrored is exactly the case worth reporting.
      at: row?.updated_at ?? null,
    });

    if (backfill) { await mirrorMerchantBalance(m); repaired++; }
    else if (repairMongo && row) { await reverseMirrorMerchantBalance(row); repaired++; }
  }

  const { settled: drifted, settling } = splitBySettling(found, (r) => r.at);
  const totalDriftPaise = drifted.reduce((s, r) => s + Math.abs(r.deltaPaise), 0);

  // A wallet row whose merchant does not exist in Mongo. Postgres has no
  // foreign key to the Mongo collection, so this is the only thing that would
  // notice a typo'd id having minted a wallet — and money sitting in one is
  // money nobody owns.
  const mongoIds = new Set(merchants.map((m) => String(m._id)));
  const orphansInPg = rows
    .filter((r) => !mongoIds.has(String(r.merchant_id)))
    .map((r) => String(r.merchant_id));

  return {
    table: 'merchant_wallets',
    checked: merchants.length,
    drifted: backfill || repairMongo ? 0 : drifted.length,
    driftedBeforeRepair: drifted.length,
    settling: settling.length,
    totalDriftPaise,
    repaired,
    orphansInPg: orphansInPg.length,
    sampleDrift: drifted.slice(0, 5),
    sampleOrphans: orphansInPg.slice(0, 5),
  };
}

/**
 * Does the PostgreSQL merchant ledger explain the PostgreSQL merchant balances?
 *
 * The intra-store invariant, distinct from the cross-store one above. It is
 * only meaningful once recordOpeningBalances() has run — before that, a
 * mirrored balance has no entries behind it and every merchant reads as
 * drifted. `requireOpened: false` (the default) therefore skips merchants with
 * no entries at all, so the check is honest during Phase A instead of alarming;
 * the cutover runbook turns it on after opening the ledgers.
 */
export async function reconcileMerchantLedgers({ requireOpened = false } = {}) {
  const { rows } = await pgQuery(
    `SELECT w.merchant_id,
            w.available_paise + w.reserved_paise + w.settlement_paise AS balance_paise,
            COALESCE(SUM(CASE WHEN e.entry_type = 'CREDIT' THEN e.amount_paise ELSE -e.amount_paise END), 0) AS ledger_paise,
            COUNT(e.id) AS entry_count
       FROM merchant_wallets w
       LEFT JOIN merchant_wallet_entries e ON e.merchant_id = w.merchant_id
      GROUP BY w.merchant_id, balance_paise`,
    [], 'merchant_ledger_reconcile',
  );

  const considered = rows.filter((r) => requireOpened || Number(r.entry_count) > 0);
  const unexplained = considered
    .map((r) => ({
      merchantId: String(r.merchant_id),
      balancePaise: Number(r.balance_paise),
      ledgerPaise: Number(r.ledger_paise),
      deltaPaise: Number(r.balance_paise) - Number(r.ledger_paise),
    }))
    .filter((r) => r.deltaPaise !== 0);

  return {
    table: 'merchant_wallet_entries',
    checked: considered.length,
    skippedUnopened: rows.length - considered.length,
    unexplained: unexplained.length,
    sample: unexplained.slice(0, 5),
  };
}

/**
 * reconcileMerchantSettlementStates — do the two stores agree on where each
 * settlement IS?
 *
 * Mongo keeps this lifecycle on the PaymentOrder; Postgres keeps it in
 * merchant_settlements. Nothing else compares them: the row-presence check
 * would find the order in both stores and report clean while one said HELD and
 * the other said SETTLED — which after a fallback means the sweeper settles an
 * order a second time.
 *
 * Repair direction follows authority, exactly like the balance reconciler.
 */
const ORDER_STATE_TO_SETTLEMENT = {
  HELD: 'RESERVED', RELEASED: 'SETTLED', REVERSED: 'CANCELLED',
};

export async function reconcileMerchantSettlementStates({ backfill = false, repairMongo = false } = {}) {
  if (backfill && repairMongo) {
    throw new Error('reconcileMerchantSettlementStates: backfill and repairMongo are opposite directions — pick one');
  }

  const { rows } = await pgQuery(
    `SELECT settlement_id, order_id, direction, state, updated_at
       FROM merchant_settlements LIMIT 50000`,
    [], 'merchant_settlement_state_reconcile',
  );
  if (!rows.length) return { table: 'merchant_settlements', checked: 0, disagreeing: 0, repaired: 0, sample: [] };

  const orders = await mongoose.model('PaymentOrder')
    .find({ _id: { $in: rows.map((r) => r.order_id) } })
    .select('type status merchantCreditStatus merchantId tokenAmount').lean();
  const byId = new Map(orders.map((o) => [String(o._id), o]));

  const disagreeing = [];
  let repaired = 0;

  for (const row of rows) {
    const order = byId.get(String(row.order_id));
    // A settlement whose order is not in Mongo yields a null state and is
    // SKIPPED below, not reported. That is deliberate: the order may simply be
    // outside the window, and calling it drift would make every archived order
    // a permanent false positive. A settlement with no order at all is a
    // different concern, and belongs to the orphan check on the wallets.
    const mongoState = order
      ? (order.type === 'WITHDRAWAL'
          ? ORDER_STATE_TO_SETTLEMENT[order.merchantCreditStatus] ?? null
          : (order.status === 'COMPLETED' ? 'SETTLED'
            : ['CANCELLED', 'EXPIRED', 'FAILED'].includes(order.status) ? 'CANCELLED' : null))
      : null;

    // A Mongo state of null means Mongo has not reached a settlement stage this
    // table models (a deposit still in flight, say). That is not disagreement.
    if (mongoState === null || mongoState === row.state) continue;

    disagreeing.push({
      settlementId: row.settlement_id, orderId: String(row.order_id),
      mongoState, pgState: row.state, at: row.updated_at,
    });

    if (backfill && order) { await mirrorMerchantSettlement(order); repaired++; }
    else if (repairMongo) { await reverseMirrorMerchantSettlement(row); repaired++; }
  }

  // A settlement that transitioned moments ago has a mirror in flight, and the
  // sweeper's own self-heal will push it again on the next pass — so a
  // disagreement this young says nothing.
  const { settled, settling } = splitBySettling(disagreeing, (r) => r.at);

  return {
    table: 'merchant_settlements',
    checked: rows.length,
    disagreeing: backfill || repairMongo ? 0 : settled.length,
    disagreeingBeforeRepair: settled.length,
    settling: settling.length,
    repaired,
    sample: settled.slice(0, 5),
  };
}

/**
 * backfillLifecycleTables — ADOPT the state tables no other backfill reaches.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * `TABLES` above covers six tables, and a cutover needs ten. `order_states`,
 * `user_kyc`, `casino_rounds`/`casino_transactions` and `bets` were reachable
 * by NOTHING:
 *
 *   - the forward mirrors only fire on a Mongo write, so a document that has
 *     not been saved since the mirror was added has no Postgres row;
 *   - `mirrorPaymentOrder` writes `payment_orders`, the PROJECTION — not
 *     `order_states`, the lifecycle, which has no mirror at all;
 *   - and every state check starts with `SELECT … FROM <the postgres table>`,
 *     so it compares rows ALREADY there. A row that was never mirrored is
 *     invisible to it, and `--backfill` can never create one.
 *
 * The consequence was not subtle: flipping any of those paths would have
 * pointed reads at a table that is empty for all historical data. This is the
 * step that has to run before a cutover is even possible.
 *
 * ── Adoption, not synchronisation ───────────────────────────────────────────
 * Three rules, and each is a decision rather than an implementation detail.
 *
 * 1. NEVER OVERWRITE. Every insert is `ON CONFLICT DO NOTHING`. A Postgres
 *    lifecycle row that already exists may carry transitions Mongo never knew
 *    about, and a "backfill" that clobbered it would destroy the history it is
 *    supposed to be protecting.
 *
 * 2. NO INVENTED HISTORY. An adopted order gets its current state and NO
 *    `order_transitions` rows. It is tempting to synthesise the path that led
 *    there, and it would be a lie: nobody recorded those transitions, the
 *    timestamps would be fabricated, and an auditor reading the append-only
 *    table could not tell manufactured history from the real thing. History
 *    begins at adoption, and the absence of earlier rows is itself the honest
 *    signal that this order predates the cutover.
 *
 * 3. DIRECTION FOLLOWS AUTHORITY. Each domain is skipped when Postgres already
 *    owns it. Backfilling Mongo→Postgres for a path Postgres is authoritative
 *    for would overwrite the source of truth with its own stale mirror.
 *
 * Deliberately NOT part of the incremental (`--since`) pass. Adoption is a
 * one-time cutover step over the whole population; running it on a 24h window
 * would silently adopt only recent rows and report success.
 */
export async function backfillLifecycleTables({ limit = 50000 } = {}) {
  const out = [];

  // ── Orders: the lifecycle table, which has no mirror ──────────────────────
  if (!isPostgresAuthoritative(MONEY_PATHS.ORDERS)) {
    const { openOrder, ORDER_TYPES, ORDER_STATES } = await import('./orderPg.js');
    const docs = await mongoose.model('PaymentOrder')
      .find({}).select('userId merchantId type tokenAmount fiatAmount status')
      .limit(limit).lean();

    let created = 0; let skipped = 0;
    if (docs.length) {
      const { rows } = await pgQuery(
        `SELECT order_id FROM order_states WHERE order_id = ANY($1)`,
        [docs.map((d) => String(d._id))]);
      const have = new Set(rows.map((r) => r.order_id));

      for (const doc of docs) {
        if (have.has(String(doc._id))) { skipped++; continue; }
        // A malformed document is skipped rather than adopted into a state the
        // machine cannot represent — it would fail its next transition, which
        // is the failure mode this whole function exists to prevent.
        if (!ORDER_TYPES[doc.type] || !ORDER_STATES[doc.status]) { skipped++; continue; }
        await openOrder({
          orderId:          String(doc._id),
          userId:           String(doc.userId),
          merchantId:       doc.merchantId ? String(doc.merchantId) : null,
          type:             doc.type,
          tokenAmountPaise: rupeesToPaise(Number(doc.tokenAmount) || 0),
          fiatAmountPaise:  rupeesToPaise(Number(doc.fiatAmount) || 0),
          // AT ITS CURRENT STATE. Adopting at PENDING_QUEUE would refuse the
          // order's very next transition.
          state:            doc.status,
        });
        created++;
      }
    }
    out.push({ table: 'order_states', scanned: docs.length, created, skipped });
  } else {
    out.push({ table: 'order_states', skipped: 'postgres is authoritative' });
  }

  // ── KYC: mirrorUserKyc writes the whole record, it was just never called ──
  if (!isPostgresAuthoritative(MONEY_PATHS.KYC)) {
    const { mirrorUserKyc } = await import('./dualWrite.js');
    const docs = await mongoose.model('User')
      .find({}).select('kycStatus kycData').limit(limit).lean();
    const { rows } = await pgQuery(
      `SELECT user_id FROM user_kyc WHERE user_id = ANY($1)`,
      [docs.map((d) => String(d._id))]);
    const have = new Set(rows.map((r) => r.user_id));

    let created = 0; let skipped = 0;
    for (const doc of docs) {
      if (have.has(String(doc._id))) { skipped++; continue; }
      await mirrorUserKyc(doc);
      created++;
    }
    out.push({ table: 'user_kyc', scanned: docs.length, created, skipped });
  } else {
    out.push({ table: 'user_kyc', skipped: 'postgres is authoritative' });
  }

  // ── Casino: rounds are DERIVED from their callbacks, so replay them ───────
  // In tx order, because each one advances a running total and the refund bound
  // is checked against it. Replaying out of order would refuse a legitimate
  // rollback that arrived before its own debit had been adopted.
  if (!isPostgresAuthoritative(MONEY_PATHS.CASINO_SETTLEMENT)) {
    const { mirrorCasinoTransaction } = await import('./dualWrite.js');
    const docs = await mongoose.model('GameTransaction')
      .find({}).select('txId roundId userId type amount providerKey gameId createdAt')
      .sort({ createdAt: 1 }).limit(limit).lean();
    const { rows } = await pgQuery(
      `SELECT tx_id FROM casino_transactions WHERE tx_id = ANY($1)`,
      [docs.map((d) => String(d.txId))]);
    const have = new Set(rows.map((r) => r.tx_id));

    let created = 0; let skipped = 0;
    for (const doc of docs) {
      if (have.has(String(doc.txId))) { skipped++; continue; }
      await mirrorCasinoTransaction(doc);
      created++;
    }
    out.push({ table: 'casino_transactions', scanned: docs.length, created, skipped });
  } else {
    out.push({ table: 'casino_transactions', skipped: 'postgres is authoritative' });
  }

  // ── Bets ──────────────────────────────────────────────────────────────────
  if (!isPostgresAuthoritative(MONEY_PATHS.BETS)) {
    const { mirrorBet } = await import('./dualWrite.js');
    const docs = await mongoose.model('Bet').find({}).limit(limit).lean();
    const { rows } = await pgQuery(
      `SELECT bet_id FROM bets WHERE bet_id = ANY($1)`,
      [docs.map((d) => String(d._id))]);
    const have = new Set(rows.map((r) => r.bet_id));

    let created = 0; let skipped = 0;
    for (const doc of docs) {
      if (have.has(String(doc._id))) { skipped++; continue; }
      await mirrorBet(doc);
      created++;
    }
    out.push({ table: 'bets', scanned: docs.length, created, skipped });
  } else {
    out.push({ table: 'bets', skipped: 'postgres is authoritative' });
  }

  return out;
}

/**
 * reconcileCasinoRounds — do the two stores agree about what each round took
 * and gave back?
 *
 * Domain 9's cross-store check. The comparison is per ROUND on the three
 * running totals, not per transaction: a transaction-count check would pass
 * while the totals disagreed, and it is the totals the refund bound is enforced
 * against. A round whose Postgres `refunded` exceeds Mongo's is the shape of the
 * exposure this domain was built around — a reversal Mongo honoured that
 * Postgres would have refused.
 *
 * There is no `--backfill` money movement here and there must not be: both
 * stores have already paid, and a repair that moved value would double-spend
 * the round. Repair rewrites the RECORD in whichever direction authority
 * points, and the wallet paths own the balances.
 */
export async function reconcileCasinoRounds({ backfill = false, repairMongo = false, limit = 20000 } = {}) {
  if (backfill && repairMongo) {
    throw new Error('reconcileCasinoRounds: backfill and repairMongo are opposite directions — pick one');
  }

  const { rows } = await pgQuery(
    `SELECT round_id, user_id, provider_key, game_id, debited_paise, credited_paise, refunded_paise, updated_at
       FROM casino_rounds ORDER BY updated_at DESC LIMIT $1`,
    [limit], 'casino_round_reconcile',
  );
  if (!rows.length) return { table: 'casino_rounds', checked: 0, disagreeing: 0, settling: 0, repaired: 0, overRefunded: 0, sample: [] };

  const GameTransaction = mongoose.model('GameTransaction');
  const docs = await GameTransaction
    .find({ roundId: { $in: rows.map((r) => r.round_id) } })
    .select('roundId type amount').lean();

  // Mongo's totals, derived the way the route derives them.
  const mongoTotals = new Map();
  for (const d of docs) {
    const t = mongoTotals.get(String(d.roundId)) ?? { debited: 0, credited: 0, refunded: 0 };
    const amount = Number(d.amount) || 0;
    if (d.type === 'BET') t.debited += amount;
    else if (d.type === 'WIN') t.credited += amount;
    else if (d.type === 'ROLLBACK' || d.type === 'REFUND') t.refunded += amount;
    mongoTotals.set(String(d.roundId), t);
  }

  const { mirrorCasinoTransaction } = await import('./dualWrite.js');
  const { reverseMirrorCasinoRound } = await import('./reverseMirror.js');

  const disagreeing = [];
  let repaired = 0;
  let overRefunded = 0;

  for (const row of rows) {
    const mongo = mongoTotals.get(String(row.round_id));
    // A Postgres round Mongo has never heard of is a missing document, which
    // the reverse table check owns.
    if (!mongo) continue;

    const pg = {
      debited:  paiseToRupees(Number(row.debited_paise)),
      credited: paiseToRupees(Number(row.credited_paise)),
      refunded: paiseToRupees(Number(row.refunded_paise)),
    };
    if (mongo.debited === pg.debited && mongo.credited === pg.credited && mongo.refunded === pg.refunded) continue;

    // The finding that matters most: Mongo gave back more than it took. The
    // Postgres CHECK constraint makes that unreachable there, so this can only
    // ever be reported from the Mongo side — which is precisely why it is worth
    // reporting rather than assuming the constraint covers both stores.
    const mongoOverRefunded = mongo.refunded > mongo.debited;
    if (mongoOverRefunded) overRefunded++;

    disagreeing.push({
      roundId: row.round_id, userId: row.user_id,
      mongo, pg, ...(mongoOverRefunded ? { mongoOverRefunded } : {}),
      at: row.updated_at,
    });

    if (backfill) {
      for (const d of docs.filter((x) => String(x.roundId) === String(row.round_id))) {
        await mirrorCasinoTransaction({
          txId: d.txId, roundId: d.roundId, userId: row.user_id, type: d.type,
          amount: d.amount, providerKey: row.provider_key, gameId: row.game_id,
        });
      }
      repaired++;
    } else if (repairMongo) {
      const { rows: txs } = await pgQuery(
        `SELECT tx_id, round_id, user_id, tx_type, amount_paise FROM casino_transactions WHERE round_id = $1`,
        [row.round_id]);
      for (const tx of txs) {
        await reverseMirrorCasinoRound({
          round: { providerKey: row.provider_key, gameId: row.game_id },
          transaction: { ...tx, provider_key: row.provider_key, game_id: row.game_id },
        });
      }
      repaired++;
    }
  }

  const { settled, settling } = splitBySettling(disagreeing, (r) => r.at);

  return {
    table: 'casino_rounds',
    checked: rows.length,
    disagreeing: backfill || repairMongo ? 0 : settled.length,
    disagreeingBeforeRepair: settled.length,
    settling: settling.length,
    repaired,
    // Counted separately and NEVER cleared by a repair: a round that gave back
    // more than it took is money already gone, not a record to rewrite.
    overRefunded,
    sample: settled.slice(0, 5),
  };
}

/**
 * reconcileKycDecisions — do the two stores agree about who is approved?
 *
 * Domain 11's cross-store check, and the last one. A KYC status that disagrees
 * is not a reporting problem: `requireApprovedKyc` gates deposits and
 * withdrawals on it, so after a fallback a user approved in one store is
 * refused by the other — or, the direction that matters, a user REJECTED in the
 * authoritative store is still approved in the one the middleware reads.
 *
 * The REASON is compared too, not just the status. A rejection whose reason did
 * not survive the mirror leaves the user staring at a refusal with no
 * explanation, which is the exact defect this domain was built to remove; a
 * check comparing only statuses would call that clean.
 */
export async function reconcileKycDecisions({ backfill = false, repairMongo = false, limit = 50000 } = {}) {
  if (backfill && repairMongo) {
    throw new Error('reconcileKycDecisions: backfill and repairMongo are opposite directions — pick one');
  }

  const { rows } = await pgQuery(
    `SELECT user_id, kyc_status, rejection_reason, reviewed_by, reviewed_at, updated_at
       FROM user_kyc ORDER BY updated_at DESC LIMIT $1`,
    [limit], 'kyc_reconcile',
  );
  if (!rows.length) return { table: 'user_kyc', checked: 0, disagreeing: 0, settling: 0, repaired: 0, sample: [] };

  const docs = await mongoose.model('User')
    .find({ _id: { $in: rows.map((r) => r.user_id) } })
    .select('kycStatus kycData.rejectionReason').lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));

  const { mirrorUserKyc } = await import('./dualWrite.js');
  const { reverseMirrorUserKycStatus } = await import('./reverseMirror.js');

  const disagreeing = [];
  let repaired = 0;

  for (const row of rows) {
    const doc = byId.get(String(row.user_id));
    // A Postgres row with no Mongo user is a missing document, which the
    // reverse table check owns.
    if (!doc) continue;

    const mongoReason = doc.kycData?.rejectionReason ?? null;
    const pgReason = row.rejection_reason ?? null;
    const statusDiffers = doc.kycStatus !== row.kyc_status;
    // Only meaningful on a rejection — the field is cleared otherwise, so
    // comparing two nulls everywhere else would be noise.
    const reasonDiffers = row.kyc_status === 'REJECTED' && (mongoReason ?? '') !== (pgReason ?? '');
    if (!statusDiffers && !reasonDiffers) continue;

    disagreeing.push({
      userId: row.user_id,
      mongoStatus: doc.kycStatus, pgStatus: row.kyc_status,
      ...(reasonDiffers ? { mongoReason, pgReason } : {}),
      at: row.updated_at,
    });

    if (backfill) { await mirrorUserKyc({ _id: row.user_id, kycStatus: doc.kycStatus, kycData: doc.kycData ?? {} }); repaired++; }
    else if (repairMongo) { await reverseMirrorUserKycStatus(row); repaired++; }
  }

  const { settled, settling } = splitBySettling(disagreeing, (r) => r.at);

  return {
    table: 'user_kyc',
    checked: rows.length,
    disagreeing: backfill || repairMongo ? 0 : settled.length,
    disagreeingBeforeRepair: settled.length,
    settling: settling.length,
    repaired,
    sample: settled.slice(0, 5),
  };
}

/**
 * reconcileOrderStates — do the two stores agree on where each ORDER is?
 *
 * ── The two tables this must not conflate ───────────────────────────────────
 * `payment_orders` is a MIRROR: the Mongo document projected forward on every
 * save, overwritten in place, no history, no guard. `order_states` plus
 * append-only `order_transitions` are the authoritative lifecycle. This check
 * reads `order_states`, deliberately.
 *
 * Comparing `payment_orders.status` against `PaymentOrder.status` would be
 * comparing a value against a copy of itself — the forward mirror writes one
 * from the other, so they agree by construction and the check would report
 * clean no matter how far the real lifecycle had drifted. It is the difference
 * between evidence and a tautology.
 *
 * ── Why the disagreement matters ────────────────────────────────────────────
 * The row-presence check finds the order in both stores and reports clean while
 * one says PROCESSING and the other says COMPLETED. After a fallback that means
 * the expiry cron cancels an order that was already paid, or the merchant queue
 * shows work for an order that finished — and on the deposit path a COMPLETED
 * order with no accounting event behind it is money the books do not know about.
 *
 * ── Repair direction follows authority, like every other check here ─────────
 * `--backfill` (Phase A, Mongo authoritative) replays the Mongo status into
 * `order_states` through the lifecycle's own transition, NOT with a raw UPDATE:
 * a repair that bypassed the state machine could write a state the machine
 * would refuse and leave `order_transitions` with no record of how the order
 * got there, which is the history the table exists to keep. Where the move is
 * not legal the row is reported and left alone — an order that reached an
 * impossible state is a fault to investigate, not one to paper over.
 *
 * `--repair-mongo` (Phase B, Postgres authoritative) pushes the authoritative
 * state back through the reverse mirror.
 */
export async function reconcileOrderStates({ backfill = false, repairMongo = false, limit = 50000 } = {}) {
  if (backfill && repairMongo) {
    throw new Error('reconcileOrderStates: backfill and repairMongo are opposite directions — pick one');
  }

  const { rows } = await pgQuery(
    `SELECT order_id, user_id, merchant_id, order_type, state, token_amount_paise, updated_at
       FROM order_states ORDER BY updated_at DESC LIMIT $1`,
    [limit], 'order_state_reconcile',
  );
  if (!rows.length) {
    return { table: 'order_states', checked: 0, disagreeing: 0, settling: 0, repaired: 0, unrepairable: 0, sample: [] };
  }

  const docs = await mongoose.model('PaymentOrder')
    .find({ _id: { $in: rows.map((r) => r.order_id) } })
    .select('status').lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));

  const { transition, ALLOWED_FROM } = await import('./orderPg.js');
  const { reverseMirrorOrderState } = await import('./reverseMirror.js');

  const disagreeing = [];
  let repaired = 0;
  let unrepairable = 0;

  for (const row of rows) {
    const doc = byId.get(String(row.order_id));
    // A Postgres order with no Mongo document is a missing row, which the
    // reverse table check owns. Counting it here too would report one problem
    // as two.
    if (!doc) continue;
    if (doc.status === row.state) continue;

    const entry = {
      orderId: row.order_id, mongoStatus: doc.status, pgStatus: row.state, at: row.updated_at,
    };
    disagreeing.push(entry);

    if (backfill) {
      // Through the state machine, not around it. A repeat visit needs its own
      // key or the transition is refused as a replay — see
      // docs/ORDERS_REQUEUE_CYCLE.md — and a reconcile pass is exactly where
      // one would arrive, since it replays states the order has held before.
      if (!ALLOWED_FROM[doc.status]?.includes(row.state)) {
        entry.unrepairable = `Mongo says ${doc.status}, which is not reachable from ${row.state}`;
        unrepairable++;
        continue;
      }
      const moved = await transition({
        orderId: row.order_id, to: doc.status, actor: 'reconcile',
        reason: `backfill: Mongo authoritative at ${row.state}`,
        txId: `ord_${row.order_id}_${doc.status}_reconcile_${Date.parse(row.updated_at) || Date.now()}`,
      });
      if (moved.ok) repaired++;
      else { entry.unrepairable = moved.reason; unrepairable++; }
    } else if (repairMongo) {
      await reverseMirrorOrderState(row);
      repaired++;
    }
  }

  const { settled, settling } = splitBySettling(disagreeing, (r) => r.at);

  return {
    table: 'order_states',
    checked: rows.length,
    disagreeing: backfill || repairMongo ? unrepairable : settled.length,
    disagreeingBeforeRepair: settled.length,
    settling: settling.length,
    repaired,
    // A repair that could not be performed is NOT clean. Folding it into
    // `repaired` would let a pass report success while the drift it found is
    // still there.
    unrepairable,
    sample: settled.slice(0, 5),
  };
}

/**
 * reconcileBetStates — do the two stores agree on where each bet IS?
 *
 * Nothing else compares them. The row-presence check finds the bet in both
 * stores and reports clean while one says PENDING and the other says LOST —
 * which after a fallback means the settlement sweep pays out a bet that was
 * already settled, or leaves a stake locked forever against one that was not.
 *
 * This check matters more here than for any other domain, because the Mongo
 * settlement path is `Bet.updateMany` — a bulk update Mongoose gives no
 * documents to hand a post hook, so the forward mirror CANNOT see it. Those
 * transitions reach Postgres through this reconcile or not at all, which is
 * why `backfill` is the expected mode during Phase A rather than an emergency
 * repair.
 */
export async function reconcileBetStates({ backfill = false, repairMongo = false, limit = 50000 } = {}) {
  if (backfill && repairMongo) {
    throw new Error('reconcileBetStates: backfill and repairMongo are opposite directions — pick one');
  }

  const { rows } = await pgQuery(
    `SELECT bet_id, user_id, cycle_id, side, stake_paise, payout_paise, platform_fee_paise,
            status, placed_at, settled_at, updated_at
       FROM bets ORDER BY updated_at DESC LIMIT $1`,
    [limit], 'bet_state_reconcile',
  );
  if (!rows.length) return { table: 'bets', checked: 0, disagreeing: 0, settling: 0, repaired: 0, sample: [] };

  // `status` is what the comparison needs; `payout`, `platformFee` and
  // `settledAt` are what the BACKFILL repair below needs. Selecting only
  // `status` made the repair hand `mirrorBet` a document with no payout, and
  // the mirror's `ON CONFLICT DO UPDATE` writes what it is given — so repairing
  // a settled bet's status ZEROED its payout and fee in Postgres. The check that
  // exists to close a disagreement was opening a bigger one.
  const docs = await mongoose.model('Bet')
    .find({ _id: { $in: rows.map((r) => r.bet_id) } })
    .select('status payout platformFee settledAt isPhantom').lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));

  const { mirrorBet } = await import('./dualWrite.js');
  const { reverseMirrorBetRow } = await import('./reverseMirror.js');

  const disagreeing = [];
  let repaired = 0;

  for (const row of rows) {
    const doc = byId.get(String(row.bet_id));
    // A Postgres bet with no Mongo document is not a state disagreement — it is
    // a missing row, which the reverse table check owns. Reporting it here too
    // would double-count one problem as two.
    if (!doc) continue;
    if (doc.status === row.status) continue;

    disagreeing.push({
      betId: row.bet_id, mongoStatus: doc.status, pgStatus: row.status, at: row.updated_at,
    });

    if (backfill) { await mirrorBet({ ...doc, _id: row.bet_id, userId: row.user_id, cycleId: row.cycle_id, side: row.side, amount: paiseToRupees(Number(row.stake_paise)) }); repaired++; }
    else if (repairMongo) { await reverseMirrorBetRow(row); repaired++; }
  }

  const { settled, settling } = splitBySettling(disagreeing, (r) => r.at);

  return {
    table: 'bets',
    checked: rows.length,
    disagreeing: backfill || repairMongo ? 0 : settled.length,
    disagreeingBeforeRepair: settled.length,
    settling: settling.length,
    repaired,
    sample: settled.slice(0, 5),
  };
}

/**
 * Do the two stores agree about which bonuses were granted, and for how much?
 *
 * Domain 8's cross-store check. The comparison is per-grant rather than on a
 * total: a total that matches can still hide two grants that are individually
 * wrong in opposite directions, and a bonus engine that pays the right sum to
 * the wrong users is the failure this check exists to catch.
 *
 * A CLAWED_BACK grant is compared on its amount only. Mongo has no status field
 * to disagree about — the clawback lives there as a separate negative record —
 * so asking the two stores to agree about a state only one of them models would
 * report drift on every reversal, forever.
 */
export async function reconcileBonusGrants({ backfill = false, repairMongo = false, limit = 20000 } = {}) {
  if (backfill && repairMongo) {
    throw new Error('reconcileBonusGrants: backfill and repairMongo are opposite directions — pick one');
  }

  const { rows } = await pgQuery(
    `SELECT grant_id, user_id, kind, pool, amount_paise, status, ref_id, granted_at, updated_at
       FROM bonus_grants ORDER BY updated_at DESC LIMIT $1`,
    [limit], 'bonus_grant_reconcile',
  );
  if (!rows.length) {
    return { table: 'bonus_grants', checked: 0, disagreeing: 0, settling: 0, repaired: 0, sample: [] };
  }

  // Only grants the forward mirror minted can be matched back to a document.
  // A grant born in Postgres has no Mongo counterpart by definition, and the
  // reverse table check owns that — counting it here would report the cutover
  // itself as drift.
  const mongoIds = rows
    .filter((r) => String(r.grant_id).startsWith('bg_'))
    .map((r) => String(r.grant_id).slice(3));
  const records = mongoIds.length
    ? await mongoose.model('BonusRecord').find({ _id: { $in: mongoIds } }).select('amount type').lean()
    : [];
  const byId = new Map(records.map((d) => [String(d._id), d]));

  const { reverseMirrorBonusGrant } = await import('./reverseMirror.js');

  const disagreeing = [];
  let repaired = 0;

  for (const row of rows) {
    if (!String(row.grant_id).startsWith('bg_')) continue;
    const doc = byId.get(String(row.grant_id).slice(3));
    if (!doc) continue;                       // missing-row check owns this

    const mongoPaise = rupeesToPaise(Number(doc.amount ?? 0));
    const pgPaise    = Number(row.amount_paise);
    if (mongoPaise === pgPaise) continue;

    disagreeing.push({
      grantId: row.grant_id, userId: String(row.user_id), kind: row.kind,
      mongoPaise, pgPaise, driftPaise: mongoPaise - pgPaise, at: row.updated_at,
    });

    // The forward repair CANNOT be "re-run the mirror". mirrorBonusGrant is
    // INSERT … ON CONFLICT DO NOTHING — correctly so, since a re-fired mirror
    // must not drag a clawed-back grant back to PAID — which means re-running
    // it against a row that already exists changes nothing and would report a
    // repair that did not happen. The corrective UPDATE is written out here
    // instead, and it is deliberately narrow: the amount only, and only while
    // Mongo is the source of truth for this domain.
    if (backfill) {
      await pgQuery(
        `UPDATE bonus_grants SET amount_paise = $2, updated_at = now() WHERE grant_id = $1`,
        [row.grant_id, mongoPaise], 'bonus_grant_repair',
      );
      repaired++;
    } else if (repairMongo) { await reverseMirrorBonusGrant(row); repaired++; }
  }

  const { settled, settling } = splitBySettling(disagreeing, (r) => r.at);

  return {
    table: 'bonus_grants',
    checked: rows.length,
    disagreeing: backfill || repairMongo ? 0 : settled.length,
    disagreeingBeforeRepair: settled.length,
    settling: settling.length,
    repaired,
    sample: settled.slice(0, 5),
  };
}

/**
 * Do the two stores agree about how each cycle's settlement RUN went?
 *
 * Domain 6's cross-store check. Two things are compared, and the second is the
 * one worth having:
 *
 *  - **State.** Mongo's `Cycle.isSettled` against `cycle_settlements.status`. A
 *    disagreement means one store thinks a payout is still running and the
 *    other thinks it finished, which decides whether `payoutRecoveryTask` will
 *    pick the cycle up and re-run it.
 *
 *  - **Payout total.** Mongo's `totalPaidOut` against the run's
 *    `payout_paise`. This is the money statement: the two figures are reached
 *    completely differently — Mongo re-derives its total by aggregating the
 *    stamped WON bets, Postgres accumulates it one settled bet at a time — so
 *    agreement between them is real evidence rather than a value compared with
 *    a copy of itself.
 *
 * A cycle Postgres has no run for is not reported here. That is the table
 * check's job (`reconcileTableReverse`), and counting one missing row as two
 * different problems makes a clean report impossible to recognise.
 *
 * VOIDED has no Mongo counterpart, so a voided run is skipped rather than
 * called drift — the asymmetry is documented on both mirrors and reporting it
 * every pass would train an operator to ignore this check.
 */
export async function reconcileCycleSettlements({ backfill = false, repairMongo = false, limit = 20000 } = {}) {
  if (backfill && repairMongo) {
    throw new Error('reconcileCycleSettlements: backfill and repairMongo are opposite directions — pick one');
  }

  const { rows } = await pgQuery(
    `SELECT cycle_id, winning_side, status, payout_paise, completed_at, updated_at
       FROM cycle_settlements ORDER BY updated_at DESC LIMIT $1`,
    [limit], 'cycle_settlement_reconcile',
  );
  if (!rows.length) {
    return { table: 'cycle_settlements', checked: 0, disagreeing: 0, settling: 0, repaired: 0, sample: [] };
  }

  const cycles = await mongoose.model('Cycle')
    .find({ cycleId: { $in: rows.map((r) => r.cycle_id) } })
    .select('cycleId isSettled winner totalPaidOut settledAt').lean();
  const byCycle = new Map(cycles.map((c) => [String(c.cycleId), c]));

  const { mirrorCycleSettlement } = await import('./dualWrite.js');
  const { reverseMirrorCycleSettlement } = await import('./reverseMirror.js');

  const disagreeing = [];
  let repaired = 0;

  for (const row of rows) {
    const cycle = byCycle.get(String(row.cycle_id));
    if (!cycle) continue;                       // missing-row check owns this
    if (row.status === 'VOIDED') continue;      // no Mongo counterpart, by design

    const expectedStatus = cycle.isSettled === 'COMPLETED' ? 'COMPLETED'
      : cycle.isSettled === 'PROCESSING' ? 'RUNNING' : null;
    // PENDING in Mongo with a run in Postgres is not drift while Postgres is
    // authoritative — it is the flip's whole point. It IS drift the other way
    // round, which the state comparison below catches on its own.
    if (expectedStatus === null) continue;

    const mongoPayout = rupeesToPaise(Number(cycle.totalPaidOut ?? 0));
    const pgPayout    = Number(row.payout_paise);
    const statusDrift = expectedStatus !== row.status;
    // Compare the payout only on a run both stores call finished. A run still
    // in flight has a total that is legitimately mid-flight in one store and
    // not yet written in the other.
    const payoutDrift = !statusDrift && row.status === 'COMPLETED' && mongoPayout !== pgPayout;

    if (!statusDrift && !payoutDrift) continue;

    disagreeing.push({
      cycleId: row.cycle_id,
      mongoStatus: cycle.isSettled, pgStatus: row.status,
      mongoPayoutPaise: mongoPayout, pgPayoutPaise: pgPayout,
      driftPaise: mongoPayout - pgPayout,
      at: row.updated_at,
    });

    if (backfill) { await mirrorCycleSettlement(cycle); repaired++; }
    else if (repairMongo) { await reverseMirrorCycleSettlement(row); repaired++; }
  }

  const { settled, settling } = splitBySettling(disagreeing, (r) => r.at);

  return {
    table: 'cycle_settlements',
    checked: rows.length,
    disagreeing: backfill || repairMongo ? 0 : settled.length,
    disagreeingBeforeRepair: settled.length,
    settling: settling.length,
    repaired,
    sample: settled.slice(0, 5),
  };
}

/**
 * Do the two supply figures agree?
 *
 * `SystemConfig.adminTokenSupply.minted` is a running counter maintained by
 * increments. The treasury's circulating supply is `0 - TOKEN_SUPPLY`, DERIVED
 * from double-entry rows that each had to sum to zero. They are the same
 * quantity reached two completely different ways, which is exactly what makes
 * comparing them worth doing — a counter that can only be checked against
 * itself cannot be checked at all.
 *
 * Any drift means one of a small number of specific things, all of them worth
 * paging about: a mint that moved one store and not the other, a rollback
 * applied twice on the Mongo side (its `$inc` is not idempotent), or a mirror
 * whose `.catch(() => {})` swallowed a failure. `repairMongo` fixes the
 * follower by copying the derived total over the counter; it is only correct
 * while Postgres is authoritative, and refuses otherwise rather than
 * overwriting the source of truth with its own mirror.
 */
export async function reconcileAdminSupply({ repairMongo = false } = {}) {
  const [cfg, balances] = await Promise.all([
    mongoose.model('SystemConfig').findOne({ key: 'main' }).select('adminTokenSupply').lean(),
    (await import('./treasuryPg.js')).getTreasuryBalances(),
  ]);
  const { ACCOUNTS } = await import('./treasuryPg.js');

  const mongoMintedPaise = rupeesToPaise(cfg?.adminTokenSupply?.minted ?? 0);
  const pgMintedPaise = 0 - (balances[ACCOUNTS.TOKEN_SUPPLY] ?? 0);
  const driftPaise = pgMintedPaise - mongoMintedPaise;

  let repaired = 0;
  if (driftPaise !== 0 && repairMongo) {
    const { isPostgresAuthoritative, MONEY_PATHS } = await import('./moneyAuthority.js');
    if (!isPostgresAuthoritative(MONEY_PATHS.ADMIN_ISSUANCE)) {
      throw new Error(
        'reconcileAdminSupply: refusing to repair Mongo while Mongo is authoritative for admin_issuance — '
        + 'that would overwrite the source of truth with its own follower.',
      );
    }
    const { reverseMirrorAdminSupply } = await import('./reverseMirror.js');
    await reverseMirrorAdminSupply({
      minted: paiseToRupees(pgMintedPaise),
      cap: cfg?.adminTokenSupply?.cap,
    });
    repaired = 1;
  }

  return {
    table: 'admin_token_supply',
    ok: driftPaise === 0,
    mongoMintedTokens: paiseToRupees(mongoMintedPaise),
    pgMintedTokens: paiseToRupees(pgMintedPaise),
    driftPaise,
    repaired,
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

  // Balance agreement, not just row presence. Repair direction follows the
  // authority in force: while Mongo owns merchant balances a --backfill repairs
  // Postgres, and after the flip a --repair-mongo repairs Mongo. Neither runs
  // unless explicitly asked for — the cron is detection-only.
  const merchantOnPg = isPostgresAuthoritative(MONEY_PATHS.MERCHANT_WALLET);
  const merchantBalances = await reconcileMerchantBalances({
    backfill: backfill && !merchantOnPg,
    repairMongo: repairMongo && merchantOnPg,
  });
  const merchantLedgers = await reconcileMerchantLedgers();

  // Domain 2: are the merchant's COMMITTED pockets explained by settlements
  // that are actually outstanding? A reserved balance with no settlement behind
  // it is money frozen for an order that no longer exists, and neither the row
  // counts nor the balance comparison can see it.
  //
  // Only meaningful once Postgres owns the path. In Phase A the pockets are a
  // projection of Mongo's single tokenBalance — everything lands in `available`
  // — while the settlement STATES are mirrored from the order, so outstanding
  // settlements legitimately have no matching reserved balance behind them.
  // Asserting it before the flip would report drift on ordinary traffic and
  // reset the cutover-readiness streak. Deriving the pockets from the
  // outstanding settlements is a cutover step, like the opening balances.
  const settlementOnPg = isPostgresAuthoritative(MONEY_PATHS.MERCHANT_SETTLEMENT);
  const { findUnexplainedSettlementPockets } = await import('./merchantSettlementPg.js');
  const settlementPockets = settlementOnPg ? await findUnexplainedSettlementPockets() : [];
  // Cross-store: does each settlement sit in the same state in both? Always
  // meaningful, unlike the pocket check — the states are mirrored in Phase A.
  const settlementStates = await reconcileMerchantSettlementStates({
    backfill: backfill && !settlementOnPg,
    repairMongo: repairMongo && settlementOnPg,
  });

  // Domain 4: do the running counter and the derived double-entry total agree?
  // Checked in BOTH phases, unlike the settlement pockets — the mirror runs in
  // whichever direction authority points, so the two figures are supposed to
  // match either way. Repair follows authority for the same reason it does
  // above, and reconcileAdminSupply refuses a repair that would overwrite the
  // source of truth rather than trusting the caller to have got it right.
  const issuanceOnPg = isPostgresAuthoritative(MONEY_PATHS.ADMIN_ISSUANCE);
  const adminSupply = await reconcileAdminSupply({ repairMongo: repairMongo && issuanceOnPg });

  // Domain 5: do the two stores agree on where each bet IS? This one carries
  // more weight than the other state checks, because the Mongo settlement path
  // is `Bet.updateMany` — a bulk update Mongoose gives no documents to hand a
  // post hook, so the forward mirror cannot see it at all. Those transitions
  // reach Postgres through this pass or not at all, which makes `--backfill`
  // the expected Phase A mode rather than an emergency repair.
  const betsOnPg = isPostgresAuthoritative(MONEY_PATHS.BETS);
  const betStates = await reconcileBetStates({
    backfill: backfill && !betsOnPg,
    repairMongo: repairMongo && betsOnPg,
  });

  // ADOPTION FIRST, when a backfill is asked for. Every state check below
  // starts with SELECT … FROM its Postgres table, so it can only compare rows
  // that are already there — running them before adoption would report a clean
  // pass over an empty table, which is the most dangerous kind of green.
  const lifecycleBackfill = backfill ? await backfillLifecycleTables() : null;

  // Orders: do the two stores agree on where each order IS? Read from
  // order_states — the authoritative lifecycle — and NOT from payment_orders,
  // which is the projection the forward mirror writes from the Mongo document
  // and would therefore agree with it by construction.
  const ordersOnPg = isPostgresAuthoritative(MONEY_PATHS.ORDERS);
  const orderStates = await reconcileOrderStates({
    backfill: backfill && !ordersOnPg,
    repairMongo: repairMongo && ordersOnPg,
  });

  // Domain 11, the last: do the two stores agree about who is APPROVED? This
  // one gates money rather than moving it — requireApprovedKyc reads the status
  // — so a disagreement refuses a legitimate user or admits a rejected one.
  const kycOnPg = isPostgresAuthoritative(MONEY_PATHS.KYC);
  const kycDecisions = await reconcileKycDecisions({
    backfill: backfill && !kycOnPg,
    repairMongo: repairMongo && kycOnPg,
  });

  // Domain 9: do the two stores agree about what each casino round took and
  // gave back? The refund bound is a CHECK CONSTRAINT in Postgres and a
  // read-then-compare in Mongo, so an over-refunded round can only ever appear
  // on the Mongo side — which is exactly why this asks.
  const casinoOnPg = isPostgresAuthoritative(MONEY_PATHS.CASINO_SETTLEMENT);
  const casinoRounds = await reconcileCasinoRounds({
    backfill: backfill && !casinoOnPg,
    repairMongo: repairMongo && casinoOnPg,
  });

  // Domain 6: did each cycle's settlement RUN end the same way in both stores,
  // and did it pay out the same amount? The payout comparison is the one that
  // earns its place — Mongo re-derives its total from the stamped WON bets and
  // Postgres accumulates it per settled bet, so the two figures agreeing is
  // evidence rather than a value checked against a copy of itself.
  const settlementsOnPg = isPostgresAuthoritative(MONEY_PATHS.SETTLEMENTS);
  const cycleSettlements = await reconcileCycleSettlements({
    backfill: backfill && !settlementsOnPg,
    repairMongo: repairMongo && settlementsOnPg,
  });

  // Domain 8: does every mirrored grant carry the same amount in both stores?
  // Per-grant rather than on a total, because a bonus engine paying the right
  // sum to the wrong users is exactly what a matching total would hide.
  const bonusesOnPg = isPostgresAuthoritative(MONEY_PATHS.BONUSES_AND_COMMISSIONS);
  const bonusGrants = await reconcileBonusGrants({
    backfill: backfill && !bonusesOnPg,
    repairMongo: repairMongo && bonusesOnPg,
  });

  const forwardDrift = results.some((r) => r.missingInPg > 0)
    || !pgTrial.conservesToZero
    || merchantBalances.drifted > 0
    || merchantBalances.orphansInPg > 0
    || merchantLedgers.unexplained > 0
    || settlementPockets.length > 0
    || settlementStates.disagreeing > 0
    || orderStates.disagreeing > 0
    || orderStates.unrepairable > 0
    || kycDecisions.disagreeing > 0
    || casinoRounds.disagreeing > 0
    || casinoRounds.overRefunded > 0
    || betStates.disagreeing > 0
    || cycleSettlements.disagreeing > 0
    || bonusGrants.disagreeing > 0
    || !adminSupply.ok;

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

  // Everything the settling window held back this pass. Reported, never
  // dropped: a mirror that is merely behind produces a number that returns to
  // zero, while one that is BROKEN produces a number that keeps climbing. That
  // makes a rising `settling` an earlier and cleaner alarm than the noisy drift
  // count it replaced — but only if something actually looks at it, which is
  // why it is surfaced here rather than left inside each check.
  const settling = {
    windowMs: settlingWindowMs(),
    forward: results.reduce((s, r) => s + (r.settling ?? 0), 0),
    reverse: (reverseResults ?? []).reduce((s, r) => s + (r.settling ?? 0), 0),
    merchantBalances: merchantBalances.settling ?? 0,
    settlementStates: settlementStates.settling ?? 0,
    orderStates: orderStates.settling ?? 0,
    kycDecisions: kycDecisions.settling ?? 0,
    casinoRounds: casinoRounds.settling ?? 0,
    betStates: betStates.settling ?? 0,
    cycleSettlements: cycleSettlements.settling ?? 0,
    bonusGrants: bonusGrants.settling ?? 0,
  };
  settling.total = settling.forward + settling.reverse
    + settling.merchantBalances + settling.settlementStates + settling.betStates
    + settling.orderStates + settling.kycDecisions + settling.casinoRounds
    + settling.cycleSettlements + settling.bonusGrants;

  return {
    window: all ? 'all' : `${hours}h`,
    results,
    settling,
    lifecycleBackfill,
    trialBalance: pgTrial,
    merchantBalances,
    merchantLedgers,
    merchantSettlements: {
      table: 'merchant_settlements',
      pocketsChecked: settlementOnPg,
      unexplainedPockets: settlementPockets.length,
      samplePockets: settlementPockets.slice(0, 5),
      states: settlementStates,
    },
    adminSupply,
    orderStates,
    kycDecisions,
    casinoRounds,
    betStates,
    cycleSettlements,
    bonusGrants,
    reverse: reverseResults,
    mongoTrialBalance: mongoTrial,
    ledgersAgree,
    drift: forwardDrift || reverseDrift,
  };
}

/**
 * openMerchantLedgers — the cutover step, run once per merchant before the
 * merchant path flips to Postgres.
 *
 * Gives every mirrored balance an opening entry so the Postgres ledger explains
 * the Postgres balance from the flip forward (see
 * merchantWalletPg.recordOpeningBalances for why this is the correct shape for
 * a ledger migration). Idempotent — re-running posts nothing.
 */
export async function openMerchantLedgers() {
  const { recordOpeningBalances } = await import('./merchantWalletPg.js');
  const merchants = await mongoose.model('Merchant').find({}).select('_id').limit(50000).lean();

  let opened = 0;
  let alreadySettled = 0;
  const conflicts = [];
  for (const m of merchants) {
    const r = await recordOpeningBalances(m._id);
    if (r.conflicts.length) conflicts.push({ merchantId: String(m._id), pockets: r.conflicts });
    else if (r.posted.length) opened++;
    else alreadySettled++;
  }
  // A conflict is a balance that moved without an entry AFTER being opened.
  // It blocks the cutover: the ledger cannot explain the number it is about to
  // become authoritative for.
  return { merchants: merchants.length, opened, alreadySettled, conflicts };
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

  // A cutover step, not a check — it writes opening entries and exits, so it
  // never runs as a side effect of a reconcile pass.
  if (flag('open-merchant-ledgers')) {
    console.log(JSON.stringify(await openMerchantLedgers(), null, 2));
    await mongoose.disconnect(); await closePg();
    process.exit(0);
  }

  const report = await runReconcile({
    hours: opt('hours', 24), all: flag('all'), backfill: flag('backfill'),
    reverse: flag('reverse'), repairMongo: flag('repair-mongo'),
  });
  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect(); await closePg();
  process.exit(report.drift ? 1 : 0);
}
