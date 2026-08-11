// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The ORDER LIFECYCLE across both stores — the suite that decides whether
 * `reconciled` and `rollback` may be claimed for ORDERS.
 *
 * The Postgres-only suite (tests/postgres/orderPg.test.js) proves the state
 * machine refuses illegal moves, survives concurrency and keeps its books. It
 * cannot prove the two halves that need Mongo, and those are what the capability
 * flags actually assert:
 *
 *   reconciled  Given the same order, do the stores AGREE — and when they do
 *               not, does reconcileOrderStates say so instead of reporting clean?
 *   rollback    Can Mongo be brought back up to date from Postgres, so a
 *               fallback is a redeploy rather than a data recovery?
 *
 * ── The distinction this suite exists to hold ───────────────────────────────
 * `payment_orders` is a MIRROR: the Mongo document projected forward on every
 * save, overwritten in place, no history, no guard. `order_states` plus
 * append-only `order_transitions` are the AUTHORITATIVE lifecycle.
 *
 * A reconcile that compared `payment_orders.status` against
 * `PaymentOrder.status` would be comparing a value against a copy of itself —
 * the forward mirror writes one from the other, so they agree by construction
 * and the check reports clean however far the real lifecycle has drifted. Every
 * assertion below reads `order_states`, and one test asserts the two tables can
 * be made to disagree, precisely so that conflating them later fails loudly.
 *
 * ── Polling, not a single read ──────────────────────────────────────────────
 * The forward mirror is fire-and-forget from a Mongoose post-save hook. Waiting
 * for the FIRST of two ordered async writes does not mean the second landed, so
 * every cross-store assertion polls.
 *
 * REQUIRES MongoDB (a replica set) + PostgreSQL. CI-only; the sandbox can run
 * neither mongod nor the reverse direction.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import mongoose from 'mongoose';
import '../../models/index.js';
import { pgConfigured, pgQuery, applySchema, closePg } from '../../postgres/pgClient.js';
import {
  ORDER_STATES, ORDER_TYPES, openOrder, transition, getOrder, getOrderHistory,
} from '../../postgres/orderPg.js';
import { reverseMirrorOrderState } from '../../postgres/reverseMirror.js';
import { reconcileOrderStates } from '../../postgres/reconcile.js';

const HAS_PG = !!process.env.DATABASE_URL;

/**
 * A cross-store suite that silently skips is worse than one that fails: it
 * reports green for a check nobody ran, and this is the suite the `reconciled`
 * and `rollback` claims for ORDERS rest on. Locally, skipping is correct —
 * there is no PostgreSQL. In CI both databases are always provisioned, so
 * skipping there is a misconfiguration and must be loud.
 *
 * This is not hypothetical caution. Verifying from the job logs that a suite
 * actually executed is impractical once a service container's output buries it,
 * and "the step exited 0" cannot distinguish a suite that passed from one that
 * never ran.
 */
if (process.env.CI && !HAS_PG) {
  throw new Error(
    'orderCrossStore.integration.test.js: DATABASE_URL is unset in CI. This suite is the evidence ' +
    'behind ORDERS reconciled/rollback and must never skip silently — provision Postgres or remove the claim.',
  );
}
const d = HAS_PG ? describe : describe.skip;

const PaymentOrder = () => mongoose.model('PaymentOrder');

/**
 * The settling window exists so a mirror that is milliseconds behind is not
 * called drift. It is a delay, not an exemption — but a test that waits 30s per
 * assertion proves nothing extra, so it is switched off here and the window's
 * own behaviour is covered by its own tests.
 */
beforeAll(() => { process.env.RECONCILE_SETTLING_WINDOW_MS = '0'; });

/** Fire-and-forget mirrors: poll until the row lands, never read once. */
async function eventually(fn, ms = 4000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A PaymentOrder needs more than a status to satisfy its schema. */
async function mongoOrder(over = {}) {
  return PaymentOrder().create({
    orderId: `XS_${new mongoose.Types.ObjectId()}`,
    type: 'DEPOSIT',
    userId: new mongoose.Types.ObjectId(),
    merchantId: new mongoose.Types.ObjectId(),
    tokenAmount: 500,
    fiatAmount: 500,
    rateUsed: 1,
    status: ORDER_STATES.PENDING_QUEUE,
    ...over,
  });
}

/** The same order opened in the authoritative lifecycle table. */
async function lifecycleFor(doc, state = null) {
  await openOrder({
    orderId: String(doc._id), userId: String(doc.userId),
    merchantId: doc.merchantId ? String(doc.merchantId) : null,
    type: doc.type, tokenAmountPaise: 50_000, fiatAmountPaise: 50_000,
  });
  if (state && state !== ORDER_STATES.PENDING_QUEUE) {
    await walkTo(String(doc._id), state);
  }
  return getOrder(String(doc._id));
}

/** Walk an order forward through legal moves to reach `target`. */
async function walkTo(orderId, target) {
  const path = {
    [ORDER_STATES.ASSIGNED]:   [ORDER_STATES.ASSIGNED],
    [ORDER_STATES.PROCESSING]: [ORDER_STATES.ASSIGNED, ORDER_STATES.PROCESSING],
    [ORDER_STATES.PAID]:       [ORDER_STATES.ASSIGNED, ORDER_STATES.PROCESSING, ORDER_STATES.PAID],
    [ORDER_STATES.COMPLETED]:  [ORDER_STATES.ASSIGNED, ORDER_STATES.PROCESSING, ORDER_STATES.PAID, ORDER_STATES.COMPLETED],
    [ORDER_STATES.DISPUTED]:   [ORDER_STATES.ASSIGNED, ORDER_STATES.PROCESSING, ORDER_STATES.PAID, ORDER_STATES.DISPUTED],
  }[target];
  if (!path) throw new Error(`walkTo: no path to ${target}`);
  for (const step of path) {
    // ASSIGNED is revisitable, so it carries an explicit key.
    await transition({ orderId, to: step, txId: `${orderId}_${step}_walk` });
  }
}

d('the order lifecycle across MongoDB and PostgreSQL', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => {
    delete process.env.RECONCILE_SETTLING_WINDOW_MS;
    await closePg();
  });

  beforeEach(async () => {
    await pgQuery(`DELETE FROM order_transitions WHERE order_id IN (SELECT order_id FROM order_states)`);
    await pgQuery(`DELETE FROM order_states`);
    await pgQuery(`DELETE FROM payment_orders`);
    await PaymentOrder().deleteMany({});
  });

  // ── reconciled ────────────────────────────────────────────────────────────

  describe('reconcileOrderStates', () => {
    it('reports clean when both stores hold the same state', async () => {
      const doc = await mongoOrder({ status: ORDER_STATES.PAID });
      await lifecycleFor(doc, ORDER_STATES.PAID);

      const report = await reconcileOrderStates();
      expect(report).toMatchObject({ table: 'order_states', disagreeing: 0, unrepairable: 0 });
      expect(report.checked).toBeGreaterThan(0);
    });

    it('REPORTS a disagreement rather than calling it clean', async () => {
      // The whole point. Mongo says the order is still being worked on;
      // Postgres says it finished and the books say so too. After a fallback
      // that is an expiry cron cancelling an order that was already paid.
      const doc = await mongoOrder({ status: ORDER_STATES.PROCESSING });
      await lifecycleFor(doc, ORDER_STATES.COMPLETED);

      const report = await reconcileOrderStates();
      expect(report.disagreeing).toBe(1);
      expect(report.sample[0]).toMatchObject({
        orderId: String(doc._id),
        mongoStatus: ORDER_STATES.PROCESSING,
        pgStatus: ORDER_STATES.COMPLETED,
      });
    });

    it('does NOT compare payment_orders against the Mongo document it was copied from', async () => {
      // The tautology this check must never become. payment_orders is written
      // FROM the Mongo document, so making those two disagree is not possible
      // through the mirror — but order_states can disagree with both, and that
      // is the drift that matters. If a future refactor pointed the reconcile at
      // payment_orders, this test is what fails.
      const doc = await mongoOrder({ status: ORDER_STATES.COMPLETED });
      await lifecycleFor(doc, ORDER_STATES.PAID);          // lifecycle lags

      // The projection is allowed to agree with Mongo…
      await pgQuery(
        `INSERT INTO payment_orders (mongo_id, order_id, user_id, order_type, status, token_amount_paise, fiat_amount_paise)
         VALUES ($1,$2,$3,'DEPOSIT',$4,50000,50000)
         ON CONFLICT (mongo_id) DO UPDATE SET status = EXCLUDED.status`,
        [String(doc._id), doc.orderId, String(doc.userId), ORDER_STATES.COMPLETED],
      );

      // …and the check still reports the lifecycle's disagreement.
      const report = await reconcileOrderStates();
      expect(report.disagreeing).toBe(1);
      expect(report.sample[0]).toMatchObject({ pgStatus: ORDER_STATES.PAID });
    });

    it('does not count a Postgres order with no Mongo document as a state disagreement', async () => {
      // That is a missing row, which the reverse table check owns. Counting it
      // here too would report one problem as two.
      await openOrder({
        orderId: String(new mongoose.Types.ObjectId()), userId: 'u-orphan',
        type: ORDER_TYPES.DEPOSIT, tokenAmountPaise: 50_000,
      });
      expect(await reconcileOrderStates()).toMatchObject({ disagreeing: 0, unrepairable: 0 });
    });

    it('refuses opposite repair directions in one pass', async () => {
      await expect(reconcileOrderStates({ backfill: true, repairMongo: true }))
        .rejects.toThrow(/opposite directions/);
    });
  });

  // ── backfill: Phase A, Mongo authoritative ───────────────────────────────

  describe('--backfill replays Mongo into the lifecycle', () => {
    it('advances Postgres THROUGH the state machine, keeping the history', async () => {
      const doc = await mongoOrder({ status: ORDER_STATES.COMPLETED });
      await lifecycleFor(doc, ORDER_STATES.PAID);

      const report = await reconcileOrderStates({ backfill: true });
      expect(report).toMatchObject({ repaired: 1, unrepairable: 0 });
      expect((await getOrder(String(doc._id))).state).toBe(ORDER_STATES.COMPLETED);

      // Through the machine, not around it: the repair is recorded as a
      // transition with its own reason, so an auditor can see how the order got
      // there. A raw UPDATE would leave the state changed and the history silent.
      const history = await getOrderHistory(String(doc._id));
      const last = history[history.length - 1];
      expect(last).toMatchObject({ from: ORDER_STATES.PAID, to: ORDER_STATES.COMPLETED, actor: 'reconcile' });
    });

    it('reports a move the machine refuses as UNREPAIRABLE rather than forcing it', async () => {
      // Mongo says CANCELLED, Postgres says COMPLETED. Undoing settled value is
      // a reversal, which the settlement domain owns — not a state change that
      // pretends the order never happened. A pass that "repaired" this would
      // erase a completed deposit.
      const doc = await mongoOrder({ status: ORDER_STATES.CANCELLED });
      await lifecycleFor(doc, ORDER_STATES.COMPLETED);

      const report = await reconcileOrderStates({ backfill: true });
      expect(report).toMatchObject({ repaired: 0, unrepairable: 1 });
      // Still COMPLETED — the fault is left visible for a human.
      expect((await getOrder(String(doc._id))).state).toBe(ORDER_STATES.COMPLETED);
      // And the pass does NOT report clean.
      expect(report.disagreeing).toBe(1);
    });

    it('replays a state the order has held BEFORE without being refused as a replay', async () => {
      // The requeue cycle (docs/ORDERS_REQUEUE_CYCLE.md) makes a reconcile pass
      // exactly the place a repeat visit arrives: the order has been ASSIGNED
      // before, so the default key is taken. Without an occurrence-scoped key
      // the repair would come back "already done" and silently do nothing.
      const doc = await mongoOrder({ status: ORDER_STATES.ASSIGNED });
      await lifecycleFor(doc, ORDER_STATES.ASSIGNED);
      await transition({ orderId: String(doc._id), to: ORDER_STATES.PENDING_QUEUE, txId: `${doc._id}_requeue` });

      const report = await reconcileOrderStates({ backfill: true });
      expect(report).toMatchObject({ repaired: 1, unrepairable: 0 });
      expect((await getOrder(String(doc._id))).state).toBe(ORDER_STATES.ASSIGNED);
      const assigns = (await getOrderHistory(String(doc._id))).filter((h) => h.to === ORDER_STATES.ASSIGNED);
      expect(assigns).toHaveLength(2);        // two real visits, not one swallowed
    });
  });

  // ── rollback: Phase B, Postgres authoritative ────────────────────────────

  describe('--repair-mongo brings Mongo back up to date', () => {
    it('writes the authoritative state back to the Mongo document', async () => {
      const doc = await mongoOrder({ status: ORDER_STATES.PROCESSING });
      await lifecycleFor(doc, ORDER_STATES.COMPLETED);

      const report = await reconcileOrderStates({ repairMongo: true });
      expect(report).toMatchObject({ repaired: 1 });

      const fresh = await eventually(async () => {
        const o = await PaymentOrder().findById(doc._id).lean();
        return o?.status === ORDER_STATES.COMPLETED ? o : null;
      });
      expect(fresh.status).toBe(ORDER_STATES.COMPLETED);
    });

    it('leaves the two stores agreeing, so a second pass is clean', async () => {
      // The property a rollback actually needs: not that one row was written,
      // but that the drift is GONE. A repair that reported success while the
      // stores still disagreed would make the fallback look complete when it
      // was not.
      const doc = await mongoOrder({ status: ORDER_STATES.ASSIGNED });
      await lifecycleFor(doc, ORDER_STATES.PAID);

      await reconcileOrderStates({ repairMongo: true });
      await eventually(async () => {
        const o = await PaymentOrder().findById(doc._id).lean();
        return o?.status === ORDER_STATES.PAID;
      });
      expect(await reconcileOrderStates()).toMatchObject({ disagreeing: 0, unrepairable: 0 });
    });

    it('carries the transition fields with the status, not the status alone', async () => {
      // A Mongo document found in the new state without the facts that justify
      // it is the window the seam's single-update rule closes; a reverse mirror
      // that wrote only the status would reopen it here.
      const doc = await mongoOrder({ status: ORDER_STATES.PROCESSING });
      const row = await lifecycleFor(doc, ORDER_STATES.COMPLETED);
      const completedAt = new Date('2026-08-10T00:00:00Z');

      await reverseMirrorOrderState(
        { order_id: String(doc._id), state: row.state, merchant_id: row.merchantId, updated_at: new Date() },
        { completedAt },
      );

      const fresh = await eventually(async () => {
        const o = await PaymentOrder().findById(doc._id).lean();
        return o?.status === ORDER_STATES.COMPLETED ? o : null;
      });
      expect(new Date(fresh.completedAt).toISOString()).toBe(completedAt.toISOString());
    });
  });
});
