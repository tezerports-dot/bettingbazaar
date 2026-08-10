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
import { getPool, pgQuery, connectGuarded } from './pgClient.js';
import { EVENT_TYPES } from '../domains/revenue/chartOfAccounts.js';

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
 *
 * A terminal state accepts nothing — there is no entry for PENDING_QUEUE
 * because nothing transitions INTO it; that is where an order is opened.
 */
/**
 * EXPORTED so the Mongo-side seam (domains/payment/orderLifecycle.service.js)
 * guards with the SAME table rather than a copy of it.
 *
 * Two tables would be two rules, and they would drift the first time someone
 * added a state to one of them — leaving a transition Postgres refuses and
 * Mongo permits, which is the exact class of disagreement no reconciliation can
 * distinguish from real drift. One definition, both stores.
 */
export const ALLOWED_FROM = Object.freeze({
  [ORDER_STATES.ASSIGNED]:   [ORDER_STATES.PENDING_QUEUE],
  [ORDER_STATES.PROCESSING]: [ORDER_STATES.ASSIGNED],
  [ORDER_STATES.PAID]:       [ORDER_STATES.PROCESSING, ORDER_STATES.ASSIGNED],
  [ORDER_STATES.COMPLETED]:  [ORDER_STATES.PAID, ORDER_STATES.PROCESSING],
  // A dispute can be raised on anything not yet final, including COMPLETED —
  // that is precisely when disputes happen.
  [ORDER_STATES.DISPUTED]:   [ORDER_STATES.PROCESSING, ORDER_STATES.PAID, ORDER_STATES.COMPLETED],
  // Abandonment paths. An order that has already COMPLETED cannot be cancelled;
  // undoing settled value is a reversal, which is the settlement domain's job.
  [ORDER_STATES.CANCELLED]:  [ORDER_STATES.PENDING_QUEUE, ORDER_STATES.ASSIGNED, ORDER_STATES.PROCESSING],
  [ORDER_STATES.FAILED]:     [ORDER_STATES.PENDING_QUEUE, ORDER_STATES.ASSIGNED, ORDER_STATES.PROCESSING, ORDER_STATES.PAID],
  [ORDER_STATES.REJECTED]:   [ORDER_STATES.PENDING_QUEUE, ORDER_STATES.ASSIGNED, ORDER_STATES.PROCESSING],
});

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
}) {
  if (!orderId) throw new Error('openOrder requires an orderId');
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
     type, ORDER_STATES.PENDING_QUEUE, tokenAmountPaise, fiatAmountPaise],
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

    // One transition per order per target state. A duplicate callback collides
    // here, INSIDE the transaction, so the state change unwinds with it.
    const transitionTxId = txId || `ord_${oid}_${to}`;
    const spec = LEDGER_EVENT[to]?.[order.type];
    const ledgerKey = spec ? `acct_${transitionTxId}` : null;

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
