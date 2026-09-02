// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * postgres/orderPg.js — the payment order lifecycle, in PostgreSQL.
 *
 * Domain 5, and the glue. Orders are what every other financial domain hangs
 * off: a settlement is driven by an order's state, a ledger event is produced
 * by an order reaching a state, a merchant's inventory is committed because an
 * order asked for it. Until this state is authoritative here, every one of
 * those still depends on Mongo to say where the order is.
 *
 * ── What `payment_orders` already was, and why it is not this ───────────────
 * That table is a MIRROR — the Mongo document projected on every save,
 * overwritten in place, with no history and no guard on what may follow what.
 * It answers "where is this order now" and nothing else. It cannot refuse a
 * transition, cannot say how the order got here, and cannot connect a state
 * change to the accounting entry it produced.
 *
 * ── The state machine ───────────────────────────────────────────────────────
 *
 *   PENDING_QUEUE ─▶ ASSIGNED ─▶ PROCESSING ─▶ PAID ─▶ COMPLETED
 *         │              │            │          │
 *         └──────────────┴────────────┴──────────┴──▶ CANCELLED / FAILED /
 *                                                     REJECTED / DISPUTED
 *
 * ALLOWED_FROM is the whole rule, as data. Every transition names the states it
 * accepts and the guard lives in the UPDATE's WHERE clause, so a caller
 * arriving with a stale idea of the order matches no row and is refused. That
 * is what makes an out-of-order provider callback safe rather than merely
 * unlikely — the case a status field with no guard obeys silently.
 *
 * ── Money moves with the state, in one transaction ──────────────────────────
 * A transition that produces an accounting event writes BOTH inside the same
 * transaction, and records the ledger key on the transition row. Either the
 * order advanced and the books recorded it, or neither happened. The Mongo path
 * changes status first and records the event afterwards, which is the shape
 * that leaves an order COMPLETED with no entry when the second step fails.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 * `order_transitions.tx_id` is UNIQUE and derived from the order and the target
 * state, so the same callback delivered twice collides INSIDE the transaction
 * and the whole thing unwinds. There is no pre-read to race.
 */
import { getPool, pgQuery, connectGuarded } from '../client.js';
import { EVENT_TYPES } from '../../backend/domains/revenue/chartOfAccounts.js';

export const ORDER_STATES = Object.freeze({
  PENDING_QUEUE: 'PENDING_QUEUE',
  ASSIGNED:      'ASSIGNED',
  PROCESSING:    'PROCESSING',
  PAID:          'PAID',
  COMPLETED:     'COMPLETED',
  DISPUTED:      'DISPUTED',
  CANCELLED:     'CANCELLED',
  FAILED:        'FAILED',
  REJECTED:      'REJECTED',
});

export const ORDER_TYPES = Object.freeze({ DEPOSIT: 'DEPOSIT', WITHDRAWAL: 'WITHDRAWAL' });

/**
 * Which states each target accepts. Kept as DATA rather than branching, so the
 * whole rule can be read at once and compared against the diagram above.
 */
/**
 * EXPORTED so the Mongo-side seam (domains/payment/orderLifecycle.service.js)
 * guards with the SAME table rather than a copy of it.
 *
 * Two tables would be two rules, and they would drift the first time someone
 * added a state to one of them — leaving a transition Postgres refuses and
 * Mongo permits, which is the exact class of disagreement no reconciliation can
 * distinguish from real drift. One definition, both stores.
 *
 * ── PENDING_QUEUE is re-enterable, and used not to be ───────────────────────
 * This table said "nothing transitions INTO PENDING_QUEUE; that is where an
 * order is opened", and two tests asserted it. The live Mongo path disagreed:
 * merchant.routes.js's reject handler sets an ASSIGNED order back to
 * PENDING_QUEUE and immediately looks for another merchant. That is the whole
 * point of rejecting — the order returns to the queue.
 *
 * So the rule table was wrong, not the route. Adding the edge is what lets the
 * seam guard that site at all; without it `transitionOrder(id,'PENDING_QUEUE')`
 * throws and the one remaining unguarded status write would have had to stay
 * unguarded. See docs/ORDERS_REQUEUE_CYCLE.md for the consequence it exposed.
 */
export const ALLOWED_FROM = Object.freeze({
  // The requeue edge. An ASSIGNED order whose merchant declines goes back to
  // the queue to be offered to someone else.
  [ORDER_STATES.PENDING_QUEUE]: [ORDER_STATES.ASSIGNED],
  [ORDER_STATES.ASSIGNED]:   [ORDER_STATES.PENDING_QUEUE],
  // PENDING_QUEUE is here because a merchant can take an order straight out of
  // the open pool without it ever having been assigned to them —
  // merchant.routes.js's accept handler admits both, and the rail is re-checked
  // at that moment precisely because the order arrived unassigned.
  [ORDER_STATES.PROCESSING]: [ORDER_STATES.ASSIGNED, ORDER_STATES.PENDING_QUEUE],
  [ORDER_STATES.PAID]:       [ORDER_STATES.PROCESSING, ORDER_STATES.ASSIGNED],
  // DISPUTED is here because resolving a dispute IS this transition. Without
  // it, DISPUTED had no outgoing edges at all and every admin resolution
  // refused itself: the resolve routes confirm the order is DISPUTED and then
  // ask for COMPLETED or CANCELLED, so the guarded update matched no row and
  // returned 409 for the one status those routes exist to handle. A disputed
  // order could be created and never resolved.
  [ORDER_STATES.COMPLETED]:  [ORDER_STATES.PAID, ORDER_STATES.PROCESSING, ORDER_STATES.DISPUTED],
  // A dispute can be raised on anything not yet final, including COMPLETED —
  // that is precisely when disputes happen.
  [ORDER_STATES.DISPUTED]:   [ORDER_STATES.PROCESSING, ORDER_STATES.PAID, ORDER_STATES.COMPLETED],
  // Abandonment paths. An order that has already COMPLETED cannot be cancelled;
  // undoing settled value is a reversal, which is the settlement domain's job.
  // PAID is here to match what the merchant reject route already does. The
  // table's own distinction would put it in FAILED — CANCELLED for an order
  // abandoned before payment was asserted, FAILED for one where payment WAS
  // asserted and did not check out — and that is the better model. Changing
  // which status a rejected PAID order lands in is a user-visible change to
  // every panel, filter and count that reads it, so it is deliberately NOT
  // bundled into a stage whose contract is "no behaviour change". Tracked in
  // docs/ORDERS_REQUEUE_CYCLE.md as follow-up.
  // DISPUTED, for the same reason as COMPLETED above: a dispute resolved in the
  // payer's favour cancels the order and refunds it.
  [ORDER_STATES.CANCELLED]:  [ORDER_STATES.PENDING_QUEUE, ORDER_STATES.ASSIGNED, ORDER_STATES.PROCESSING, ORDER_STATES.PAID, ORDER_STATES.DISPUTED],
  [ORDER_STATES.FAILED]:     [ORDER_STATES.PENDING_QUEUE, ORDER_STATES.ASSIGNED, ORDER_STATES.PROCESSING, ORDER_STATES.PAID],
  [ORDER_STATES.REJECTED]:   [ORDER_STATES.PENDING_QUEUE, ORDER_STATES.ASSIGNED, ORDER_STATES.PROCESSING],
});

/**
 * REVISITABLE — the states an order can legally reach MORE THAN ONCE, derived
 * from the graph rather than listed by hand so adding an edge cannot leave this
 * silently stale.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The default transition key is `ord_<order>_<state>` and `tx_id` is UNIQUE, so
 * it does two jobs at once: it is the idempotency gate for a duplicate
 * callback, AND the uniqueness key for the row. On an acyclic graph those two
 * jobs agree. The moment the graph has a cycle they conflict, because the same
 * (order, target state) pair is now reachable twice for two genuinely different
 * reasons.
 *
 * Measured, not assumed: with the requeue edge added and no explicit key, the
 * second assignment of a rejected order collided on
 * `ord_<order>_ASSIGNED`, was reported `{ok: true, idempotent: true}` — the
 * "someone already did this" answer — and the order stayed in PENDING_QUEUE
 * still carrying the FIRST merchant's id. A rejected order would never be
 * reassigned, and nothing would raise an error.
 *
 * ── The decision ────────────────────────────────────────────────────────────
 * The idempotency key must describe THE EVENT, not the destination. Only the
 * caller knows whether two arrivals at ASSIGNED are one merchant's double-click
 * or two different merchants being offered the order in turn — that difference
 * is not visible from (order, state).
 *
 * So on these edges an explicit `txId` is REQUIRED and its absence throws. A
 * loud refusal at the call site is the only option that cannot be mistaken for
 * success; minting a unique key by default would silently drop the retry
 * protection that every other edge relies on.
 */
export const REVISITABLE = Object.freeze(
  Object.keys(ORDER_STATES).filter((start) => {
    // Depth-first: can `start` be reached again after leaving it?
    const forward = (from) => Object.keys(ALLOWED_FROM).filter((to) => ALLOWED_FROM[to].includes(from));
    const seen = new Set();
    const stack = forward(start);
    while (stack.length) {
      const s = stack.pop();
      if (s === start) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...forward(s));
    }
    return false;
  })
);

/**
 * The accounting event a transition produces, if any.
 *
 * Only COMPLETED moves money out of the platform's perspective: a deposit means
 * fiat arrived and the user's liability grew; a withdrawal means the reverse.
 * ASSIGNED and PROCESSING move workflow, not value, and posting an event for
 * them would put entries in the ledger describing nothing that happened.
 */
const LEDGER_EVENT = Object.freeze({
  [ORDER_STATES.COMPLETED]: {
    [ORDER_TYPES.DEPOSIT]: (paise) => ({
      eventType: EVENT_TYPES.DEPOSIT_COMPLETED,
      postings: [
        { account: 'EXTERNAL_FIAT', amountPaise: paise },
        { account: 'USER_FUNDS', amountPaise: -paise },
      ],
    }),
    [ORDER_TYPES.WITHDRAWAL]: (paise) => ({
      eventType: EVENT_TYPES.WITHDRAWAL_COMPLETED,
      postings: [
        { account: 'USER_FUNDS', amountPaise: paise },
        { account: 'EXTERNAL_FIAT', amountPaise: -paise },
      ],
    }),
  },
});

const toPaise = (v) => Number(v ?? 0);

function rowToOrder(row) {
  if (!row) return null;
  return {
    orderId:    row.order_id,
    userId:     row.user_id,
    merchantId: row.merchant_id,
    type:       row.order_type,
    state:      row.state,
    tokenAmountPaise: toPaise(row.token_amount_paise),
    fiatAmountPaise:  toPaise(row.fiat_amount_paise),
    createdAt:  row.created_at,
    updatedAt:  row.updated_at,
  };
}

/** The order's current state, or null. */
export async function getOrder(orderId) {
  const { rows } = await pgQuery(
    `SELECT * FROM order_states WHERE order_id = $1`, [String(orderId)], 'order_read');
  return rowToOrder(rows[0]);
}

/** Its full transition history, oldest first. Append-only in the database. */
export async function getOrderHistory(orderId) {
  const { rows } = await pgQuery(
    `SELECT tx_id, from_state, to_state, actor, reason, ledger_key, created_at
       FROM order_transitions WHERE order_id = $1 ORDER BY id`,
    [String(orderId)], 'order_history',
  );
  return rows.map((r) => ({
    txId: r.tx_id, from: r.from_state, to: r.to_state,
    actor: r.actor, reason: r.reason, ledgerKey: r.ledger_key, at: r.created_at,
  }));
}

async function withOrderLock(orderId, fn) {
  const oid = String(orderId);
  const pool = await getPool();
  if (!pool) throw new Error('Postgres not configured (DATABASE_URL unset)');
  const client = await connectGuarded(pool);
  let failure = null;

  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT * FROM order_states WHERE order_id = $1 FOR UPDATE`, [oid]);
    const { commit, value } = await fn({ client, oid, order: rowToOrder(locked.rows[0]) });
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return value;
  } catch (error) {
    failure = error;
    try { await client.query('ROLLBACK'); } catch { /* already unwound */ }
    throw error;
  } finally {
    // Destroy rather than reuse a client whose backend may have gone away
    // mid-transaction — see merchantWalletPg.withMerchantLock.
    client.release(failure ?? undefined);
  }
}

/**
 * openOrder — create the order in PENDING_QUEUE.
 *
 * Idempotent on the order id: a retried creation returns the existing order
 * rather than a second one, which matters because the id is derived from the
 * request and a retry is the normal outcome of a timeout.
 */
export async function openOrder({
  orderId, userId, merchantId = null, type, tokenAmountPaise, fiatAmountPaise = 0,
  state = ORDER_STATES.PENDING_QUEUE,
}) {
  if (!orderId) throw new Error('openOrder requires an orderId');
  // ADOPTION. A cutover has to take on orders that are already in flight, and
  // they are not at the start of the lifecycle — an order sitting at PAID in
  // Mongo must be adopted AT PAID. Opening it at PENDING_QUEUE instead would
  // make its very next transition illegal (COMPLETED accepts PAID/PROCESSING/
  // DISPUTED), so the merchant's confirm would be refused and the order would
  // strand with the money unmoved. Every in-flight order would break that way
  // at the moment of the flip.
  if (!ORDER_STATES[state]) {
    throw new Error(`openOrder: unknown state '${state}'. Known: ${Object.keys(ORDER_STATES).join(', ')}`);
  }
  if (!ORDER_TYPES[type]) {
    throw new Error(`Unknown order type '${type}'. Known: ${Object.keys(ORDER_TYPES).join(', ')}`);
  }
  if (!Number.isInteger(tokenAmountPaise) || tokenAmountPaise <= 0) {
    throw new TypeError(`openOrder: tokenAmountPaise must be a positive integer, got ${tokenAmountPaise}`);
  }

  const { rows } = await pgQuery(
    `INSERT INTO order_states
       (order_id, user_id, merchant_id, order_type, state, token_amount_paise, fiat_amount_paise)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (order_id) DO NOTHING
     RETURNING *`,
    [String(orderId), String(userId), merchantId ? String(merchantId) : null,
     type, state, tokenAmountPaise, fiatAmountPaise],
    'order_open',
  );

  if (!rows.length) {
    return { ok: true, idempotent: true, order: await getOrder(orderId) };
  }
  return { ok: true, idempotent: false, order: rowToOrder(rows[0]) };
}

/**
 * transition — advance the order, and post its ledger event if it has one.
 *
 * Returns one of four outcomes, all distinguished, because a caller needs to
 * tell "already done" from "arrived out of order":
 *   { ok: true,  idempotent: false }  this call advanced it
 *   { ok: true,  idempotent: true  }  someone already did; nothing moved
 *   { ok: false, reason: 'not_found' }
 *   { ok: false, reason: 'invalid_transition', state, allowedFrom }
 *
 * Collapsing "already done" into a failure is how a retry-safe API stops being
 * retry-safe: the caller compensates for something that actually succeeded.
 */
export async function transition({
  orderId, to, actor = null, reason = null, merchantId = null, txId = null,
}) {
  if (!ORDER_STATES[to]) {
    throw new Error(`Unknown order state '${to}'. Known: ${Object.keys(ORDER_STATES).join(', ')}`);
  }
  const allowedFrom = ALLOWED_FROM[to];
  if (!allowedFrom) {
    throw new Error(`Nothing may transition INTO '${to}' — an order is opened there, not moved there.`);
  }
  const mayRepeat = REVISITABLE.includes(to);

  return withOrderLock(orderId, async ({ client, oid, order }) => {
    if (!order) return { commit: false, value: { ok: false, reason: 'not_found' } };
    if (order.state === to) {
      return { commit: false, value: { ok: true, idempotent: true, order } };
    }
    if (!allowedFrom.includes(order.state)) {
      return {
        commit: false,
        value: { ok: false, reason: 'invalid_transition', state: order.state, allowedFrom },
      };
    }

    // ── The default key is only safe on a FIRST visit ────────────────────────
    // `ord_<order>_<state>` is fine until the order reaches that state a second
    // time, which the requeue and dispute cycles both allow. The second visit
    // would collide with the first's key, unwind the transaction, and be
    // reported `{ok: true, idempotent: true}` — the "already done" answer — so
    // the order would silently fail to move and nothing would raise a fault.
    //
    // Checked here rather than statically so the common case stays ergonomic: a
    // caller completing an order for the first time needs no key, and only a
    // genuine repeat visit is asked for one. The row lock is held, so no
    // concurrent transition can add the row between this read and the insert.
    // See docs/ORDERS_REQUEUE_CYCLE.md.
    if (!txId && mayRepeat) {
      const prior = await client.query(
        `SELECT 1 FROM order_transitions WHERE order_id = $1 AND to_state = $2 LIMIT 1`,
        [oid, to],
      );
      if (prior.rowCount) {
        throw new Error(
          `transition to '${to}' on order ${oid} requires an explicit txId: the order has been ` +
          `in '${to}' before, so the default key ord_${oid}_${to} is already taken and this move ` +
          `would be reported as an idempotent replay rather than applied. Pass a txId identifying ` +
          `THIS event (states that can repeat: ${REVISITABLE.join(', ')}).`,
        );
      }
    }

    // The guard is in the WHERE clause, not in the check above: between reading
    // the row and writing it another transaction could have moved it, and only
    // the database settles that race. The read gives a good error message; the
    // WHERE gives correctness.
    const moved = await client.query(
      `UPDATE order_states
          SET state = $2, updated_at = now(),
              merchant_id = COALESCE($3, merchant_id)
        WHERE order_id = $1 AND state = ANY($4)
        RETURNING *`,
      [oid, to, merchantId ? String(merchantId) : null, allowedFrom],
    );
    if (!moved.rowCount) {
      return { commit: false, value: { ok: false, reason: 'invalid_transition', state: order.state, allowedFrom } };
    }

    // A duplicate callback collides here, INSIDE the transaction, so the state
    // change unwinds with it.
    const transitionTxId = txId || `ord_${oid}_${to}`;

    // ── The accounting key is NOT the transition key ─────────────────────────
    // It used to be `acct_${transitionTxId}`, which was the same thing while
    // every state was reachable once. It is not the same thing now, and the
    // difference is money: an order that completes, is disputed, and is then
    // resolved back to COMPLETED performs a SECOND transition — with its own
    // key, necessarily, or it could not be applied at all — and a ledger key
    // derived from it posted a SECOND DEPOSIT_COMPLETED. Measured: USER_FUNDS
    // went to 140000 on a 70000 deposit.
    //
    // A transition is an event and may legitimately repeat. The accounting fact
    // "this order's deposit completed" happens once per order, however many
    // times the state machine passes back through COMPLETED. So the ledger key
    // stays derived from the ORDER and the STATE, and the ON CONFLICT DO
    // NOTHING below turns the repeat into the no-op it should be.
    const spec = LEDGER_EVENT[to]?.[order.type];
    const ledgerKey = spec ? `acct_ord_${oid}_${to}` : null;

    try {
      await client.query(
        `INSERT INTO order_transitions (tx_id, order_id, from_state, to_state, actor, reason, ledger_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [transitionTxId, oid, order.state, to, actor, reason, ledgerKey],
      );
    } catch (error) {
      if (error.code === '23505') {
        return { commit: false, value: { ok: true, idempotent: true, order } };
      }
      throw error;
    }

    // The accounting event, in the SAME transaction as the state change. This
    // is the property the Mongo path cannot offer: there, status is written
    // first and the event afterwards, so a failure between them leaves an order
    // COMPLETED with nothing in the books.
    if (spec) {
      const { eventType, postings } = spec(order.tokenAmountPaise);
      await client.query(
        `INSERT INTO accounting_events
           (idempotency_key, event_type, amount_paise, ref_model, ref_id, postings, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [ledgerKey, eventType, order.tokenAmountPaise, 'PaymentOrder', oid,
         JSON.stringify(postings), reason || `${order.type} order ${oid} completed`],
      );
    }

    return {
      commit: true,
      value: { ok: true, idempotent: false, order: rowToOrder(moved.rows[0]), ledgerKey },
    };
  });
}

// ── Named transitions, so call sites read as intent rather than as strings ───
export const assignOrder   = (a) => transition({ ...a, to: ORDER_STATES.ASSIGNED });
export const startOrder    = (a) => transition({ ...a, to: ORDER_STATES.PROCESSING });
export const markPaid      = (a) => transition({ ...a, to: ORDER_STATES.PAID });
export const completeOrder = (a) => transition({ ...a, to: ORDER_STATES.COMPLETED });
export const disputeOrder  = (a) => transition({ ...a, to: ORDER_STATES.DISPUTED });
export const cancelOrder   = (a) => transition({ ...a, to: ORDER_STATES.CANCELLED });
export const failOrder     = (a) => transition({ ...a, to: ORDER_STATES.FAILED });
export const rejectOrder   = (a) => transition({ ...a, to: ORDER_STATES.REJECTED });

/**
 * Does every completed order have the accounting event it should have produced?
 *
 * The transition and the event are written in one transaction, so a gap should
 * be impossible — which is exactly why it is worth checking. A non-empty result
 * means something advanced an order without going through this module.
 */
export async function findOrdersMissingLedgerEvents() {
  const { rows } = await pgQuery(
    `SELECT t.order_id, t.to_state, t.ledger_key
       FROM order_transitions t
       LEFT JOIN accounting_events e ON e.idempotency_key = t.ledger_key
      WHERE t.ledger_key IS NOT NULL AND e.id IS NULL
      ORDER BY t.id`,
    [], 'order_ledger_gap',
  );
  return rows.map((r) => ({ orderId: r.order_id, state: r.to_state, ledgerKey: r.ledger_key }));
}

/**
 * The reverse gap: an order-shaped accounting event with no transition behind
 * it. Catches an event posted directly rather than produced by a state change.
 */
export async function findLedgerEventsMissingOrders() {
  const { rows } = await pgQuery(
    `SELECT e.idempotency_key, e.event_type, e.ref_id
       FROM accounting_events e
       LEFT JOIN order_transitions t ON t.ledger_key = e.idempotency_key
      WHERE e.ref_model = 'PaymentOrder' AND t.id IS NULL
      ORDER BY e.id`,
    [], 'order_ledger_orphan',
  );
  return rows.map((r) => ({ ledgerKey: r.idempotency_key, eventType: r.event_type, orderId: r.ref_id }));
}
