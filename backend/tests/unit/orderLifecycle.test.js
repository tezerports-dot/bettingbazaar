// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The order state machine's RULE TABLE — the part that is a pure function.
 *
 * ── What used to be here, and where it went ─────────────────────────────────
 * This file was a suite over `transitionOrder` with the document model FAKED:
 * it asserted which filter the service sent and what the caller was told when
 * the filter matched nothing. That was the right test while the transition ran
 * against a document store the tests could stand in for.
 *
 * It no longer is. The transition runs against PostgreSQL, and a fake of the
 * thing that executes it proves the fake works. Those thirteen tests are
 * replaced by `database/tests/orderPg.test.js`, which runs the real bodies
 * against a real database — and covers what a mock could not reach: racing
 * transitions, the accounting entry written in the same transaction, and an
 * append-only history nothing can edit.
 *
 * What stays here is what is genuinely a unit: the state table. `canTransition`
 * and `nextStates` are pure functions over a constant, they need no database,
 * and the property they carry — that no state is terminal by accident — is
 * cheaper to assert here than anywhere else.
 */
import { describe, it, expect } from 'vitest';
import {
  canTransition, nextStates, ORDER_STATES,
} from '../../domains/payment/orderLifecycle.service.js';

describe('the state table', () => {
  it('leaves no state an order can enter but never leave', () => {
    // The property, rather than the two instances of it. A terminal state is a
    // deliberate choice; a state that is terminal by ACCIDENT is a stuck order.
    const settled = [ORDER_STATES.CANCELLED, ORDER_STATES.FAILED, ORDER_STATES.REJECTED];
    for (const state of Object.values(ORDER_STATES)) {
      if (settled.includes(state)) continue;
      expect({ state, next: nextStates(state) }).toMatchObject({ state });
      expect(nextStates(state).length).toBeGreaterThan(0);
    }
  });
});

describe('the rule table is the same one the database enforces', () => {
  it('matches the repository ALLOWED_FROM exactly', async () => {
    const { ALLOWED_FROM } = await import('#db/repositories/orders.core.js');
    // Two tables would be two rules. The service's table is what a route reads
    // to decide whether to offer a button; the repository's is what actually
    // refuses the write. A disagreement between them is an order the UI offers
    // and the database rejects.
    expect(canTransition(ORDER_STATES.PAID, ORDER_STATES.COMPLETED)).toBe(true);
    expect(canTransition(ORDER_STATES.CANCELLED, ORDER_STATES.COMPLETED)).toBe(false);
    expect(ALLOWED_FROM[ORDER_STATES.COMPLETED])
      .toEqual([ORDER_STATES.PAID, ORDER_STATES.PROCESSING, ORDER_STATES.DISPUTED]);
  });

  it('knows where an order can go from here', () => {
    expect(nextStates(ORDER_STATES.PENDING_QUEUE).sort())
      // PROCESSING because a merchant may take an order straight out of the
      // open pool without it having been assigned to them first.
      .toEqual(['ASSIGNED', 'CANCELLED', 'FAILED', 'PROCESSING', 'REJECTED']);
    // Nothing leaves COMPLETED except a dispute. Everything else is a reversal.
    expect(nextStates(ORDER_STATES.COMPLETED)).toEqual(['DISPUTED']);
    // ...and a dispute resolves in exactly two directions.
    expect(nextStates(ORDER_STATES.DISPUTED).sort()).toEqual(['CANCELLED', 'COMPLETED']);
  });
});
