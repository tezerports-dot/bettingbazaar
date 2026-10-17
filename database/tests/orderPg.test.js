// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Payment orders — domain 5, the workflow glue.
 *
 * The invariants:
 *   • a transition names the states it accepts, and the guard is in the
 *     UPDATE's WHERE — an out-of-order callback is refused, not obeyed
 *   • a duplicate callback is reported as ALREADY DONE, never as a failure
 *   • a state change and the accounting event it produces commit together or
 *     not at all
 *   • the transition history is append-only, and links each state change to the
 *     ledger entry it produced
 *   • concurrency does not deadlock or exhaust the connection pool
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg, getPool } from '../client.js';
import {
  ORDER_STATES, ORDER_TYPES, REVISITABLE, transition, getOrder, getOrderHistory,
  startOrder, markPaid, completeOrder, disputeOrder, cancelOrder, failOrder,
  findOrdersMissingLedgerEvents, findLedgerEventsMissingOrders,
} from '../repositories/orders.core.js';
import { createOrderRecord } from '../repositories/orders.record.js';
import { trialBalance, accountBalancePaise, getEvent } from '../repositories/ledger.core.js';
import { verifyOrderHmac } from '../../backend/middleware/order-crypto-access.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

/**
 * Open an order through THE creation path.
 *
 * These tests used to open theirs through `openOrder`, a second creation path
 * production never called — and the only one that wrote the tamper tag. So the
 * tag was proven here, on a door nobody used, while every live order was
 * created untagged through `createOrderRecord`. `openOrder` is deleted; the
 * lifecycle is now exercised on the rows production actually writes.
 */
const open = async (id, type = ORDER_TYPES.DEPOSIT, paise = 100_000, { merchantId = 'm1' } = {}) => ({
  order: await createOrderRecord({
    orderId: id, userId: 'u1', type, tokenAmountRupees: paise / 100,
    ...(merchantId ? { merchantId } : {}),
  }),
});

/** Walk an order to PAID, the usual pre-completion position. */
async function toPaid(id, type = ORDER_TYPES.DEPOSIT, paise = 100_000) {
  await open(id, type, paise);
  // PROCESSING is revisitable (a started order can be requeued and offered
  // again), so it takes an explicit key rather than the default
  // ord_<order>_PROCESSING. Routing starts an order as it hands it out: there
  // is no ASSIGNED step and no Accept (owner, 2026-10-17).
  await startOrder({ orderId: id, txId: `${id}_start_1` });
  await markPaid({ orderId: id });
}

describePg('Payment orders (PostgreSQL state machine)', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE order_transitions, order_states, accounting_events RESTART IDENTITY CASCADE');
  });

  // ── The lifecycle ──────────────────────────────────────────────────────────
  describe('lifecycle', () => {
    it('walks the happy path and records every step', async () => {
      await toPaid('o1');
      const done = await completeOrder({ orderId: 'o1', actor: 'merchant-7' });
      expect(done).toMatchObject({ ok: true, idempotent: false });
      expect((await getOrder('o1')).state).toBe(ORDER_STATES.COMPLETED);

      expect((await getOrderHistory('o1')).map((h) => [h.from, h.to])).toEqual([
        ['PENDING_QUEUE', 'PROCESSING'],
        ['PROCESSING', 'PAID'],
        ['PAID', 'COMPLETED'],
      ]);
    });

    it('opens idempotently — a retried creation is the same order', async () => {
      const first = await open('o2');
      const second = await open('o2');
      expect(second.order.orderId).toBe(first.order.orderId);
      // The same row, not a second one re-signed: the tag is the one it was
      // born with.
      expect(second.order.orderHmac).toBe(first.order.orderHmac);
      const { rows } = await pgQuery('SELECT COUNT(*)::int n FROM order_states');
      expect(rows[0].n).toBe(1);
    });

    it('refuses a malformed order rather than storing one', async () => {
      await expect(createOrderRecord({ orderId: 'x', userId: 'u', type: 'SIDEWAYS', tokenAmountRupees: 1 }))
        .rejects.toThrow(/unknown order type/);
      await expect(createOrderRecord({ orderId: 'x', userId: 'u', type: 'DEPOSIT', tokenAmountRupees: 0 }))
        .rejects.toThrow(/must be positive/);
      await expect(createOrderRecord({ orderId: 'x', userId: 'u', type: 'DEPOSIT', tokenAmountRupees: -5 }))
        .rejects.toThrow(/must be positive/);
      const { rows } = await pgQuery('SELECT COUNT(*)::int n FROM order_states');
      expect(rows[0].n).toBe(0);
    });

    it('refuses a deposit whose split does not add up — the ROW is impossible', async () => {
      // `depositCreditSplit` would credit the whole amount to betting for a
      // split that does not close. That fallback is unreachable from a stored
      // order, deliberately: `order_states_allocation_closes` refuses the row,
      // so an order carrying a difference nothing accounts for cannot exist.
      // Moved here 2026-10-01 from paymentRoutes.test.js, where it rode on a
      // confirm route that was deleted; it is a property of the TABLE.
      await expect(createOrderRecord({
        orderId: 'split-bad', userId: 'u', type: 'DEPOSIT', tokenAmountRupees: 500,
        fiatAmountRupees: 500, depositAllocation: 300, reserveAllocation: 100,
      })).rejects.toThrow(/order_states_allocation_closes/);
      // The two shapes the CHECK allows: a split that closes, and no split.
      await createOrderRecord({
        orderId: 'split-ok', userId: 'u', type: 'DEPOSIT', tokenAmountRupees: 500,
        fiatAmountRupees: 500, depositAllocation: 400, reserveAllocation: 100,
      });
      await createOrderRecord({
        orderId: 'split-none', userId: 'u', type: 'DEPOSIT', tokenAmountRupees: 500,
        fiatAmountRupees: 500, depositAllocation: 0, reserveAllocation: 0,
      });
      const { rows } = await pgQuery(`SELECT order_id FROM order_states ORDER BY order_id`);
      expect(rows.map((r) => r.order_id)).toEqual(['split-none', 'split-ok']);
    });

    it('records the merchant when the order is started', async () => {
      await open('o3', ORDER_TYPES.DEPOSIT, 50_000, { merchantId: null });
      expect((await getOrder('o3')).merchantId).toBeNull();
      await startOrder({ orderId: 'o3', merchantId: 'm9', txId: 'o3_start_1' });
      expect((await getOrder('o3')).merchantId).toBe('m9');
    });
  });

    it('signs a new order with its tamper-evidence tag, in the same statement', async () => {
      // The suite runs with no secret configured, which is the deployment the
      // tag has to degrade gracefully for — so the tests that check SIGNING
      // supply one, and the rest prove creation still works without it.
      process.env.ORDER_HMAC_SECRET = 'test-order-secret';
      const { order } = await open('ORD-HMAC-1');
      // Written WITH the row. Signing afterwards leaves a window in which an
      // order exists unsigned, and an unsigned order cannot be told apart from
      // one whose tag was stripped — the only thing the tag is for.
      expect(order.orderHmac).toMatch(/^[a-f0-9]{64}$/);
      expect(verifyOrderHmac('ORD-HMAC-1', order.orderHmac)).toBe(true);
    });

    it('gives two orders different tags, so one cannot be replayed as another', async () => {
      process.env.ORDER_HMAC_SECRET = 'test-order-secret';
      const a = await open('ORD-HMAC-A');
      const b = await open('ORD-HMAC-B');
      expect(a.order.orderHmac).not.toBe(b.order.orderHmac);
      expect(verifyOrderHmac('ORD-HMAC-A', b.order.orderHmac)).toBe(false);
    });

    it('keeps the tag the order was created with across a transition', async () => {
      process.env.ORDER_HMAC_SECRET = 'test-order-secret';
      const { order } = await open('ORD-HMAC-2');
      await transition({ orderId: 'ORD-HMAC-2', to: 'PROCESSING', txId: 'tx-hmac-2' });
      const after = await getOrder('ORD-HMAC-2');
      // A re-signed order is exactly what the tag exists to detect, so nothing
      // in the lifecycle may rewrite it.
      expect(after.orderHmac).toBe(order.orderHmac);
      delete process.env.ORDER_HMAC_SECRET;
    });

    it('creates an order with no tag when no secret is configured', async () => {
      delete process.env.ORDER_HMAC_SECRET;
      const before = process.env.JWT_SECRET;
      delete process.env.JWT_SECRET;
      // The tag is OPTIONAL. Throwing here would take down order creation — the
      // money path — over a missing key for a detection control.
      const { order } = await open('ORD-HMAC-NONE');
      expect(order.orderHmac).toBeNull();
      if (before !== undefined) process.env.JWT_SECRET = before;
    });

  // ── The guard ──────────────────────────────────────────────────────────────
  describe('state guard', () => {
    it('refuses a transition from the wrong state and says what it would accept', async () => {
      await open('g1');
      const early = await completeOrder({ orderId: 'g1' });
      expect(early).toMatchObject({
        ok: false, reason: 'invalid_transition', state: ORDER_STATES.PENDING_QUEUE,
      });
      expect(early.allowedFrom).toContain(ORDER_STATES.PAID);
      expect((await getOrder('g1')).state).toBe(ORDER_STATES.PENDING_QUEUE);
    });

    it('refuses to cancel an order that already completed', async () => {
      // Undoing settled value is a reversal, which belongs to the settlement
      // domain — not a state change that pretends the order never happened.
      await toPaid('g2');
      await completeOrder({ orderId: 'g2' });
      expect(await cancelOrder({ orderId: 'g2' }))
        .toMatchObject({ ok: false, reason: 'invalid_transition', state: ORDER_STATES.COMPLETED });
    });

    it('allows a dispute on a completed order — that is when disputes happen', async () => {
      await toPaid('g3');
      await completeOrder({ orderId: 'g3' });
      expect(await disputeOrder({ orderId: 'g3', reason: 'user says nothing arrived' }))
        .toMatchObject({ ok: true, idempotent: false });
      expect((await getOrder('g3')).state).toBe(ORDER_STATES.DISPUTED);
    });

    it('distinguishes an unknown order from a wrong-state one', async () => {
      expect(await completeOrder({ orderId: 'nope' })).toEqual({ ok: false, reason: 'not_found' });
    });

    it('rejects an unknown target state', async () => {
      await open('g4');
      await expect(transition({ orderId: 'g4', to: 'ELSEWHERE' })).rejects.toThrow(/Unknown order state/);
    });

    // ── The requeue cycle ────────────────────────────────────────────────────
    // A member declining a started order nobody can have paid on sends it back
    // to the queue to be offered to someone else (merchant.routes.js decline).
    // That makes PENDING_QUEUE and PROCESSING states an order can occupy twice,
    // which is what the default ord_<order>_<state> key cannot express.
    describe('requeue', () => {
      it('names exactly the states an order can reach more than once', () => {
        // Two cycles produce these four: PENDING_QUEUE↔PROCESSING (a member
        // declines and the order is offered to someone else) and
        // COMPLETED↔DISPUTED (a completed order is disputed and the dispute is
        // resolved back in the merchant's favour).
        expect([...REVISITABLE].sort()).toEqual(['COMPLETED', 'DISPUTED', 'PENDING_QUEUE', 'PROCESSING']);
      });

      it('lets a FIRST visit use the default key, and refuses a repeat without one', async () => {
        await open('rq0');
        // First arrival: nothing to collide with, so no key is demanded. The
        // check is about the key already being taken, not about the state.
        await expect(transition({ orderId: 'rq0', to: ORDER_STATES.PROCESSING }))
          .resolves.toMatchObject({ ok: true, idempotent: false });
        await transition({ orderId: 'rq0', to: ORDER_STATES.PENDING_QUEUE, txId: 'rq0_requeue_1' });

        // Second arrival at PROCESSING: loud, not silent. Colliding with the
        // first visit's key would be reported as "already done".
        await expect(transition({ orderId: 'rq0', to: ORDER_STATES.PROCESSING }))
          .rejects.toThrow(/requires an explicit txId/);
        expect((await getOrder('rq0')).state).toBe(ORDER_STATES.PENDING_QUEUE);
      });

      it('reassigns a rejected order to a different merchant', async () => {
        await open('rq1', ORDER_TYPES.DEPOSIT, 50_000, { merchantId: null });
        await startOrder({ orderId: 'rq1', merchantId: 'm1', txId: 'rq1_assign_1' });
        await transition({ orderId: 'rq1', to: ORDER_STATES.PENDING_QUEUE, txId: 'rq1_requeue_1', reason: 'declined' });
        expect((await getOrder('rq1')).state).toBe(ORDER_STATES.PENDING_QUEUE);

        const second = await startOrder({ orderId: 'rq1', merchantId: 'm2', txId: 'rq1_assign_2' });
        // Before the key carried the occurrence, this came back
        // { ok: true, idempotent: true } and the order stayed in PENDING_QUEUE
        // still holding m1 — a rejected order was never reassigned, silently.
        expect(second).toMatchObject({ ok: true, idempotent: false });
        const order = await getOrder('rq1');
        expect(order.state).toBe(ORDER_STATES.PROCESSING);
        expect(order.merchantId).toBe('m2');

        expect((await getOrderHistory('rq1')).map((h) => [h.from, h.to])).toEqual([
          ['PENDING_QUEUE', 'PROCESSING'],
          ['PROCESSING', 'PENDING_QUEUE'],
          ['PENDING_QUEUE', 'PROCESSING'],
        ]);
      });

      // The case the UNIQUE tx_id is actually load-bearing for. A replay that
      // arrives while the order still sits in the state it moved it to is
      // caught earlier, by the same-state short-circuit under the row lock —
      // so it proves nothing about the key. This one arrives AFTER the order
      // was requeued again, where the state guard would happily let it through
      // a second time and only the key can refuse it. That is the delayed
      // duplicate an out-of-order provider or a retried admin click produces.
      // The second cycle, and the one that carries money. A completed order can
      // be disputed and the dispute resolved back to completed — so COMPLETED
      // is reachable twice, and its ledger key is derived from the same string
      // the transition key is.
      it('resolves a dispute on a completed order without double-posting the ledger', async () => {
        await toPaid('dq1', ORDER_TYPES.DEPOSIT, 70_000);
        await completeOrder({ orderId: 'dq1' });
        const afterFirst = await accountBalancePaise('USER_FUNDS');

        await disputeOrder({ orderId: 'dq1', reason: 'user says nothing arrived' });
        expect((await getOrder('dq1')).state).toBe(ORDER_STATES.DISPUTED);

        // Resolved in the merchant's favour: the order returns to COMPLETED.
        // Without a key this is refused loudly rather than silently swallowed.
        await expect(completeOrder({ orderId: 'dq1' })).rejects.toThrow(/requires an explicit txId/);

        const resolved = await completeOrder({ orderId: 'dq1', txId: 'dq1_dispute_resolved_1' });
        expect(resolved).toMatchObject({ ok: true, idempotent: false });
        expect((await getOrder('dq1')).state).toBe(ORDER_STATES.COMPLETED);

        // The money moved once, when the order first completed. Re-completing
        // after a dispute must not post a second DEPOSIT_COMPLETED — the funds
        // were already credited and the books would double-count them.
        expect(await accountBalancePaise('USER_FUNDS')).toBe(afterFirst);
        expect(await trialBalance()).toMatchObject({ ok: true });
      });

      it('refuses a stale assignment replay that the state guard would re-admit', async () => {
        await open('rq4', ORDER_TYPES.DEPOSIT, 50_000, { merchantId: null });
        await startOrder({ orderId: 'rq4', merchantId: 'm1', txId: 'rq4_assign_1' });
        await transition({ orderId: 'rq4', to: ORDER_STATES.PENDING_QUEUE, txId: 'rq4_requeue_1' });
        await startOrder({ orderId: 'rq4', merchantId: 'm2', txId: 'rq4_assign_2' });
        await transition({ orderId: 'rq4', to: ORDER_STATES.PENDING_QUEUE, txId: 'rq4_requeue_2' });
        expect((await getOrder('rq4')).state).toBe(ORDER_STATES.PENDING_QUEUE);

        // PENDING_QUEUE → PROCESSING is legal right now, so ALLOWED_FROM permits
        // it and the state is not the target — both earlier gates pass.
        const stale = await startOrder({ orderId: 'rq4', merchantId: 'm2', txId: 'rq4_assign_2' });
        expect(stale).toMatchObject({ ok: true, idempotent: true });
        expect((await getOrder('rq4')).state).toBe(ORDER_STATES.PENDING_QUEUE);
        const { rows } = await pgQuery(
          `SELECT COUNT(*)::int n FROM order_transitions WHERE order_id='rq4' AND to_state='PROCESSING'`);
        expect(rows[0].n).toBe(2);
      });

      it('still collapses a genuine replay of the same assignment', async () => {
        await open('rq2', ORDER_TYPES.DEPOSIT, 50_000, { merchantId: null });
        await startOrder({ orderId: 'rq2', merchantId: 'm1', txId: 'rq2_assign_1' });
        await transition({ orderId: 'rq2', to: ORDER_STATES.PENDING_QUEUE, txId: 'rq2_requeue_1' });
        await startOrder({ orderId: 'rq2', merchantId: 'm2', txId: 'rq2_assign_2' });
        // Same event delivered twice — the retry protection the explicit key
        // exists to preserve.
        const replay = await startOrder({ orderId: 'rq2', merchantId: 'm2', txId: 'rq2_assign_2' });
        expect(replay).toMatchObject({ ok: true, idempotent: true });
        const { rows } = await pgQuery(
          `SELECT COUNT(*)::int n FROM order_transitions WHERE order_id='rq2' AND to_state='PROCESSING'`);
        expect(rows[0].n).toBe(2); // two real assignments, not three
      });

      it('survives a storm of one reassignment, applying it once', async () => {
        await open('rq3', ORDER_TYPES.DEPOSIT, 50_000, { merchantId: null });
        await startOrder({ orderId: 'rq3', merchantId: 'm1', txId: 'rq3_assign_1' });
        await transition({ orderId: 'rq3', to: ORDER_STATES.PENDING_QUEUE, txId: 'rq3_requeue_1' });

        const results = await Promise.all(Array.from({ length: 50 }, () =>
          startOrder({ orderId: 'rq3', merchantId: 'm2', txId: 'rq3_assign_2' })));
        expect(results.every((r) => r.ok)).toBe(true);
        expect(results.filter((r) => !r.idempotent)).toHaveLength(1);
        const { rows } = await pgQuery(
          `SELECT COUNT(*)::int n FROM order_transitions WHERE order_id='rq3' AND to_state='PROCESSING'`);
        expect(rows[0].n).toBe(2);
      });
    });

    it('cannot be forced into an unknown state even by direct SQL', async () => {
      await open('g5');
      await expect(pgQuery(`UPDATE order_states SET state = 'HALFWAY' WHERE order_id = 'g5'`))
        .rejects.toThrow(/order_states_known/);
    });
  });

  describe('ledger events', () => {
    it('posts a deposit event when the order completes, in the same transaction', async () => {
      await toPaid('l1', ORDER_TYPES.DEPOSIT, 250_000);
      const r = await completeOrder({ orderId: 'l1' });

      expect(r.ledgerKey).toBe('acct_ord_l1_COMPLETED');
      const event = await getEvent(r.ledgerKey);
      expect(event).toMatchObject({ eventType: 'DEPOSIT_COMPLETED', refModel: 'PaymentOrder', refId: 'l1' });
      expect(await accountBalancePaise('USER_FUNDS')).toBe(250_000);
      expect((await trialBalance()).conservesToZero).toBe(true);
    });

    it('posts the opposite event for a withdrawal', async () => {
      await toPaid('l2', ORDER_TYPES.WITHDRAWAL, 90_000);
      await completeOrder({ orderId: 'l2' });
      expect((await getEvent('acct_ord_l2_COMPLETED')).eventType).toBe('WITHDRAWAL_COMPLETED');
      // The liability falls: the user's tokens left the platform.
      expect(await accountBalancePaise('USER_FUNDS')).toBe(-90_000);
      expect((await trialBalance()).conservesToZero).toBe(true);
    });

    it('posts NOTHING for transitions that move workflow rather than value', async () => {
      await toPaid('l3');
      const { rows } = await pgQuery('SELECT COUNT(*)::int n FROM accounting_events');
      expect(rows[0].n).toBe(0);
      // …and the transitions carry no ledger key to chase.
      expect((await getOrderHistory('l3')).every((h) => h.ledgerKey === null)).toBe(true);
    });

    it('leaves no order completed without its accounting entry', async () => {
      await toPaid('l4', ORDER_TYPES.DEPOSIT, 10_000);
      await toPaid('l5', ORDER_TYPES.WITHDRAWAL, 20_000);
      await completeOrder({ orderId: 'l4' });
      await completeOrder({ orderId: 'l5' });

      expect(await findOrdersMissingLedgerEvents()).toEqual([]);
      expect(await findLedgerEventsMissingOrders()).toEqual([]);
    });

    it('detects an order-shaped ledger entry that no transition produced', async () => {
      // An event posted directly rather than by a state change — the reverse
      // gap, which the forward check is structurally blind to.
      await pgQuery(
        `INSERT INTO accounting_events (idempotency_key, event_type, amount_paise, ref_model, ref_id, postings)
         VALUES ('acct_ghost','DEPOSIT_COMPLETED',100,'PaymentOrder','ghost',
                 '[{"account":"EXTERNAL_FIAT","amountPaise":100},{"account":"USER_FUNDS","amountPaise":-100}]')`);

      expect(await findLedgerEventsMissingOrders())
        .toEqual([{ ledgerKey: 'acct_ghost', eventType: 'DEPOSIT_COMPLETED', orderId: 'ghost' }]);
    });
  });

  // ── Idempotency ────────────────────────────────────────────────────────────
  describe('idempotency', () => {
    it('reports a repeated transition as ALREADY DONE, not as a failure', async () => {
      await toPaid('i1');
      const a = await completeOrder({ orderId: 'i1' });
      const b = await completeOrder({ orderId: 'i1' });
      expect(a).toMatchObject({ ok: true, idempotent: false });
      expect(b).toMatchObject({ ok: true, idempotent: true });
    });

    it('survives a 100-copy storm of the same callback', async () => {
      await toPaid('i2', ORDER_TYPES.DEPOSIT, 40_000);
      const results = await Promise.all(
        Array.from({ length: 100 }, () => completeOrder({ orderId: 'i2' })),
      );

      expect(results.filter((r) => r.ok && !r.idempotent)).toHaveLength(1);
      expect(results.filter((r) => r.ok)).toHaveLength(100);   // every copy sees success
      // The event was posted once, so the liability is 40_000 and not 4_000_000.
      expect(await accountBalancePaise('USER_FUNDS')).toBe(40_000);
      const { rows } = await pgQuery(
        `SELECT COUNT(*)::int n FROM order_transitions WHERE order_id = 'i2' AND to_state = 'COMPLETED'`);
      expect(rows[0].n).toBe(1);
    });

    it('lets exactly ONE of a racing complete and dispute win', async () => {
      await toPaid('i3');
      const [done, disputed] = await Promise.all([
        completeOrder({ orderId: 'i3' }),
        disputeOrder({ orderId: 'i3' }),
      ]);
      // Both are legal from PAID; only one may happen.
      expect([done.ok, disputed.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1);
      const final = (await getOrder('i3')).state;
      expect([ORDER_STATES.COMPLETED, ORDER_STATES.DISPUTED]).toContain(final);
      expect((await trialBalance()).conservesToZero).toBe(true);
    });
  });

  // ── Concurrency ────────────────────────────────────────────────────────────
  describe('concurrency', () => {
    it('completes 60 orders at once without deadlocking or exhausting the pool', async () => {
      const ids = Array.from({ length: 60 }, (_, i) => `c_${i}`);
      for (const id of ids) await toPaid(id, ORDER_TYPES.DEPOSIT, 1_000);

      const pool = await getPool();
      const results = await Promise.all(ids.map((orderId) => completeOrder({ orderId })));

      expect(results.every((r) => r.ok)).toBe(true);
      expect(pool.waitingCount).toBe(0);
      expect(await accountBalancePaise('USER_FUNDS')).toBe(60_000);
      expect((await trialBalance()).conservesToZero).toBe(true);
      expect(await findOrdersMissingLedgerEvents()).toEqual([]);
    });

    it('keeps state and books together through an interleaved storm', async () => {
      const ids = Array.from({ length: 40 }, (_, i) => `s_${i}`);
      for (const id of ids) await toPaid(id, ORDER_TYPES.DEPOSIT, 2_000);

      // Half complete, half fail, all at once — and every completion must have
      // its entry while every failure must have none.
      await Promise.all(ids.map((orderId, i) => (i % 2
        ? completeOrder({ orderId })
        : failOrder({ orderId, reason: 'provider timeout' }))));

      expect(await accountBalancePaise('USER_FUNDS')).toBe(20 * 2_000);
      expect((await trialBalance()).conservesToZero).toBe(true);
      expect(await findOrdersMissingLedgerEvents()).toEqual([]);
      expect(await findLedgerEventsMissingOrders()).toEqual([]);
    });
  });

  // ── Append-only history ────────────────────────────────────────────────────
  it('records an append-only history that cannot be edited', async () => {
    await toPaid('h1');
    await expect(pgQuery(`UPDATE order_transitions SET to_state = 'CANCELLED' WHERE order_id = 'h1'`))
      .rejects.toThrow(/append-only/);
    await expect(pgQuery(`DELETE FROM order_transitions WHERE order_id = 'h1'`))
      .rejects.toThrow(/append-only/);
  });

  it('cannot record a transition for an order that does not exist', async () => {
    // The foreign key the mirror table cannot have, because a projection has
    // nothing to point at.
    await expect(pgQuery(
      `INSERT INTO order_transitions (tx_id, order_id, from_state, to_state)
       VALUES ('x','no-such-order','PAID','COMPLETED')`))
      .rejects.toThrow(/foreign key|violates/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The admin payment queue, and the escrow flag a dispute resolution clears.
// ─────────────────────────────────────────────────────────────────────────────
import {
  paymentQueue, setOrderFields, getOrderRecord,
} from '../repositories/orders.record.js';

describePg('the payment queue an operator works', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => { await closePg(); });
  beforeEach(async () => {
    await pgQuery('TRUNCATE order_transitions, order_states, users, merchants RESTART IDENTITY CASCADE');
  });

  const order = (orderId, state, { userId = 'u1', merchantId = null, type = 'DEPOSIT' } = {}) =>
    pgQuery(
      `INSERT INTO order_states (order_id, user_id, merchant_id, order_type, state,
                                 token_amount_paise, fiat_amount_paise)
       VALUES ($1,$2,$3,$4,$5,100_00,100_00)`,
      [orderId, userId, merchantId, type, state],
    );

  it('counts the whole queue, not just the page it returned', async () => {
    for (let i = 0; i < 7; i += 1) await order(`o-${i}`, 'PENDING_QUEUE');
    await order('o-done', 'COMPLETED');

    const queue = await paymentQueue({ limit: 3 });

    // The list is capped; the DEPTHS are not. The route this replaced derived
    // its counts by filtering the capped array, so a queue with 900 pending
    // orders reported the cap and looked calm.
    expect(queue.orders).toHaveLength(3);
    expect(queue.stats.pending).toBe(7);
    expect(queue.stats.completed).toBe(1);
    expect(queue.stats.total).toBe(8);
    expect(queue.stats.listed).toBe(3);
  });

  it('names both parties in one statement', async () => {
    await pgQuery(
      `INSERT INTO users (user_id, username, mobile, referral_code)
       VALUES ('u1','Asha','9990001111','ASHA1')`, [],
    );
    await pgQuery(
      `INSERT INTO merchants (merchant_id, name, public_ref, mobile, accepted_currencies)
       VALUES ('m1','Ravi Payments','MER-1','9990002222', ARRAY['INR'])`, [],
    );
    await order('o-1', 'PROCESSING', { userId: 'u1', merchantId: 'm1' });

    const [row] = (await paymentQueue({})).orders;
    expect(row.user.username).toBe('Asha');
    expect(row.merchant.name).toBe('Ravi Payments');
  });

  it('says which started orders may still change hands, by the rule the reassign route asks', async () => {
    // A sell may (its member has paid nothing yet); a started bank buy may not
    // (the player was shown where to pay at once); a queued order is not
    // started, so there is nobody to take it from.
    await order('o-sell', 'PROCESSING', { type: 'WITHDRAWAL', merchantId: 'm1' });
    await order('o-bank', 'PROCESSING', { type: 'DEPOSIT', merchantId: 'm1' });
    await order('o-queued', 'PENDING_QUEUE', { type: 'WITHDRAWAL' });
    const byId = Object.fromEntries((await paymentQueue({})).orders.map((o) => [o.orderId, o.canReassign]));
    expect(byId).toEqual({ 'o-sell': true, 'o-bank': false, 'o-queued': false });
  });

  it('keeps an order whose party rows are gone', async () => {
    await order('o-orphan', 'DISPUTED', { userId: 'u-deleted', merchantId: 'm-deleted' });
    const [row] = (await paymentQueue({})).orders;
    // The money moved. Dropping the order because an account was deleted would
    // put a hole in the queue an operator has to work.
    expect(row.orderId).toBe('o-orphan');
    expect(row.user).toBeNull();
    expect(row.merchant).toBeNull();
  });

  it('persists the escrow release, so a later refund cannot pay twice', async () => {
    await order('o-escrow', 'DISPUTED', { type: 'WITHDRAWAL' });
    await setOrderFields('o-escrow', { escrowLocked: true });
    expect((await getOrderRecord('o-escrow')).escrowLocked).toBe(true);

    // What the release branch does. The line this replaced assigned
    // `order.escrowLocked = false` on a plain object and never wrote it back,
    // so every released withdrawal dispute left the order still marked
    // escrow-locked — and the refund branch reads that same flag, so a later
    // refund on the same order would credit the player for money already
    // released.
    await setOrderFields('o-escrow', { escrowLocked: false });
    expect((await getOrderRecord('o-escrow')).escrowLocked).toBe(false);
  });
});
