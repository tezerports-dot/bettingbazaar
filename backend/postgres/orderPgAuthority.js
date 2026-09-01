// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/orderPgAuthority.js — the order lifecycle, behind the resolver.
 *
 * Stage 2 of docs/ORDERS_ROUTING_DESIGN.md. Stage 1 replaced 31 direct
 * `order.status = 'X'` writes across 8 files with one guarded service, which is
 * what makes this file possible: there is now a single seam to put the resolver
 * behind, so `isPostgresAuthoritative(MONEY_PATHS.ORDERS)` is asked ONCE per
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
import mongoose from 'mongoose';
import { isPostgresAuthoritative, MONEY_PATHS } from './moneyAuthority.js';
import { rupeesToPaise } from '../shared/money.js';
import {
  transition as pgTransition, openOrder as pgOpenOrder, getOrder as pgGetOrder,
  ORDER_TYPES, REVISITABLE,
} from './orderPg.js';
import { pgQuery } from './pgClient.js';
import { reverseMirrorOrderState } from './reverseMirror.js';

/** Is Postgres the source of truth for the order lifecycle? */
export const onPostgres = () => isPostgresAuthoritative(MONEY_PATHS.ORDERS);

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
 * Make sure Postgres has the order before trying to move it.
 *
 * The forward mirror (`dualWrite.mirrorPaymentOrder`) populates
 * `payment_orders`, which is the projection — NOT `order_states`, which is the
 * lifecycle. An order created before this path was flipped therefore has no
 * lifecycle row, and its first transition would come back `not_found` and be
 * surfaced to the user as a missing order.
 *
 * So the row is opened lazily from the Mongo document, AT THE STATUS THE ORDER
 * IS ACTUALLY IN. `openOrder` is `ON CONFLICT DO NOTHING`, so concurrent
 * first-transitions on one order open it once.
 *
 * Adopting at the current status rather than at PENDING_QUEUE is the whole
 * point, and getting it wrong is not subtle: an order sitting at PAID would be
 * adopted as PENDING_QUEUE, and its next transition — the merchant's confirm —
 * asks for COMPLETED, which accepts PAID/PROCESSING/DISPUTED. Refused. Every
 * order in flight at the moment of a cutover would strand that way, with the
 * money unmoved and the merchant looking at a 409.
 */
async function ensureLifecycleRow(orderId) {
  if (await pgGetOrder(orderId)) return true;

  const doc = await mongoose.model('PaymentOrder').findById(orderId)
    .select('orderId userId merchantId type tokenAmount fiatAmount status').lean();
  if (!doc) return false;
  if (!ORDER_TYPES[doc.type]) return false;

  await pgOpenOrder({
    orderId:          String(orderId),
    userId:           String(doc.userId),
    merchantId:       doc.merchantId ? String(doc.merchantId) : null,
    type:             doc.type,
    tokenAmountPaise: rupeesToPaise(Number(doc.tokenAmount) || 0),
    fiatAmountPaise:  rupeesToPaise(Number(doc.fiatAmount) || 0),
    // AT ITS CURRENT STATUS, not at the start of the lifecycle. See openOrder.
    state:            doc.status,
  });
  return true;
}

/**
 * Move an order, with Postgres deciding when it owns the path.
 *
 * Returns `{ handled }` false when Mongo is authoritative, which tells the seam
 * to run its own guarded update. Anything else is the final answer and the seam
 * returns it unchanged.
 */
export async function transitionOrderOnPostgres(orderId, to, { set = {}, expectFrom = null, actor = null, reason = null, txId = null } = {}) {

  if (!(await ensureLifecycleRow(orderId))) {
    return { handled: true, ok: false, reason: REASON.NOT_FOUND };
  }

  const key = await keyForRepeatableMove(orderId, to, txId);
  const result = await pgTransition({
    orderId: String(orderId), to, actor, reason,
    merchantId: set.merchantId ? String(set.merchantId) : null,
    txId: key,
  });

  if (!result.ok) {
    // SURFACED, not swallowed, and Mongo is not written. The store that owns
    // the lifecycle said no; writing Mongo anyway would advance the order in the
    // store everything reads while the source of truth says it never moved.
    return {
      handled: true, ok: false,
      reason: result.reason === 'not_found' ? REASON.NOT_FOUND : REASON.ILLEGAL_TRANSITION,
      status: result.state ?? null,
      attempted: to,
      allowedFrom: result.allowedFrom ?? [],
    };
  }

  // ── Mongo follows ────────────────────────────────────────────────────────
  // AWAITED, unlike the fire-and-forget forward mirror. The caller is about to
  // move money and then read `order.status` back; a mirror still in flight
  // would let it act on the previous state. The reverse mirror swallows its own
  // errors and alerts, so awaiting costs latency, not availability.
  //
  // `expectFrom` is deliberately NOT passed to Postgres: it may only ever
  // NARROW what ALLOWED_FROM permits, and narrowing is a Mongo-side convenience
  // for callers that know more than the table. Postgres holds the row lock and
  // has already refused anything the table forbids.
  const state = result.order?.state ?? to;
  await reverseMirrorOrderState(
    {
      order_id:    String(orderId),
      state,
      merchant_id: result.order?.merchantId,
      updated_at:  new Date(),
    },
    set,
  );

  return {
    handled: true, ok: true,
    idempotent: Boolean(result.idempotent),
    reason: result.idempotent ? REASON.ALREADY_THERE : REASON.APPLIED,
    status: state,
    // The seam's callers read fields off this. It is the Mongo document,
    // re-read AFTER the mirror, so it carries the whole order rather than the
    // handful of columns order_states holds.
    order: await mongoose.model('PaymentOrder').findById(orderId).lean(),
    ledgerKey: result.ledgerKey ?? null,
  };
}
