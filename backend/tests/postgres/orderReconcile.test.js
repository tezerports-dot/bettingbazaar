// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * reconcileOrderStates against a REAL PostgreSQL, with the Mongo side stubbed.
 *
 * The cross-store suite (tests/integration/orderCrossStore.integration.test.js)
 * is the one that proves the two stores agree, and it needs a real MongoDB. This
 * one covers what does not: the SQL itself, the repair direction, and — the part
 * worth having a fast test for — that a repair which the state machine refuses
 * is reported as UNREPAIRABLE rather than counted as fixed.
 *
 * Splitting it this way means the reconcile's own logic is verifiable in the
 * build sandbox, where mongod cannot run, instead of waiting on CI to find a
 * typo'd column name.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

/**
 * The Mongo side, as a table this test controls. reconcile.js calls
 * `mongoose.model('PaymentOrder').find(...).select(...).lean()`, so that chain
 * is all that needs to exist.
 */
const mongoOrders = new Map();
vi.mock('mongoose', () => ({
  default: {
    model: (name) => {
      if (name !== 'PaymentOrder') throw new Error(`unexpected model(${name})`);
      return {
        find: ({ _id: { $in: ids } }) => ({
          select: () => ({
            lean: async () => ids
              .filter((id) => mongoOrders.has(String(id)))
              .map((id) => ({ _id: String(id), status: mongoOrders.get(String(id)) })),
          }),
        }),
        updateOne: async () => ({ acknowledged: true }),
      };
    },
  },
}));

import { pgConfigured, pgQuery, applySchema, closePg } from '../../postgres/pgClient.js';
import { ORDER_STATES, ORDER_TYPES, openOrder, transition, getOrder, getOrderHistory } from '../../postgres/orderPg.js';
import { reconcileOrderStates } from '../../postgres/reconcile.js';

// Same reason as the cross-store suite: in CI Postgres is always provisioned,
// so a skip there is a misconfiguration reporting green for a check nobody ran.
if (process.env.CI && !pgConfigured()) {
  throw new Error('orderReconcile.test.js: DATABASE_URL is unset in CI — this suite must not skip silently.');
}
const describePg = pgConfigured() ? describe : describe.skip;

/** Open an order in Postgres and tell the fake Mongo what IT thinks the status is. */
async function pair(id, pgState, mongoStatus) {
  await openOrder({
    orderId: id, userId: 'u1', merchantId: 'm1',
    type: ORDER_TYPES.DEPOSIT, tokenAmountPaise: 50_000, fiatAmountPaise: 50_000,
  });
  const path = {
    [ORDER_STATES.PENDING_QUEUE]: [],
    [ORDER_STATES.ASSIGNED]:   [ORDER_STATES.ASSIGNED],
    [ORDER_STATES.PROCESSING]: [ORDER_STATES.ASSIGNED, ORDER_STATES.PROCESSING],
    [ORDER_STATES.PAID]:       [ORDER_STATES.ASSIGNED, ORDER_STATES.PROCESSING, ORDER_STATES.PAID],
    [ORDER_STATES.COMPLETED]:  [ORDER_STATES.ASSIGNED, ORDER_STATES.PROCESSING, ORDER_STATES.PAID, ORDER_STATES.COMPLETED],
  }[pgState];
  for (const step of path) await transition({ orderId: id, to: step, txId: `${id}_${step}_setup` });
  if (mongoStatus) mongoOrders.set(id, mongoStatus);
}

describePg('reconcileOrderStates (real PostgreSQL, stubbed Mongo)', () => {
  beforeAll(async () => {
    process.env.RECONCILE_SETTLING_WINDOW_MS = '0';
    await applySchema();
  });
  afterAll(async () => {
    delete process.env.RECONCILE_SETTLING_WINDOW_MS;
    await closePg();
  });
  beforeEach(async () => {
    mongoOrders.clear();
    await pgQuery('TRUNCATE order_transitions, order_states, accounting_events RESTART IDENTITY CASCADE');
  });

  it('reports clean when both stores hold the same state', async () => {
    await pair('rc1', ORDER_STATES.PAID, ORDER_STATES.PAID);
    expect(await reconcileOrderStates()).toMatchObject({
      table: 'order_states', disagreeing: 0, unrepairable: 0, checked: 1,
    });
  });

  it('REPORTS a disagreement rather than calling it clean', async () => {
    await pair('rc2', ORDER_STATES.COMPLETED, ORDER_STATES.PROCESSING);
    const report = await reconcileOrderStates();
    expect(report.disagreeing).toBe(1);
    expect(report.sample[0]).toMatchObject({
      orderId: 'rc2', mongoStatus: ORDER_STATES.PROCESSING, pgStatus: ORDER_STATES.COMPLETED,
    });
  });

  it('does not count a Postgres order with no Mongo document as a disagreement', async () => {
    // That is a missing row, which the reverse table check owns. Counting it
    // here too would report one problem as two.
    await pair('rc3', ORDER_STATES.PAID, null);
    expect(await reconcileOrderStates()).toMatchObject({ disagreeing: 0, unrepairable: 0 });
  });

  it('refuses opposite repair directions in one pass', async () => {
    await expect(reconcileOrderStates({ backfill: true, repairMongo: true }))
      .rejects.toThrow(/opposite directions/);
  });

  describe('--backfill', () => {
    it('advances Postgres THROUGH the state machine, keeping the history', async () => {
      await pair('rc4', ORDER_STATES.PAID, ORDER_STATES.COMPLETED);

      expect(await reconcileOrderStates({ backfill: true }))
        .toMatchObject({ repaired: 1, unrepairable: 0 });
      expect((await getOrder('rc4')).state).toBe(ORDER_STATES.COMPLETED);

      // Through the machine, not around it. A raw UPDATE would leave the state
      // changed and order_transitions silent about how it got there — which is
      // the history that table exists to keep.
      const history = await getOrderHistory('rc4');
      expect(history[history.length - 1]).toMatchObject({
        from: ORDER_STATES.PAID, to: ORDER_STATES.COMPLETED, actor: 'reconcile',
      });
    });

    it('reports a move the machine refuses as UNREPAIRABLE rather than forcing it', async () => {
      // Mongo says CANCELLED, Postgres says COMPLETED. Undoing settled value is
      // a reversal, which the settlement domain owns — not a state change that
      // pretends the order never happened. A pass that "repaired" this would
      // erase a completed deposit.
      await pair('rc5', ORDER_STATES.COMPLETED, ORDER_STATES.CANCELLED);

      const report = await reconcileOrderStates({ backfill: true });
      expect(report).toMatchObject({ repaired: 0, unrepairable: 1 });
      expect((await getOrder('rc5')).state).toBe(ORDER_STATES.COMPLETED);
      // And the pass does NOT report clean — an unrepairable finding is drift.
      expect(report.disagreeing).toBe(1);
      expect(report.sample[0].unrepairable).toMatch(/not reachable/);
    });

    it('replays a state the order has held BEFORE without being refused as a replay', async () => {
      // A reconcile pass is exactly where a repeat visit arrives: it replays
      // states the order has already held, so the default ord_<order>_<state>
      // key is taken. Without an occurrence-scoped key the repair comes back
      // "already done" and silently does nothing.
      await pair('rc6', ORDER_STATES.ASSIGNED, ORDER_STATES.ASSIGNED);
      await transition({ orderId: 'rc6', to: ORDER_STATES.PENDING_QUEUE, txId: 'rc6_requeue' });

      expect(await reconcileOrderStates({ backfill: true }))
        .toMatchObject({ repaired: 1, unrepairable: 0 });
      expect((await getOrder('rc6')).state).toBe(ORDER_STATES.ASSIGNED);
      const assigns = (await getOrderHistory('rc6')).filter((h) => h.to === ORDER_STATES.ASSIGNED);
      expect(assigns).toHaveLength(2);   // two real visits, not one swallowed
    });

    it('leaves the stores agreeing, so a second pass is clean', async () => {
      await pair('rc7', ORDER_STATES.PROCESSING, ORDER_STATES.PAID);
      await reconcileOrderStates({ backfill: true });
      expect(await reconcileOrderStates()).toMatchObject({ disagreeing: 0, unrepairable: 0 });
    });
  });
});
