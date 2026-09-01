// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Stage 2 routing — which store owns an order transition, and what the seam is
 * told when it is not the one the caller expected.
 *
 * No database. These assert the DECISION: whether orderPg is called at all,
 * what the adapter reports back, whether the reverse mirror fires so Mongo stays
 * usable as a fallback, and — the one that matters most — that a Postgres
 * REFUSAL is surfaced rather than quietly retried against Mongo. The transitions
 * themselves are proven against a real PostgreSQL in tests/postgres/orderPg.test.js.
 *
 * ── Why the OFF position is tested first ────────────────────────────────────
 * This adapter spends its whole production life switched off: no flag is
 * flipped, `onPostgres()` is false, and every call must fall straight through
 * to the Mongo seam without touching Postgres. A bug there is not a migration
 * bug, it is a live-traffic bug on every payment order in the system.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const onPostgres = new Set();
vi.mock('../../postgres/moneyAuthority.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isPostgresAuthoritative: (path) => onPostgres.has(path) };
});

const orderPg = { transition: vi.fn(), openOrder: vi.fn(), getOrder: vi.fn() };
vi.mock('../../postgres/orderPg.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    transition: (...a) => orderPg.transition(...a),
    openOrder:  (...a) => orderPg.openOrder(...a),
    getOrder:   (...a) => orderPg.getOrder(...a),
  };
});

const reverse = { orderState: vi.fn() };
vi.mock('../../postgres/reverseMirror.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, reverseMirrorOrderState: (...a) => reverse.orderState(...a) };
});

const pg = { query: vi.fn() };
vi.mock('../../postgres/pgClient.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, pgQuery: (...a) => pg.query(...a) };
});

// The Mongo side. `mongoose.model('PaymentOrder')` is looked up at call time,
// so a plain stub is enough and no connection is needed.
const mongoDoc = { findById: vi.fn(), findOneAndUpdate: vi.fn() };
vi.mock('mongoose', () => ({
  default: { model: (name) => {
    if (name !== 'PaymentOrder') throw new Error(`unexpected model(${name})`);
    return mongoDoc;
  } },
}));

import { MONEY_PATHS } from '../../postgres/moneyAuthority.js';
import { ORDER_STATES } from '../../postgres/orderPg.js';
import { onPostgres as isOn, transitionOrderOnPostgres } from '../../postgres/orderPgAuthority.js';

/** A Mongo order document, as findById().select().lean() would return it. */
const ORDER_DOC = {
  _id: 'o1', orderId: 'DEP_1', userId: 'u1', merchantId: 'm1',
  type: 'DEPOSIT', tokenAmount: 500, fiatAmount: 500, status: 'PAID',
};

function mongoReturns(doc) {
  // Two shapes are used: .findById().select().lean() when opening the lifecycle
  // row, and .findById().lean() when reading the order back after the mirror.
  mongoDoc.findById.mockReturnValue({
    select: () => ({ lean: async () => doc }),
    lean: async () => doc,
  });
}

beforeEach(() => {
  onPostgres.clear();
  vi.clearAllMocks();
  mongoReturns(ORDER_DOC);
  orderPg.getOrder.mockResolvedValue({ orderId: 'o1', state: ORDER_STATES.PAID, merchantId: 'm1' });
  orderPg.openOrder.mockResolvedValue({ ok: true, idempotent: false });
  orderPg.transition.mockResolvedValue({
    ok: true, idempotent: false,
    order: { orderId: 'o1', state: ORDER_STATES.COMPLETED, merchantId: 'm1' },
    ledgerKey: 'acct_ord_o1_COMPLETED',
  });
  pg.query.mockResolvedValue({ rows: [{ n: 0 }] });
  reverse.orderState.mockResolvedValue(undefined);
});

describe('the ON position — Postgres owns the lifecycle', () => {
  beforeEach(() => { onPostgres.add(MONEY_PATHS.ORDERS); });

  it('transitions in Postgres and mirrors the result back to Mongo', async () => {
    const routed = await transitionOrderOnPostgres('o1', ORDER_STATES.COMPLETED, {
      set: { completedAt: new Date('2026-08-10') },
    });

    expect(orderPg.transition).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'o1', to: ORDER_STATES.COMPLETED,
    }));
    expect(routed).toMatchObject({
      handled: true, ok: true, idempotent: false,
      reason: 'applied', status: ORDER_STATES.COMPLETED,
    });
    expect(routed.order).toEqual(ORDER_DOC);
  });

  it('carries the transition fields into the mirror, not just the status', async () => {
    // A Mongo document found in the new state without the facts that justify it
    // is the window the seam's single-update rule closes. A reverse mirror that
    // wrote only the status would reopen it.
    const completedAt = new Date('2026-08-10');
    await transitionOrderOnPostgres('o1', ORDER_STATES.COMPLETED, { set: { completedAt } });

    expect(reverse.orderState).toHaveBeenCalledWith(
      expect.objectContaining({ order_id: 'o1', state: ORDER_STATES.COMPLETED }),
      expect.objectContaining({ completedAt }),
    );
  });

  it('AWAITS the mirror before returning', async () => {
    // The caller is about to move money and then read order.status back. A
    // fire-and-forget mirror would let it act on the previous state.
    let settled = false;
    reverse.orderState.mockImplementation(() => new Promise((r) => setTimeout(() => { settled = true; r(); }, 20)));
    await transitionOrderOnPostgres('o1', ORDER_STATES.COMPLETED, {});
    expect(settled).toBe(true);
  });

  it('SURFACES a refusal and does not write Mongo', async () => {
    // The property this whole file exists for. Falling back to Mongo when
    // Postgres refuses would mean the store that owns the lifecycle is overruled
    // by the store that has no opinion: the order advances, the source of truth
    // says it never did, and reconciliation reports drift that is really a bug
    // in the adapter.
    orderPg.transition.mockResolvedValue({
      ok: false, reason: 'invalid_transition',
      state: ORDER_STATES.CANCELLED, allowedFrom: [ORDER_STATES.PAID, ORDER_STATES.PROCESSING],
    });

    const routed = await transitionOrderOnPostgres('o1', ORDER_STATES.COMPLETED, {});
    expect(routed).toMatchObject({
      handled: true, ok: false,
      reason: 'illegal_transition', status: ORDER_STATES.CANCELLED,
    });
    // Not handed back to the seam, and Mongo untouched.
    expect(routed.handled).toBe(true);
    expect(reverse.orderState).not.toHaveBeenCalled();
  });

  it('reports an already-there transition as idempotent, not as a failure', async () => {
    orderPg.transition.mockResolvedValue({
      ok: true, idempotent: true, order: { orderId: 'o1', state: ORDER_STATES.COMPLETED },
    });
    const routed = await transitionOrderOnPostgres('o1', ORDER_STATES.COMPLETED, {});
    expect(routed).toMatchObject({ ok: true, idempotent: true, reason: 'already_there' });
    // Mongo is still refreshed: a redelivered callback finding Postgres already
    // moved is exactly when Mongo is most likely to be the one lagging.
    expect(reverse.orderState).toHaveBeenCalled();
  });
});

describe('the lifecycle row is opened lazily', () => {
  beforeEach(() => { onPostgres.add(MONEY_PATHS.ORDERS); });

  it('opens order_states from the Mongo document when it does not exist yet', async () => {
    // dualWrite mirrors payment_orders — the PROJECTION — not order_states, the
    // lifecycle. An order created before the flip has no lifecycle row, and its
    // first transition would come back not_found and surface to the user as a
    // missing order.
    orderPg.getOrder.mockResolvedValue(null);

    await transitionOrderOnPostgres('o1', ORDER_STATES.COMPLETED, {});

    expect(orderPg.openOrder).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'o1', userId: 'u1', type: 'DEPOSIT',
      tokenAmountPaise: 50000, fiatAmountPaise: 50000,   // rupees → paise
    }));
    expect(orderPg.transition).toHaveBeenCalled();
  });

  it('adopts an in-flight order AT ITS CURRENT STATUS, not at the start', async () => {
    // REGRESSION, and the one that would have broken a cutover outright. An
    // order sitting at PAID adopted as PENDING_QUEUE has its next transition
    // refused — the merchant's confirm asks for COMPLETED, which accepts
    // PAID/PROCESSING/DISPUTED — so every order in flight at the moment of the
    // flip would strand with the money unmoved.
    orderPg.getOrder.mockResolvedValue(null);
    mongoReturns({ ...ORDER_DOC, status: ORDER_STATES.PAID });

    await transitionOrderOnPostgres('o1', ORDER_STATES.COMPLETED, {});

    expect(orderPg.openOrder).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'o1', state: ORDER_STATES.PAID }));
  });

  it('carries whatever status the order is in, not just PAID', async () => {
    for (const status of [ORDER_STATES.ASSIGNED, ORDER_STATES.PROCESSING, ORDER_STATES.DISPUTED]) {
      vi.clearAllMocks();
      orderPg.getOrder.mockResolvedValue(null);
      orderPg.openOrder.mockResolvedValue({ ok: true, idempotent: false });
      mongoReturns({ ...ORDER_DOC, status });

      await transitionOrderOnPostgres('o1', ORDER_STATES.COMPLETED, {});
      expect(orderPg.openOrder).toHaveBeenCalledWith(expect.objectContaining({ state: status }));
    }
  });

  it('does not re-open a row that already exists', async () => {
    await transitionOrderOnPostgres('o1', ORDER_STATES.COMPLETED, {});
    expect(orderPg.openOrder).not.toHaveBeenCalled();
  });

  it('reports not_found when Mongo has no such order either', async () => {
    orderPg.getOrder.mockResolvedValue(null);
    mongoReturns(null);

    const routed = await transitionOrderOnPostgres('missing', ORDER_STATES.COMPLETED, {});
    expect(routed).toMatchObject({ handled: true, ok: false, reason: 'not_found' });
    expect(orderPg.openOrder).not.toHaveBeenCalled();
    expect(orderPg.transition).not.toHaveBeenCalled();
  });
});

describe('the seam is the only thing that routes', () => {
  beforeEach(() => { onPostgres.add(MONEY_PATHS.ORDERS); });

  it('sends a transition through Postgres when the path has moved', async () => {
    const { completeOrder } = await import('../../domains/payment/orderLifecycle.service.js');
    const done = await completeOrder('o1', { set: { completedAt: new Date() } });

    expect(orderPg.transition).toHaveBeenCalledWith(expect.objectContaining({ to: ORDER_STATES.COMPLETED }));
    expect(done).toMatchObject({ ok: true, status: ORDER_STATES.COMPLETED });
    // `handled` is the adapter's private instruction to the seam and must not
    // leak to route handlers, which branch on ok/idempotent.
    expect(done).not.toHaveProperty('handled');
    // The Mongo guarded update is NOT also run — that would be two writes for
    // one transition, the second unguarded against the first.
    expect(mongoDoc.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('keeps a caller inside a mongoose session on Mongo', async () => {
    // A Postgres transaction cannot join a Mongo session. The two call sites
    // that pass one move merchant AND user balances inside it, so routing the
    // order out of that session would split one settlement across two stores —
    // the hazard the ordering gate exists to prevent. ORDERS cannot be
    // authoritative until WALLET and LEDGER are, which the dependency graph
    // already enforces; until then this branch is unreachable in production and
    // is here so it stays correct if that ever changes.
    const { completeOrder } = await import('../../domains/payment/orderLifecycle.service.js');
    const fakeSession = { id: 'sess' };
    mongoDoc.findOneAndUpdate.mockReturnValue({
      session: () => ({ lean: async () => ({ _id: 'o1', status: ORDER_STATES.COMPLETED }) }),
      lean: async () => ({ _id: 'o1', status: ORDER_STATES.COMPLETED }),
    });

    await completeOrder('o1', { session: fakeSession, set: {} });

    expect(orderPg.transition).not.toHaveBeenCalled();
    expect(mongoDoc.findOneAndUpdate).toHaveBeenCalled();
  });
});

describe('keys for the transitions that can repeat', () => {
  beforeEach(() => { onPostgres.add(MONEY_PATHS.ORDERS); });

  it('passes the caller key straight through when there is one', async () => {
    await transitionOrderOnPostgres('o1', ORDER_STATES.ASSIGNED, { txId: 'from-the-route' });
    expect(orderPg.transition).toHaveBeenCalledWith(expect.objectContaining({ txId: 'from-the-route' }));
  });

  it('leaves a non-repeatable target on the default key', async () => {
    // PAID is reachable once, so ord_<order>_PAID cannot collide and asking the
    // database how many times it has been visited would be a wasted round trip.
    await transitionOrderOnPostgres('o1', ORDER_STATES.PAID, {});
    expect(pg.query).not.toHaveBeenCalled();
    expect(orderPg.transition).toHaveBeenCalledWith(expect.objectContaining({ txId: null }));
  });

  it('leaves a FIRST visit to a repeatable target on the default key', async () => {
    pg.query.mockResolvedValue({ rows: [{ n: 0 }] });
    await transitionOrderOnPostgres('o1', ORDER_STATES.ASSIGNED, {});
    expect(orderPg.transition).toHaveBeenCalledWith(expect.objectContaining({ txId: null }));
  });

  it('names the occurrence on a REPEAT visit, so the move is applied', async () => {
    // Without this the second assignment of a rejected order collides with the
    // first on ord_<order>_ASSIGNED and is reported as an idempotent replay —
    // the order silently stays in PENDING_QUEUE holding the old merchant.
    pg.query.mockResolvedValue({ rows: [{ n: 1 }] });
    await transitionOrderOnPostgres('o1', ORDER_STATES.ASSIGNED, {});
    expect(orderPg.transition).toHaveBeenCalledWith(expect.objectContaining({ txId: 'ord_o1_ASSIGNED_v2' }));
  });
});
