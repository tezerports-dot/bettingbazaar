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
export async function transitionOrder(orderId, to, { set = {}, expectFrom = null, session = null } = {}) {
  const allowed = ALLOWED_FROM[to];
  if (!allowed) throw new Error(`transitionOrder: '${to}' is not a state anything transitions into`);

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
export const startOrder     = (id, o) => transitionOrder(id, ORDER_STATES.PROCESSING, o);
export const markOrderPaid  = (id, o) => transitionOrder(id, ORDER_STATES.PAID, o);
export const completeOrder  = (id, o) => transitionOrder(id, ORDER_STATES.COMPLETED, o);
export const disputeOrder   = (id, o) => transitionOrder(id, ORDER_STATES.DISPUTED, o);
export const cancelOrder    = (id, o) => transitionOrder(id, ORDER_STATES.CANCELLED, o);
export const failOrder      = (id, o) => transitionOrder(id, ORDER_STATES.FAILED, o);
export const rejectOrder    = (id, o) => transitionOrder(id, ORDER_STATES.REJECTED, o);

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
