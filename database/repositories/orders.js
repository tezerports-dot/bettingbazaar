// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/orderPgAuthority.js — the order lifecycle, behind the resolver.
 *
 * Stage 2 of docs/ORDERS_ROUTING_DESIGN.md. Stage 1 replaced 31 direct
 * `order.status = 'X'` writes across 8 files with one guarded service, which is
 * what makes this file possible: there is now a single seam to put the resolver
 * behind, so `true` is asked ONCE per
 * transition rather than at every call site.
 *
 * **Only `domains/payment/orderLifecycle.service.js` may call this.** That is
 * the entire point of stage 1 and it is enforced by there being nothing else to
 * call it from — a route that reached past the seam would be back to the
 * situation the design document exists to prevent, where some transitions are
 * authoritative in Postgres and others in Mongo and no reconciliation can tell
 * that apart from the two stores genuinely disagreeing.
 *
 * ── What routing buys, beyond a second copy of the data ─────────────────────
 * The Mongo seam guards `status: {$in: ALLOWED_FROM[to]}` in the update filter,
 * which is real and was worth doing on its own. What it cannot do:
 *
 *   - bind the state change and the accounting event into ONE transaction.
 *     Mongo writes the status and posts the event afterwards, so a failure
 *     between them leaves an order COMPLETED with nothing in the books.
 *   - record HOW an order reached a state. `order_transitions` is append-only
 *     and links each move to the ledger entry it produced; `PaymentOrder` has a
 *     status field and no history.
 *   - refuse a repeat visit that carries no key of its own. See
 *     docs/ORDERS_REQUEUE_CYCLE.md — the requeue and dispute cycles make the
 *     same (order, state) pair reachable twice, and telling a redelivered
 *     callback from a genuine second visit is not something a status field can
 *     do at all.
 *
 * ── The Mongo write is not skipped when Postgres wins ───────────────────────
 * It becomes the MIRROR. Every panel, the merchant queue, the expiry cron and
 * the settlement sweep read `PaymentOrder.status`; a Postgres-authoritative
 * transition that stopped writing it would leave all of them blind. The reverse
 * mirror is what keeps the field current, and it is also what makes falling
 * back a redeploy rather than a data recovery.
 *
 * ── A refusal is surfaced, never swallowed ──────────────────────────────────
 * When Postgres refuses a transition the answer is returned to the caller as a
 * refusal, and Mongo is NOT written. Falling back to the Mongo path on a
 * Postgres refusal would mean the store that says no is overruled by the store
 * that has no opinion, which is worse than either alone: the order advances,
 * the authoritative store says it did not, and reconciliation reports drift
 * that is really a bug in this file.
 */
import {
  transition as pgTransition, reassign as pgReassign, REVISITABLE,
} from './orders.core.js';
import { setOrderFields, getOrderRecord } from './orders.record.js';
import { pgQuery } from '../client.js';

/**
 * The outcomes, matching orderLifecycle.service.js's LIFECYCLE vocabulary so
 * the seam can return either store's answer without the caller branching on
 * which one produced it.
 */
const REASON = Object.freeze({
  APPLIED:            'applied',
  ILLEGAL_TRANSITION: 'illegal_transition',
  ALREADY_THERE:      'already_there',
  NOT_FOUND:          'not_found',
});

/**
 * The key for a transition that may legitimately repeat.
 *
 * `orderPg.transition` refuses a repeat visit that brings no key, because the
 * default `ord_<order>_<state>` is already taken by the first visit and the
 * collision would be reported as an idempotent replay rather than applied. The
 * caller — a route handler — knows what event it is processing, so where it
 * supplies an idempotency key that is what is used.
 *
 * Where it does not, the fallback counts the order's existing visits and names
 * this one. That is NOT idempotency and is deliberately not dressed up as it:
 * two deliveries of one un-keyed reassignment would produce two transitions.
 * It is the honest position — the state machine cannot invent a distinction the
 * caller did not make — and it is strictly better than the alternative, which
 * is refusing a legal move because nobody passed a header. Routes that need
 * genuine retry safety on these edges pass `txId`; this is what the rest get.
 */
async function keyForRepeatableMove(orderId, to, txId) {
  if (txId) return txId;
  if (!REVISITABLE.includes(to)) return null;      // default key is safe
  const { rows } = await pgQuery(
    `SELECT COUNT(*)::int AS n FROM order_transitions WHERE order_id = $1 AND to_state = $2`,
    [String(orderId), to],
  );
  return rows[0].n ? `ord_${orderId}_${to}_v${rows[0].n + 1}` : null;
}

/**
 * Move an order.
 *
 * ── What used to be in front of this ────────────────────────────────────────
 * A lazy `ensureLifecycleRow` that read the order out of the document store and
 * opened a lifecycle row for it, at whatever status it happened to be in. That
 * existed so a cutover would not strand orders already in flight. There is no
 * cutover and no second store: an order without a row does not exist, and
 * saying so is the correct answer rather than conjuring one.
 */
export async function transitionOrder(orderId, to, { set = {}, expectFrom = null, actor = null, reason = null, txId = null } = {}) {
  const key = await keyForRepeatableMove(orderId, to, txId);
  const result = await pgTransition({
    orderId: String(orderId), to, actor, reason,
    merchantId: set.merchantId ? String(set.merchantId) : null,
    txId: key,
  });

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason === 'not_found' ? REASON.NOT_FOUND : REASON.ILLEGAL_TRANSITION,
      status: result.state ?? null,
      attempted: to,
      allowedFrom: result.allowedFrom ?? [],
    };
  }

  // `expectFrom` is deliberately NOT passed down: it may only ever NARROW what
  // ALLOWED_FROM permits, and narrowing is a convenience for callers that know
  // more than the table does. The transition already ran under the row lock and
  // the table has refused anything it forbids.
  const state = result.order?.state ?? to;

  // ── The fields that travel WITH the transition ──────────────────────────
  // `set` was passed down to a mirror that wrote them onto the document. There
  // is no mirror, so they are written here, AFTER the state has moved and only
  // when it did. An order can therefore never be found in the new state without
  // the facts that justify it, and a refused transition writes nothing.
  const detail = Object.keys(set).length ? await setOrderFields(orderId, set) : null;

  return {
    ok: true,
    idempotent: Boolean(result.idempotent),
    reason: result.idempotent ? REASON.ALREADY_THERE : REASON.APPLIED,
    status: state,
    // The whole order, not the handful of columns the lifecycle holds — callers
    // read the merchant snapshot, the amounts and the UTR off this.
    order: detail ?? await getOrderRecord(orderId),
    ledgerKey: result.ledgerKey ?? null,
  };
}

/**
 * Hand a live order to a different merchant.
 *
 * ── This wrote to the document store, with a string id ──────────────────────
 * `reassignOrder` in the lifecycle service was the one function the migration
 * never moved. It called `findOneAndUpdate({_id: orderId})` with an order id
 * like `WD_9f3a…` where an ObjectId was expected, so admin reassignment threw a
 * cast error — and had it not, it would have written to a store nothing reads
 * and reported success while the order kept its old merchant.
 */
export async function reassignOrder(orderId, { set = {}, from, actor = null, reason = null } = {}) {
  const merchantId = set.merchantId;
  if (!merchantId) throw new Error('reassignOrder requires set.merchantId');

  const result = await pgReassign({
    orderId: String(orderId), merchantId: String(merchantId), actor, reason,
    ...(from ? { from: Array.isArray(from) ? from : [from] } : {}),
  });

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason === 'not_found' ? REASON.NOT_FOUND : REASON.ILLEGAL_TRANSITION,
      status: result.state ?? null,
      attempted: 'ASSIGNED',
      allowedFrom: result.allowedFrom ?? [],
    };
  }

  // The snapshot and the new deadline are written after the assignee moved, so
  // a refused reassignment cannot leave the previous merchant's order carrying
  // the next merchant's payment details.
  const detail = Object.keys(set).length ? await setOrderFields(orderId, set) : null;

  return {
    ok: true,
    idempotent: Boolean(result.idempotent),
    reason: result.idempotent ? REASON.ALREADY_THERE : REASON.APPLIED,
    status: 'ASSIGNED',
    order: detail ?? await getOrderRecord(orderId),
  };
}
