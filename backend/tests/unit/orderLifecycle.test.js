// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The order state machine on the Mongo side — the guard that did not exist.
 *
 * Before orderLifecycle.service.js, `PaymentOrder.status` was a string assigned
 * directly from 31 places, none of which checked the state the order was
 * actually in. The tests below are the rules that were previously enforced only
 * by the order in which route handlers happened to run.
 *
 * `PaymentOrder` is faked so these run with no database. What is under test is
 * the DECISION — which filter goes to Mongo, and what the caller is told when
 * it matches nothing — and that is fully determined by this module.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  transitionOrder, completeOrder, cancelOrder, assignOrder, markOrderPaid,
  canTransition, nextStates, ORDER_STATES, LIFECYCLE,
} from '../../domains/payment/orderLifecycle.service.js';

/** The filter the service sent, so the guard itself can be asserted. */
let lastFilter;
/** What the fake database "contains". Null update result = filter matched nothing. */
let updateResult;
let storedStatus;

beforeEach(() => {
  lastFilter = null;
  updateResult = null;
  storedStatus = ORDER_STATES.PENDING_QUEUE;

  const fake = {
    findOneAndUpdate: (filter, update) => {
      lastFilter = filter;
      const p = Promise.resolve(updateResult);
      p.lean = () => Promise.resolve(updateResult);
      p.session = () => p;
      return p;
    },
    findById: () => ({
      select: () => ({ lean: () => Promise.resolve(storedStatus ? { status: storedStatus } : null) }),
    }),
  };
  vi.spyOn(mongoose, 'model').mockImplementation((name) => {
    if (name === 'PaymentOrder') return fake;
    throw new Error(`unexpected model(${name})`);
  });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the guard goes into the query, not a pre-read', () => {
  it('filters on the states the transition is allowed from', async () => {
    updateResult = { _id: 'o1', status: ORDER_STATES.COMPLETED };
    await completeOrder('o1');

    // If this ever becomes `{ _id }` alone, the state machine is gone and every
    // test below passes anyway — which is why the filter itself is asserted.
    expect(lastFilter).toEqual({
      _id: 'o1',
      status: { $in: [ORDER_STATES.PAID, ORDER_STATES.PROCESSING] },
    });
  });

  it('writes the transition fields in the same update as the status', async () => {
    updateResult = { _id: 'o1', status: ORDER_STATES.ASSIGNED };
    const r = await assignOrder('o1', { set: { merchantId: 'm1' } });
    // An order must never be findable in the new state without the facts that
    // justify it — a separate write would leave exactly that window.
    expect(r.ok).toBe(true);
    expect(lastFilter.status.$in).toEqual([ORDER_STATES.PENDING_QUEUE]);
  });
});

describe('the illegal transitions that used to succeed', () => {
  it('refuses to complete a cancelled order', async () => {
    updateResult = null;                     // filter matched nothing
    storedStatus = ORDER_STATES.CANCELLED;

    const r = await completeOrder('o1');
    // THE bug. Before this module, `updateOne({_id}, {status:'COMPLETED'})`
    // did exactly this and nothing stopped it.
    expect(r).toMatchObject({
      ok: false, reason: LIFECYCLE.ILLEGAL_TRANSITION,
      status: ORDER_STATES.CANCELLED, attempted: ORDER_STATES.COMPLETED,
    });
  });

  it('refuses to pay a failed order', async () => {
    updateResult = null;
    storedStatus = ORDER_STATES.FAILED;
    expect(await markOrderPaid('o1')).toMatchObject({ ok: false, reason: LIFECYCLE.ILLEGAL_TRANSITION });
  });

  it('refuses to cancel an order that already completed', async () => {
    updateResult = null;
    storedStatus = ORDER_STATES.COMPLETED;
    // Undoing settled value is a reversal, which belongs to the settlement
    // domain — not a status flip that leaves the money where it landed.
    expect(await cancelOrder('o1')).toMatchObject({ ok: false, reason: LIFECYCLE.ILLEGAL_TRANSITION });
  });
});

describe('outcomes a caller must be able to tell apart', () => {
  it('reports a redelivered callback as idempotent, not as an error', async () => {
    updateResult = null;
    storedStatus = ORDER_STATES.COMPLETED;

    const r = await completeOrder('o1');
    // Providers retry. Treating "already where you wanted to be" as a failure
    // turns ordinary behaviour into a page.
    expect(r).toMatchObject({ ok: true, idempotent: true, reason: LIFECYCLE.ALREADY_THERE });
  });

  it('reports a missing order as not_found rather than illegal', async () => {
    updateResult = null;
    storedStatus = null;
    expect(await completeOrder('nope')).toMatchObject({ ok: false, reason: LIFECYCLE.NOT_FOUND });
  });

  it('reports a successful move as applied', async () => {
    updateResult = { _id: 'o1', status: ORDER_STATES.COMPLETED };
    expect(await completeOrder('o1')).toMatchObject({
      ok: true, idempotent: false, reason: LIFECYCLE.APPLIED,
    });
  });
});

describe('expectFrom narrows, and can never widen', () => {
  it('lets a caller demand a specific previous state', async () => {
    updateResult = { _id: 'o1', status: ORDER_STATES.COMPLETED };
    await completeOrder('o1', { expectFrom: ORDER_STATES.PAID });
    expect(lastFilter.status.$in).toEqual([ORDER_STATES.PAID]);
  });

  it('throws when asked to allow a state the rules do not', async () => {
    // Quietly widening the machine for one caller is how a state machine stops
    // being one. This is a programming error and is treated as such.
    await expect(completeOrder('o1', { expectFrom: ORDER_STATES.CANCELLED }))
      .rejects.toThrow(/not allowed into COMPLETED/);
  });

  it('throws on a state nothing transitions into', async () => {
    await expect(transitionOrder('o1', 'PENDING_QUEUE'))
      .rejects.toThrow(/not a state anything transitions into/);
  });
});

describe('the rule table is shared with Postgres, not copied', () => {
  it('matches orderPg ALLOWED_FROM exactly', async () => {
    const { ALLOWED_FROM } = await import('../../postgres/orderPg.js');
    // Two tables would be two rules, and a transition Postgres refuses while
    // Mongo permits is a disagreement no reconciliation can tell apart from
    // real drift. This asserts there is only one.
    expect(canTransition(ORDER_STATES.PAID, ORDER_STATES.COMPLETED)).toBe(true);
    expect(canTransition(ORDER_STATES.CANCELLED, ORDER_STATES.COMPLETED)).toBe(false);
    expect(ALLOWED_FROM[ORDER_STATES.COMPLETED]).toEqual([ORDER_STATES.PAID, ORDER_STATES.PROCESSING]);
  });

  it('knows where an order can go from here', () => {
    expect(nextStates(ORDER_STATES.PENDING_QUEUE).sort())
      .toEqual(['ASSIGNED', 'CANCELLED', 'FAILED', 'REJECTED']);
    // Nothing leaves COMPLETED except a dispute. Everything else is a reversal.
    expect(nextStates(ORDER_STATES.COMPLETED)).toEqual(['DISPUTED']);
  });
});
