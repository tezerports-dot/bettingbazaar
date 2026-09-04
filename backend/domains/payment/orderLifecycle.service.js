// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/payment/orderLifecycle.service.js — the one place an order changes state.
 *
 * ── The bug this closes ─────────────────────────────────────────────────────
 * An order's status is a plain string, and before this file 31 places across 8
 * files assigned it directly. None of them checked what state the order was
 * actually in, so there was NO state machine — only an ordering of checks in
 * the routes that happened to prevent most illegal moves. Ordering is not an
 * invariant. A cancelled order could be completed. An expired one could be paid.
 *
 * ── The guard is in the query, never in a pre-read ──────────────────────────
 * The expected previous state goes in the WHERE clause, alongside a row lock:
 *
 *     UPDATE order_states SET status = $2
 *      WHERE order_id = $1 AND status = ANY(ALLOWED_FROM[to])
 *
 * so two concurrent callers racing the same transition both hit the database
 * and exactly one matches a row. Reading the status first and then updating
 * would leave a window between them, which on a payment callback is not
 * theoretical — providers retry, and they retry concurrently.
 *
 * A null result therefore means one of two things, and the caller usually wants
 * to treat them the same way: the transition was illegal, or someone else won
 * the race. `describe()` separates them for callers that need to know, by
 * re-reading AFTER the fact — which is safe precisely because it is not the
 * gate.
 *
 * ── One rule table ──────────────────────────────────────────────────────────
 * ALLOWED_FROM is imported from the orders repository rather than restated
 * here. Two copies would be two rules the moment either changed, and the copy
 * that was not updated is the one that lets an illegal transition through.
 *
 * ── What this deliberately does NOT do ──────────────────────────────────────
 * It does not move money, post ledger events, or credit wallets. Those live in
 * the services that call it, and pulling them in here would make every
 * state-machine change a money change. The repository underneath DOES bind the
 * state and its accounting event into one transaction, which is what makes a
 * transition that moves money atomic with the money it moves.
 */
import { ORDER_STATES, ALLOWED_FROM } from '#db/repositories/orders.core.js';
import { transitionOrder as pgTransitionOrder, reassignOrder as pgReassignOrder } from '#db/repositories/orders.js';

export { ORDER_STATES };

/** Outcome reasons, so callers branch on a value rather than parsing a string. */
export const LIFECYCLE = Object.freeze({
  APPLIED:            'applied',
  ILLEGAL_TRANSITION: 'illegal_transition',
  ALREADY_THERE:      'already_there',
  NOT_FOUND:          'not_found',
});

/**
 * Move an order to `to`, but only from a state the rules allow.
 *
 * `set` carries the fields that belong WITH the transition — a merchant id on
 * assignment, a UTR on payment, a reason on cancellation. They are written in
 * the same update as the status, so an order can never be found in the new
 * state without the facts that justify it.
 *
 * `expectFrom` narrows the allowed set further for a caller that knows more
 * than the rule table does. It can only ever be a SUBSET: passing a state the
 * table does not allow is a programming error and throws, rather than quietly
 * widening the machine.
 */
export async function transitionOrder(orderId, to, { set = {}, expectFrom = null, actor = null, reason = null, txId = null } = {}) {
  const allowed = ALLOWED_FROM[to];
  if (!allowed) throw new Error(`transitionOrder: '${to}' is not a state anything transitions into`);

  // `expectFrom` narrows the allowed set for a caller that knows more than the
  // rule table does. It may only ever be a SUBSET: passing a state the table
  // does not allow is a programming error and throws, rather than quietly
  // widening the machine. Validated HERE, before the call, because the
  // repository deliberately ignores it — the row lock and ALLOWED_FROM are the
  // real guard, and a narrowing that the table already forbids is a bug in the
  // caller, not a rule to enforce twice.
  if (expectFrom) {
    const wanted = Array.isArray(expectFrom) ? expectFrom : [expectFrom];
    const illegal = wanted.filter((state) => !allowed.includes(state));
    if (illegal.length) {
      throw new Error(
        `transitionOrder: expectFrom ${illegal.join(',')} is not allowed into ${to} ` +
        `(allowed: ${allowed.join(',')}). Widen ALLOWED_FROM in orders.core.js if this is intended.`,
      );
    }
  }

  // ── One path ──────────────────────────────────────────────────────────────
  // This asked a resolver and, when it declined, ran a second implementation
  // against the document store — including a `describe()` that re-read the
  // document to explain a refusal. The transition happens inside a transaction
  // with its accounting event, guarded by the row lock, recorded in append-only
  // history, and it explains its own refusals.
  //
  // The `session` parameter is gone with it. It existed so a caller inside a
  // document-store transaction could stay on that store; a transaction spanning
  // two stores was the hazard the whole migration exists to remove, and no
  // caller passes one.
  return pgTransitionOrder(orderId, to, { set, expectFrom, actor, reason, txId });
}

// ── Named transitions ────────────────────────────────────────────────────────
// One per legal move, so a call site reads as the thing it means rather than as
// a string literal that could be typed wrong.

export const assignOrder    = (id, o) => transitionOrder(id, ORDER_STATES.ASSIGNED, o);
/**
 * Back to the queue, because the assigned merchant declined.
 *
 * The one transition that moves an order BACKWARDS, and the reason
 * PENDING_QUEUE had to become a state the rule table can enter. The guard is
 * the same `status = ANY(ALLOWED_FROM)` clause every other transition uses;
 * what it cost was making the lifecycle CYCLIC, which is a larger story:
 * docs/ORDERS_REQUEUE_CYCLE.md.
 */
export const requeueOrder   = (id, o) => transitionOrder(id, ORDER_STATES.PENDING_QUEUE, o);
export const startOrder     = (id, o) => transitionOrder(id, ORDER_STATES.PROCESSING, o);
export const markOrderPaid  = (id, o) => transitionOrder(id, ORDER_STATES.PAID, o);
export const completeOrder  = (id, o) => transitionOrder(id, ORDER_STATES.COMPLETED, o);
export const disputeOrder   = (id, o) => transitionOrder(id, ORDER_STATES.DISPUTED, o);
export const cancelOrder    = (id, o) => transitionOrder(id, ORDER_STATES.CANCELLED, o);
export const failOrder      = (id, o) => transitionOrder(id, ORDER_STATES.FAILED, o);
export const rejectOrder    = (id, o) => transitionOrder(id, ORDER_STATES.REJECTED, o);

/**
 * Hand a LIVE order to a different merchant.
 *
 * ── Why this is not transitionOrder ─────────────────────────────────────────
 * Admin reassignment (merchant.assignment.routes.js) accepts an order that is
 * ASSIGNED *or* PROCESSING and leaves it ASSIGNED to someone else. Neither is a
 * lifecycle move: ASSIGNED→ASSIGNED does not change the state at all, and the
 * rule table only admits ASSIGNED from PENDING_QUEUE, so `expectFrom` cannot
 * express it either — it may only ever NARROW what ALLOWED_FROM already permits.
 *
 * Forcing it through the state machine would mean widening ALLOWED_FROM to
 * accept ASSIGNED from ASSIGNED and PROCESSING, which would also let the
 * ordinary assignment path silently re-assign an order already being worked on.
 * Splitting it into requeue-then-assign is worse: between the two writes the
 * order sits in PENDING_QUEUE with no session around them, where the automatic
 * assigner can and will pick it up and hand it to a third merchant.
 *
 * So this is what it actually is — a guarded change of assignee that happens to
 * normalise the state — and it still gets the property that matters: the
 * expected states are in the FILTER, so two admins reassigning the same order
 * at once produce one winner rather than a last-write-wins overwrite.
 *
 * Stage 2 must model this explicitly on the Postgres side; `order_states`
 * carries merchant_id, so it is a column update plus a recorded transition, not
 * a state change. See docs/ORDERS_REQUEUE_CYCLE.md for the neighbouring
 * decision about keys on repeatable edges.
 */
export async function reassignOrder(orderId, { set = {}, from = [ORDER_STATES.ASSIGNED, ORDER_STATES.PROCESSING], actor = null, reason = null } = {}) {
  return pgReassignOrder(orderId, { set, from, actor, reason });
}

/**
 * Is this move legal from where the order stands right now?
 *
 * For callers that must decide something BEFORE attempting the transition —
 * whether to show a button, whether to take a lock. It is not a substitute for
 * the guard: by the time the caller acts the answer may be stale, which is
 * exactly why the real check lives in the update's filter.
 */
export function canTransition(fromState, to) {
  return Boolean(ALLOWED_FROM[to]?.includes(fromState));
}

/** The states an order can legally reach from here. */
export function nextStates(fromState) {
  return Object.keys(ALLOWED_FROM).filter((to) => ALLOWED_FROM[to].includes(fromState));
}
