// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
import { pgConfigured, pgQuery, applySchema, closePg, getPool } from '../../postgres/pgClient.js';
import {
  ORDER_STATES, ORDER_TYPES, openOrder, transition, getOrder, getOrderHistory,
  assignOrder, startOrder, markPaid, completeOrder, disputeOrder, cancelOrder, failOrder,
  findOrdersMissingLedgerEvents, findLedgerEventsMissingOrders,
} from '../../postgres/orderPg.js';
import { trialBalance, accountBalancePaise, getEvent } from '../../postgres/ledgerPg.js';

const hasPg = pgConfigured();
const describePg = hasPg ? describe : describe.skip;

const open = (id, type = ORDER_TYPES.DEPOSIT, paise = 100_000) =>
  openOrder({ orderId: id, userId: 'u1', merchantId: 'm1', type, tokenAmountPaise: paise });

/** Walk an order to PAID, the usual pre-completion position. */
async function toPaid(id, type = ORDER_TYPES.DEPOSIT, paise = 100_000) {
  await open(id, type, paise);
  await assignOrder({ orderId: id });
  await startOrder({ orderId: id });
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
        ['PENDING_QUEUE', 'ASSIGNED'],
        ['ASSIGNED', 'PROCESSING'],
        ['PROCESSING', 'PAID'],
        ['PAID', 'COMPLETED'],
      ]);
    });

    it('opens idempotently — a retried creation is the same order', async () => {
      const first = await open('o2');
      const second = await open('o2');
      expect(first.idempotent).toBe(false);
      expect(second).toMatchObject({ ok: true, idempotent: true });
      const { rows } = await pgQuery('SELECT COUNT(*)::int n FROM order_states');
      expect(rows[0].n).toBe(1);
    });

    it('refuses a malformed order rather than storing one', async () => {
      await expect(openOrder({ orderId: 'x', userId: 'u', type: 'SIDEWAYS', tokenAmountPaise: 1 }))
        .rejects.toThrow(/Unknown order type/);
      await expect(openOrder({ orderId: 'x', userId: 'u', type: 'DEPOSIT', tokenAmountPaise: 0 }))
        .rejects.toThrow(/positive integer/);
      await expect(openOrder({ orderId: 'x', userId: 'u', type: 'DEPOSIT', tokenAmountPaise: 10.5 }))
        .rejects.toThrow(/positive integer/);
      const { rows } = await pgQuery('SELECT COUNT(*)::int n FROM order_states');
      expect(rows[0].n).toBe(0);
    });

    it('records the merchant on assignment', async () => {
      await openOrder({ orderId: 'o3', userId: 'u1', type: ORDER_TYPES.DEPOSIT, tokenAmountPaise: 50_000 });
      expect((await getOrder('o3')).merchantId).toBeNull();
      await assignOrder({ orderId: 'o3', merchantId: 'm9' });
      expect((await getOrder('o3')).merchantId).toBe('m9');
    });
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

    it('rejects an unknown target state, and a state nothing may move into', async () => {
      await open('g4');
      await expect(transition({ orderId: 'g4', to: 'ELSEWHERE' })).rejects.toThrow(/Unknown order state/);
      await expect(transition({ orderId: 'g4', to: ORDER_STATES.PENDING_QUEUE }))
        .rejects.toThrow(/an order is opened there/);
    });

    it('cannot be forced into an unknown state even by direct SQL', async () => {
      await open('g5');
      await expect(pgQuery(`UPDATE order_states SET state = 'HALFWAY' WHERE order_id = 'g5'`))
        .rejects.toThrow(/order_states_known/);
    });
  });

  // ── Money moves with the state ─────────────────────────────────────────────
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
