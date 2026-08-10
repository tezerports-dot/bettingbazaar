// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Integration test (real Postgres service in CI): the hybrid money DB —
// plan steps 1-4. Proves, against a REAL postgres:16:
//   - the BIGINT-paise schema applies idempotently,
//   - accounting_events is genuinely append-only (UPDATE/DELETE rejected by
//     the DATABASE, not the app) and postings must conserve to zero — the
//     Postgres equivalent of ledgerReconcile.integration.test.js's guarantees,
//   - dual-write hooks mirror Mongo money writes with paise-exact integers,
//   - mirroring is idempotent (replays can't double-write),
//   - reconcile detects drift and --backfill repairs it.
// Skipped cleanly when DATABASE_URL is absent (local dev without Postgres).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { WalletLedger, AccountingEvent, UTRRegistry, Transaction } from '../../models/index.js';
import { pgConfigured, pgQuery, applySchema, closePg } from '../../postgres/pgClient.js';
import { mirrorAccountingEvent, mirrorTransaction } from '../../postgres/dualWrite.js';
import { runReconcile, pgTrialBalance, RECONCILE_TABLES } from '../../postgres/reconcile.js';

const HAS_PG = !!process.env.DATABASE_URL;
const d = HAS_PG ? describe : describe.skip;

/**
 * Every money table, read from the SCHEMA rather than listed by hand.
 *
 * This used to be a literal array, and it silently stopped covering the schema
 * the moment a table was added — `merchant_wallets`, `merchant_wallet_entries`,
 * `merchant_settlements` and `merchant_settlement_transitions` were all absent
 * from it. That is not a tidiness problem. `test:pg` runs before this suite
 * against the SAME database and leaves fixtures behind; a table nobody
 * truncates keeps them, and `runReconcile` then reports those wallets as
 * orphans (rows with no Mongo merchant) and the drift assertion below fails —
 * on leftover fixtures, not on any real disagreement. Reproduced exactly:
 * orphansInPg = 2, the two merchants merchantWalletPgAuthority.test.js seeds
 * last.
 *
 * Deriving the list means adding a table can never again poison a later
 * assertion, which is the same reason the certification checklist is generated
 * rather than typed.
 */
async function moneyTables() {
  const { rows } = await pgQuery(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
  return rows.map((r) => r.tablename);
}

// The mirrors are fire-and-forget from hooks — poll until the row lands.
async function eventually(fn, ms = 4000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, 100));
  }
}

d('Hybrid money DB (Postgres dual-write)', () => {
  beforeAll(async () => {
    expect(pgConfigured()).toBe(true);
    await applySchema();       // idempotent — safe to apply on every boot
    await applySchema();       // and provably re-appliable
  });

  beforeEach(async () => {
    const tables = await moneyTables();
    // One statement so foreign keys between them cannot order-fail.
    await pgQuery(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);

    // The reconciler ignores disagreements younger than its settling window,
    // because a fire-and-forget mirror produces one after every write. These
    // tests create a document and simulate drift SECONDS later, so every
    // finding here is inside that window — they would all report clean.
    //
    // Zeroing it is right rather than a workaround: what these tests are about
    // is drift DETECTION and repair, not the window. The window has its own
    // tests (merchantWalletPgAuthority.test.js), and one below proves it
    // applies to this reconciler too.
    process.env.RECONCILE_SETTLING_WINDOW_MS = '0';
  });

  afterAll(async () => {
    delete process.env.RECONCILE_SETTLING_WINDOW_MS;
    await closePg();
  });

  it('accounting_events is append-only and postings must conserve to zero (DB-enforced)', async () => {
    await pgQuery(
      `INSERT INTO accounting_events (idempotency_key, event_type, amount_paise, postings)
       VALUES ('k1','DEPOSIT_COMPLETED',10000,'[{"account":"USER_DEPOSITS","amountPaise":10000},{"account":"TREASURY","amountPaise":-10000}]')`);

    await expect(pgQuery(`UPDATE accounting_events SET amount_paise = 1 WHERE idempotency_key='k1'`))
      .rejects.toThrow(/append-only/);
    await expect(pgQuery(`DELETE FROM accounting_events WHERE idempotency_key='k1'`))
      .rejects.toThrow(/append-only/);
    // Unbalanced postings refused at the door.
    await expect(pgQuery(
      `INSERT INTO accounting_events (idempotency_key, event_type, amount_paise, postings)
       VALUES ('k2','DEPOSIT_COMPLETED',5,'[{"account":"A","amountPaise":5}]')`))
      .rejects.toThrow(/conserve to zero/);
  });

  it('WalletLedger writes mirror to Postgres with paise-exact integers', async () => {
    const userId = new mongoose.Types.ObjectId();
    await WalletLedger.create({
      userId, type: 'CREDIT', field: 'depositBalance',
      amount: 99.99, balanceBefore: 50, balanceAfter: 149.99,
      reason: 'pg dual-write test', txId: `t-${Date.now()}`,
    });
    const row = await eventually(async () => {
      const { rows } = await pgQuery(`SELECT * FROM wallet_ledger WHERE user_id=$1`, [String(userId)]);
      return rows[0];
    });
    expect(Number(row.amount_paise)).toBe(9999);          // ₹99.99 → 9999 paise, exactly
    expect(Number(row.balance_after_paise)).toBe(14999);

    // The wallets snapshot needs its OWN wait, and this is the subtle part:
    // mirrorWalletLedger writes wallet_ledger and THEN wallets, in that order,
    // inside one fire-and-forget call. So the ledger row appearing does not
    // mean the snapshot has landed — waiting for the first and then reading the
    // second directly is a race that resolves correctly almost every time and
    // fails when the runner is loaded. CI caught it doing exactly that:
    // `Cannot read properties of undefined (reading 'deposit_paise')`.
    const w = await eventually(async () => {
      const { rows } = await pgQuery(`SELECT * FROM wallets WHERE user_id=$1`, [String(userId)]);
      return rows[0];
    });
    expect(Number(w.deposit_paise)).toBe(14999);          // snapshot follows balanceAfter
  });

  it('mirroring is idempotent — replaying the same event cannot double-write', async () => {
    const doc = {
      _id: new mongoose.Types.ObjectId(), idempotencyKey: 'replay-1',
      eventType: 'DEPOSIT_COMPLETED', amountMinor: 5000,
      postings: [{ account: 'A', amountMinor: 5000 }, { account: 'B', amountMinor: -5000 }],
    };
    await mirrorAccountingEvent(doc);
    await mirrorAccountingEvent(doc);
    await mirrorAccountingEvent({ ...doc, _id: new mongoose.Types.ObjectId() }); // same key, retried source
    const { rows } = await pgQuery(`SELECT COUNT(*)::int AS n FROM accounting_events WHERE idempotency_key='replay-1'`);
    expect(rows[0].n).toBe(1);
  });

  it('UTR uniqueness is storage-enforced in the SAME database as orders', async () => {
    await UTRRegistry.create({
      utr: 'UTR12345678', orderId: new mongoose.Types.ObjectId(),
      userId: new mongoose.Types.ObjectId(), amount: 500,
    });
    await eventually(async () => {
      const { rows } = await pgQuery(`SELECT 1 FROM utr_registry WHERE utr='UTR12345678'`);
      return rows[0];
    });
    // A second claim on the same UTR cannot land (PK), regardless of app code.
    await expect(pgQuery(
      `INSERT INTO utr_registry (utr, order_id) VALUES ('UTR12345678','other-order')`))
      .rejects.toThrow();
  });

  it('reconcile detects drift and --backfill repairs it; PG trial balance conserves to zero', async () => {
    // Create a Mongo-side balanced event. The post-save hook mirrors it to PG
    // fire-and-forget, so wait for that row to land BEFORE simulating drift —
    // otherwise the TRUNCATE races the async mirror and re-lands the row.
    await AccountingEvent.create({
      idempotencyKey: 'rc-1', eventType: 'DEPOSIT_COMPLETED', amountMinor: 10000,
      refModel: 'PaymentOrder', refId: 'o1', description: 'rc test', occurredAt: new Date(),
      postings: [{ account: 'EXTERNAL_FIAT', amountMinor: 10000 }, { account: 'USER_FUNDS', amountMinor: -10000 }],
    });
    await eventually(async () => {
      const { rows } = await pgQuery(`SELECT 1 FROM accounting_events WHERE idempotency_key='rc-1'`);
      return rows[0];
    });
    // Simulate drift: wipe PG side, then reconcile with backfill.
    await pgQuery(`TRUNCATE accounting_events RESTART IDENTITY CASCADE`);
    const before = await runReconcile({ all: true });
    const ae = before.results.find(r => r.table === 'accounting_events');
    expect(ae.missingInPg).toBeGreaterThan(0);
    expect(before.drift).toBe(true);

    const after = await runReconcile({ all: true, backfill: true });
    expect(after.results.find(r => r.table === 'accounting_events').missingInPg).toBe(0);

    const clean = await runReconcile({ all: true });
    expect(clean.drift).toBe(false);
    const trial = await pgTrialBalance();
    expect(trial.conservesToZero).toBe(true);             // the ledger's core invariant, in PG
  });

  // ── created_at / `since` field-name mapping (regression, 2026-07-29) ───────
  // Two bugs, one root cause: not every model calls its timestamp `createdAt`.
  // Transaction calls it `timestamp`; UTRRegistry calls it `registeredAt`.
  //   1. mirrorTransaction read doc.createdAt → undefined → explicit NULL →
  //      "null value in column created_at violates not-null constraint" on
  //      EVERY transaction. mirror() swallows errors, so the PG table simply
  //      stayed empty and nothing failed loudly.
  //   2. reconcileTable hardcoded a { createdAt: { $gte: since } } filter, so
  //      an incremental run over those two tables matched ZERO documents and
  //      reported them clean. The scheduled job (cronJobs.js) runs
  //      { hours: 24 } — the incremental path — so this was the DEFAULT
  //      behaviour, not an edge case.
  // The pre-existing reconcile test above only ever passed { all: true },
  // which skips the `since` filter entirely — which is why this went unseen.

  it('Transaction writes mirror to Postgres, taking created_at from `timestamp`', async () => {
    const userId = new mongoose.Types.ObjectId();
    const when = new Date('2026-07-20T10:30:00.000Z');
    await Transaction.create({
      userId, type: 'BET_PLACED', amount: 10, status: 'SUCCESS',
      description: 'created_at regression', timestamp: when,
    });

    const row = await eventually(async () => {
      const { rows } = await pgQuery(`SELECT * FROM transactions WHERE user_id=$1`, [String(userId)]);
      return rows[0];
    });
    expect(Number(row.amount_paise)).toBe(1000);
    // Not merely non-null: it must be the transaction's OWN time. A COALESCE
    // to now() alone would satisfy NOT NULL while silently losing when the
    // money actually moved.
    expect(new Date(row.created_at).toISOString()).toBe(when.toISOString());
  });

  it('mirrors a doc with no timestamp at all, falling back to the ObjectId time', async () => {
    // Legacy rows written before the field existed, replayed by --backfill.
    const _id = new mongoose.Types.ObjectId();
    await mirrorTransaction({
      _id, userId: new mongoose.Types.ObjectId(),
      type: 'ADMIN_ADJUSTMENT', status: 'SUCCESS', amount: 1,
    });
    const { rows } = await pgQuery(`SELECT * FROM transactions WHERE mongo_id=$1`, [String(_id)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].created_at).not.toBeNull();
    // ObjectIds embed their creation second, so even a field-less doc lands
    // near its true time rather than at replay time.
    expect(Math.abs(new Date(rows[0].created_at) - _id.getTimestamp())).toBeLessThan(1000);
  });

  it('an INCREMENTAL reconcile sees Transaction and UTRRegistry drift', async () => {
    const userId = new mongoose.Types.ObjectId();
    await Transaction.create({
      userId, type: 'BET_WIN', amount: 25, status: 'SUCCESS', timestamp: new Date(),
    });
    await UTRRegistry.create({
      utr: 'UTR90000001', orderId: new mongoose.Types.ObjectId(), userId, amount: 25,
    });
    await eventually(async () => {
      const { rows } = await pgQuery(`SELECT 1 FROM transactions WHERE user_id=$1`, [String(userId)]);
      return rows[0];
    });
    await eventually(async () => {
      const { rows } = await pgQuery(`SELECT 1 FROM utr_registry WHERE utr='UTR90000001'`);
      return rows[0];
    });

    // Wipe the PG side, then reconcile over a 24h WINDOW — the mode the cron
    // job actually uses. Before the fix both tables reported mongoCount 0 and
    // missingInPg 0: "clean", having scanned nothing.
    await pgQuery(`TRUNCATE transactions RESTART IDENTITY CASCADE`);
    await pgQuery(`TRUNCATE utr_registry RESTART IDENTITY CASCADE`);

    const report = await runReconcile({ hours: 24 });
    const tx  = report.results.find(r => r.table === 'transactions');
    const utr = report.results.find(r => r.table === 'utr_registry');

    expect(tx.mongoCount).toBeGreaterThan(0);      // the filter matched documents
    expect(tx.missingInPg).toBeGreaterThan(0);     // and the drift was detected
    expect(utr.mongoCount).toBeGreaterThan(0);
    expect(utr.missingInPg).toBeGreaterThan(0);
    expect(report.drift).toBe(true);

    // And the incremental backfill repairs it.
    const after = await runReconcile({ hours: 24, backfill: true });
    expect(after.results.find(r => r.table === 'transactions').missingInPg).toBe(0);
    expect(after.results.find(r => r.table === 'utr_registry').missingInPg).toBe(0);
  });

  it('a mirror that is merely moments behind is reported as settling, not drift', async () => {
    // The default window, restored for this one test — the rest of the file
    // runs at zero so it can test detection.
    delete process.env.RECONCILE_SETTLING_WINDOW_MS;

    await AccountingEvent.create({
      idempotencyKey: 'settle-1', eventType: 'DEPOSIT_COMPLETED', amountMinor: 10000,
      refModel: 'PaymentOrder', refId: 'o-settle', description: 'settling test', occurredAt: new Date(),
      postings: [{ account: 'EXTERNAL_FIAT', amountMinor: 10000 }, { account: 'USER_FUNDS', amountMinor: -10000 }],
    });
    await eventually(async () => {
      const { rows } = await pgQuery(`SELECT 1 FROM accounting_events WHERE idempotency_key='settle-1'`);
      return rows[0];
    });
    // Exactly the state every fire-and-forget mirror passes through: the Mongo
    // row exists, the Postgres row does not (yet).
    await pgQuery(`TRUNCATE accounting_events RESTART IDENTITY CASCADE`);

    const report = await runReconcile({ all: true });
    const ae = report.results.find(r => r.table === 'accounting_events');

    expect(ae.missingInPg).toBe(0);
    expect(ae.settling).toBe(1);
    // Held back, not hidden: the total is surfaced so a mirror that is
    // genuinely broken shows up as a number that climbs instead of one that
    // returns to zero.
    expect(report.settling.forward).toBeGreaterThanOrEqual(1);
    expect(report.settling.windowMs).toBe(30_000);
    // And the run is not called dirty on account of it.
    expect(report.drift).toBe(false);

    process.env.RECONCILE_SETTLING_WINDOW_MS = '0';
  });

  it('every reconciled table declares the field its incremental filter uses', async () => {
    // Guards the class of bug rather than the two instances: adding a table
    // without a `since` field must fail loudly, not scan nothing.
    for (const t of RECONCILE_TABLES) {
      expect(t.since, `${t.name} has no 'since' field`).toBeTruthy();
      const schemaPaths = mongoose.model(t.model).schema.paths;
      expect(schemaPaths[t.since], `${t.model}.${t.since} is not a real schema path`).toBeDefined();
    }
  });
});
