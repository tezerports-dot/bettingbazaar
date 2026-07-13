// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
import { WalletLedger, AccountingEvent, UTRRegistry } from '../../models/index.js';
import { pgConfigured, pgQuery, applySchema, closePg } from '../../postgres/pgClient.js';
import { mirrorAccountingEvent } from '../../postgres/dualWrite.js';
import { runReconcile, pgTrialBalance } from '../../postgres/reconcile.js';

const HAS_PG = !!process.env.DATABASE_URL;
const d = HAS_PG ? describe : describe.skip;

const PG_TABLES = ['wallet_ledger', 'wallets', 'accounting_events', 'transactions',
                   'payment_orders', 'utr_registry', 'merchant_wallet_ledger', 'user_kyc'];

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
    for (const t of PG_TABLES) await pgQuery(`TRUNCATE ${t} RESTART IDENTITY CASCADE`);
  });

  afterAll(async () => { await closePg(); });

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
    const { rows: [w] } = await pgQuery(`SELECT * FROM wallets WHERE user_id=$1`, [String(userId)]);
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
});
