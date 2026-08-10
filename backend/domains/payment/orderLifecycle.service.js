// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/payment/orderLifecycle.service.js — the one place an order changes state.
 *
 * ── The bug this closes ─────────────────────────────────────────────────────
 * `PaymentOrder.status` is a plain string, and before this file 31 places
 * across 8 files assigned it directly. None of them checked what state the
 * order was actually in, which means the Mongo path had NO state machine — only
 * an ordering of checks in the routes that happened to prevent most illegal
 * moves. Ordering is not an invariant. A cancelled order could be completed. An
 * expired one could be paid.
 *
 * Postgres has refused those since orderPg.js was written; Mongo could not,
 * because there was nothing to refuse them WITH. This is that missing piece,
 * and it is worth having whether or not the migration ever finishes.
 *
 * ── The guard is in the query, never in a pre-read ──────────────────────────
 * The expected previous state goes in the FILTER:
 *
 *     findOneAndUpdate({ _id, status: { $in: ALLOWED_FROM[to] } }, …)
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
 * ── One rule table, shared with Postgres ────────────────────────────────────
 * ALLOWED_FROM is imported from postgres/orderPg.js rather than restated here.
 * Two copies would be two rules the moment either changed, and a transition
 * Postgres refuses while Mongo permits is a disagreement no reconciliation can
 * tell apart from genuine drift.
 *
 * ── What this deliberately does NOT do ──────────────────────────────────────
 * It does not move money, post ledger events, or credit wallets. Those already
 * live in the services that call it, and pulling them in here would make a
 * state-machine change a money change. The Postgres path DOES bind the state
 * and its accounting event into one transaction — that is one of the reasons to
 * migrate — but replicating that on the Mongo side would mean rewriting every
 * caller, which is a different job from giving them a guard.
 */
import mongoose from 'mongoose';
import { ORDER_STATES, ALLOWED_FROM } from '../../postgres/orderPg.js';
// Stage 2. This is the ONLY file that may import it — see the header there.
import { transitionOrderOnPostgres as routeTransition } from '../../postgres/orderPgAuthority.js';

export { ORDER_STATES };

/** Outcome reasons, so callers branch on a value rather than parsing a string. */
export const LIFECYCLE = Object.freeze({
  APPLIED:            'applied',
  ILLEGAL_TRANSITION: 'illegal_transition',
  ALREADY_THERE:      'already_there',
  NOT_FOUND:          'not_found',
});

const PaymentOrder = () => mongoose.model('PaymentOrder');

/**
 * Why did a transition match no row? Called only AFTER the guarded update has
 * already failed, so it can never become the gate itself.
 */
async function describe(orderId, to) {
  const current = await PaymentOrder().findById(orderId).select('status').lean();
  if (!current) return { ok: false, reason: LIFECYCLE.NOT_FOUND };
  // Landing where you wanted to go is not a failure. A redelivered callback
  // finds the order already COMPLETED, and treating that as an error turns
  // ordinary provider behaviour into a page at 3am.
  if (current.status === to) {
    return { ok: true, idempotent: true, reason: LIFECYCLE.ALREADY_THERE, status: to };
  }
  return {
    ok: false, reason: LIFECYCLE.ILLEGAL_TRANSITION,
    status: current.status, attempted: to, allowedFrom: ALLOWED_FROM[to] ?? [],
  };
}

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
export async function transitionOrder(orderId, to, { set = {}, expectFrom = null, session = null, actor = null, reason = null, txId = null } = {}) {
  const allowed = ALLOWED_FROM[to];
  if (!allowed) throw new Error(`transitionOrder: '${to}' is not a state anything transitions into`);

  // ── Stage 2: the resolver, asked ONCE ────────────────────────────────────
  // This is the whole reason stage 1 replaced 31 scattered status writes with
  // one service. When Postgres owns the ORDERS path the transition happens
  // there — inside a transaction with its accounting event, guarded by the row
  // lock, recorded in append-only history — and Mongo is updated afterwards as
  // the mirror everything else reads.
  //
  // A refusal from Postgres comes back as a refusal. It is NOT retried against
  // Mongo: the store that owns the lifecycle saying no, overruled by the store
  // that has no opinion, is worse than either alone.
  //
  // The Postgres path cannot join a Mongo session, so a caller inside a
  // transaction stays on Mongo. That is not a gap to close later — a
  // transaction spanning two stores is the "one settlement, two sources of
  // truth" hazard the ordering gate in moneyAuthority.js exists to prevent, and
  // the two call sites that pass a session (payment.routes deposit confirm,
  // merchant.routes approve) both move merchant AND user balances inside it.
  // ORDERS cannot be authoritative until those balances are too, which the
  // dependency graph already enforces: ORDERS depends on WALLET and LEDGER.
  if (!session) {
    const routed = await routeTransition(orderId, to, { set, expectFrom, actor, reason, txId });
    if (routed.handled) {
      const { handled, ...answer } = routed;
      return answer;
    }
  }

  let from = allowed;
  if (expectFrom) {
    const wanted = Array.isArray(expectFrom) ? expectFrom : [expectFrom];
    const illegal = wanted.filter((s) => !allowed.includes(s));
    if (illegal.length) {
      throw new Error(
        `transitionOrder: expectFrom ${illegal.join(',')} is not allowed into ${to} ` +
        `(allowed: ${allowed.join(',')}). Widen ALLOWED_FROM in postgres/orderPg.js if this is intended.`,
      );
    }
    from = wanted;
  }

  const q = PaymentOrder().findOneAndUpdate(
    { _id: orderId, status: { $in: from } },
    { $set: { status: to, ...set } },
    { new: true },
  );
  if (session) q.session(session);
  const updated = await q.lean();

  if (updated) return { ok: true, idempotent: false, reason: LIFECYCLE.APPLIED, status: to, order: updated };
  return describe(orderId, to);
}

// ── Named transitions ────────────────────────────────────────────────────────
// One per legal move, so a call site reads as the thing it means rather than as
// a string literal that could be typed wrong.

export const assignOrder    = (id, o) => transitionOrder(id, ORDER_STATES.ASSIGNED, o);
/**
 * Back to the queue, because the assigned merchant declined.
 *
 * The one transition that moves an order BACKWARDS, and the reason
 * PENDING_QUEUE had to become a state the rule table can enter. On the Mongo
 * side it needs nothing special — the guard is `status: {$in: ['ASSIGNED']}` in
 * the filter like every other transition. On the Postgres side it made the
 * lifecycle cyclic, which is a larger story: docs/ORDERS_REQUEUE_CYCLE.md.
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
export async function reassignOrder(orderId, { set = {}, from = [ORDER_STATES.ASSIGNED, ORDER_STATES.PROCESSING], session = null } = {}) {
  const q = PaymentOrder().findOneAndUpdate(
    { _id: orderId, status: { $in: from } },
    { $set: { status: ORDER_STATES.ASSIGNED, ...set } },
    { new: true },
  );
  if (session) q.session(session);
  const updated = await q.lean();
  if (updated) return { ok: true, idempotent: false, reason: LIFECYCLE.APPLIED, status: ORDER_STATES.ASSIGNED, order: updated };

  const current = await PaymentOrder().findById(orderId).select('status').lean();
  if (!current) return { ok: false, reason: LIFECYCLE.NOT_FOUND };
  return { ok: false, reason: LIFECYCLE.ILLEGAL_TRANSITION, status: current.status, attempted: ORDER_STATES.ASSIGNED, allowedFrom: from };
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
