// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * repositories/orders.record.js — the order as a RECORD, beside the state
 * machine that governs it.
 *
 * `orders.core.js` owns the lifecycle: which states may follow which, the guard
 * in the UPDATE, and the accounting entry written in the same transaction.
 * Nothing here moves an order between states — every write in this file sets
 * detail on an order whose state is already what it should be.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * The order document was assigned to directly from 31 places, none of which
 * checked the state the order was in. The lifecycle module fixed the state; the
 * remaining ~60 fields kept being assigned ad hoc. They are columns now, with
 * an allowlist that REFUSES an unknown one rather than dropping it — the
 * document model discarded a write to an undeclared path and reported success.
 *
 * ── Two snapshots, and why they are snapshots ───────────────────────────────
 * `merchant_snapshot` is the merchant's payment details AS THE PLAYER SAW THEM.
 * A merchant editing their UPI id afterwards must not change the account a
 * player was told to pay — that is the difference between a dispute with an
 * answer and one without.
 *
 * `deposit_policy_snapshot` is the same idea for the split: an admin editing
 * the policy must not change what a settled order says it allocated.
 */
import { pgQuery } from '../client.js';
import { rupeesToPaise, paiseToRupees } from '../../backend/shared/money.js';

const num = (v) => Number(v ?? 0);
const rupees = (v) => paiseToRupees(num(v));

/**
 * The shape the routes and panels already read.
 *
 * `type`, `status` and `_id` are the document vocabulary; `orderType`, `state`
 * and `orderId` are the table's. Both are present because renaming them is a
 * change to every panel, and that is not what this migration is.
 */
export function toOrder(r) {
  if (!r) return null;
  return {
    orderId: r.order_id, _id: r.order_id, id: r.order_id,
    userId: r.user_id, merchantId: r.merchant_id,
    type: r.order_type, orderType: r.order_type,
    status: r.state, state: r.state,
    currency: r.currency,
    tokenAmount: rupees(r.token_amount_paise),
    fiatAmount: rupees(r.fiat_amount_paise),
    amount: rupees(r.token_amount_paise),
    rateUsed: r.rate_used === null ? null : Number(r.rate_used),
    merchantProfit: rupees(r.merchant_profit_paise),
    payoutFee: rupees(r.payout_fee_paise),
    merchantFee: rupees(r.merchant_fee_paise),
    platformFeeRate: r.platform_fee_rate === null ? null : Number(r.platform_fee_rate),
    depositAllocation: rupees(r.deposit_allocation_paise),
    reserveAllocation: rupees(r.reserve_allocation_paise),
    depositPolicySnapshot: r.deposit_policy_snapshot,

    escrowStatus: r.escrow_status,
    escrowLocked: r.escrow_locked,
    escrowAmount: rupees(r.escrow_amount_paise),
    merchantCreditStatus: r.merchant_credit_status,
    merchantCreditHoldUntil: r.merchant_credit_hold_until,
    merchantCreditReversedAt: r.merchant_credit_reversed_at,
    merchantCreditReversedReason: r.merchant_credit_reversed_reason,

    userPhone: r.user_phone,
    userBankDetails: r.user_bank_details,
    userUsdtAddress: r.user_usdt_address,
    requiresVideoKYC: r.requires_video_kyc,

    utrNumber: r.utr, utr: r.utr,
    proofScreenshot: r.proof_screenshot,
    proofExpiresAt: r.proof_expires_at,
    utrWarning: r.utr_warning,
    utrWarningMessage: r.utr_warning_message,
    utrWarningData: r.utr_warning_data,

    requiresReview: r.requires_review,
    reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at,
    reviewAction: r.review_action, reviewNotes: r.review_notes,
    rejectedReason: r.rejected_reason,

    disputeReason: r.dispute_reason,
    disputeRaisedAt: r.dispute_raised_at, disputeRaisedBy: r.dispute_raised_by,
    disputeEscalated: r.dispute_escalated,
    disputeEscalatedAt: r.dispute_escalated_at,
    disputeEscalationNotes: r.dispute_escalation_notes,
    disputeResolvedBy: r.dispute_resolved_by,
    disputeResolvedAt: r.dispute_resolved_at,
    disputeDecision: r.dispute_decision,
    disputeResolution: r.dispute_resolution,
    refundedAmount: rupees(r.refunded_amount_paise),
    mediatorId: r.mediator_id,

    redFlagged: r.red_flagged, redFlagReason: r.red_flag_reason,
    redFlaggedBy: r.red_flagged_by, redFlaggedAt: r.red_flagged_at,

    assignedBy: r.assigned_by, assignedAt: r.assigned_at,
    processingAt: r.processing_at,
    merchantPanelUrl: r.merchant_panel_url,
    merchantResponseMinutes: r.merchant_response_minutes === null
      ? null : Number(r.merchant_response_minutes),
    merchantSnapshot: r.merchant_snapshot,

    approvedBy: r.approved_by, approvedAt: r.approved_at,
    rejectedBy: r.rejected_by, rejectedAt: r.rejected_at,
    cancelReason: r.cancel_reason, cancelledAt: r.cancelled_at,
    warningIssued: r.warning_issued,
    paidAt: r.paid_at, completedAt: r.completed_at, expiresAt: r.expires_at,
    bulkPayoutDate: r.bulk_payout_date, bulkPaidAt: r.bulk_paid_at,
    bulkPayoutBatch: r.bulk_payout_batch,

    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/**
 * Fields a caller may set, and the column each maps to.
 *
 * An allowlist that THROWS on anything else. `state`, `order_type`, `user_id`
 * and the amounts are absent deliberately: the state belongs to the lifecycle
 * module, and an amount changed after the fact is a different order.
 */
const SETTABLE = Object.freeze({
  merchantId: 'merchant_id',
  currency: 'currency',
  rateUsed: 'rate_used',
  merchantProfit: ['merchant_profit_paise', rupeesToPaise],
  payoutFee: ['payout_fee_paise', rupeesToPaise],
  merchantFee: ['merchant_fee_paise', rupeesToPaise],
  platformFeeRate: 'platform_fee_rate',
  depositAllocation: ['deposit_allocation_paise', rupeesToPaise],
  reserveAllocation: ['reserve_allocation_paise', rupeesToPaise],
  depositPolicySnapshot: ['deposit_policy_snapshot', JSON.stringify],

  escrowStatus: 'escrow_status',
  escrowLocked: 'escrow_locked',
  escrowAmount: ['escrow_amount_paise', rupeesToPaise],
  merchantCreditStatus: 'merchant_credit_status',
  merchantCreditHoldUntil: 'merchant_credit_hold_until',
  merchantCreditReversedAt: 'merchant_credit_reversed_at',
  merchantCreditReversedReason: 'merchant_credit_reversed_reason',

  userPhone: 'user_phone',
  userBankDetails: ['user_bank_details', JSON.stringify],
  userUsdtAddress: 'user_usdt_address',
  requiresVideoKYC: 'requires_video_kyc',

  utrNumber: 'utr', utr: 'utr',
  proofScreenshot: 'proof_screenshot',
  proofExpiresAt: 'proof_expires_at',
  utrWarning: 'utr_warning',
  utrWarningMessage: 'utr_warning_message',
  utrWarningData: ['utr_warning_data', JSON.stringify],

  requiresReview: 'requires_review',
  reviewedBy: 'reviewed_by', reviewedAt: 'reviewed_at',
  reviewAction: 'review_action', reviewNotes: 'review_notes',
  rejectedReason: 'rejected_reason',

  disputeReason: 'dispute_reason',
  disputeRaisedAt: 'dispute_raised_at', disputeRaisedBy: 'dispute_raised_by',
  disputeEscalated: 'dispute_escalated',
  disputeEscalatedAt: 'dispute_escalated_at',
  disputeEscalationNotes: 'dispute_escalation_notes',
  disputeResolvedBy: 'dispute_resolved_by',
  disputeResolvedAt: 'dispute_resolved_at',
  disputeDecision: 'dispute_decision',
  disputeResolution: 'dispute_resolution',
  refundedAmount: ['refunded_amount_paise', rupeesToPaise],
  mediatorId: 'mediator_id',

  redFlagged: 'red_flagged', redFlagReason: 'red_flag_reason',
  redFlaggedBy: 'red_flagged_by', redFlaggedAt: 'red_flagged_at',

  assignedBy: 'assigned_by', assignedAt: 'assigned_at',
  processingAt: 'processing_at',
  merchantPanelUrl: 'merchant_panel_url',
  merchantResponseMinutes: 'merchant_response_minutes',
  merchantSnapshot: ['merchant_snapshot', JSON.stringify],

  approvedBy: 'approved_by', approvedAt: 'approved_at',
  rejectedBy: 'rejected_by', rejectedAt: 'rejected_at',
  cancelReason: 'cancel_reason', cancelledAt: 'cancelled_at',
  warningIssued: 'warning_issued',
  paidAt: 'paid_at', completedAt: 'completed_at', expiresAt: 'expires_at',
  bulkPayoutDate: 'bulk_payout_date', bulkPaidAt: 'bulk_paid_at',
  bulkPayoutBatch: 'bulk_payout_batch',
});

/**
 * Open an order WITH its detail, in one statement.
 *
 * `openOrder` (the lifecycle module) writes the six columns the state machine
 * needs; everything else — allocations, escrow, the payer's bank details, the
 * fee — used to arrive in a second UPDATE. Between the two, the order existed
 * at PENDING_QUEUE with a zero allocation and no escrow flag, and the assignment
 * sweep could pick it up there. A crash between them left it that way for good.
 *
 * `ON CONFLICT DO NOTHING` makes it retry-safe: the caller's generated order id
 * is the idempotency key, so a resubmitted create returns the existing order
 * rather than a second one.
 */
export async function createOrderRecord({
  orderId, userId, type, tokenAmountRupees, fiatAmountRupees = 0,
  state = 'PENDING_QUEUE', ...detail
}) {
  if (!orderId) throw new Error('createOrderRecord requires an orderId');
  if (!userId) throw new Error('createOrderRecord requires a userId');
  if (type !== 'DEPOSIT' && type !== 'WITHDRAWAL') {
    throw new Error(`createOrderRecord: unknown order type '${type}'`);
  }
  const tokenPaise = rupeesToPaise(tokenAmountRupees);
  if (!Number.isInteger(tokenPaise) || tokenPaise <= 0) {
    throw new TypeError(`createOrderRecord: tokenAmount must be positive, got ${tokenAmountRupees}`);
  }

  const columns = ['order_id', 'user_id', 'order_type', 'state', 'token_amount_paise', 'fiat_amount_paise'];
  const params = [String(orderId), String(userId), type, state, tokenPaise, rupeesToPaise(fiatAmountRupees)];

  // The same allowlist `setOrderFields` uses, so a field this create accepts is
  // one an update accepts and vice versa — and an unknown one is refused here
  // too rather than silently dropped.
  const unknown = Object.entries(detail)
    .filter(([k, v]) => v !== undefined && !SETTABLE[k]).map(([k]) => k);
  if (unknown.length) {
    throw new Error(`createOrderRecord: refusing to write unknown field(s): ${unknown.join(', ')}`);
  }
  for (const [key, value] of Object.entries(detail)) {
    if (value === undefined) continue;
    const spec = SETTABLE[key];
    const [column, transform] = Array.isArray(spec) ? spec : [spec, null];
    columns.push(column);
    params.push(transform && value !== null ? transform(value) : value);
  }

  const { rows } = await pgQuery(
    `INSERT INTO order_states (${columns.join(', ')})
     VALUES (${params.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT (order_id) DO NOTHING
     RETURNING *`,
    params, 'order_create_record',
  );
  return rows[0] ? toOrder(rows[0]) : getOrderRecord(orderId);
}

/**
 * Tokens a player already has committed to withdrawals in flight.
 *
 * A READ, for showing the player why a figure looks lower than they expect. It
 * is NOT the admission gate — the escrow debit is, because it decides under the
 * wallet row lock. See `createWithdrawalOrder`.
 */
/**
 * COMPLETED orders whose accounting event was never posted.
 *
 * The reconciliation the revenue service walks: money moved, the ledger does
 * not know. It is a LEFT JOIN with a NULL test rather than a per-order lookup —
 * the document version did a `$lookup` inside an aggregate and could only ever
 * answer for one collection at a time, which is why it was duplicated per
 * source and why both copies referenced models that no longer exist.
 *
 * Ordered oldest-first, because the oldest gap is the one that has been
 * misreporting revenue for longest.
 */
export async function findCompletedOrdersMissingEvents({ limit = 200 } = {}) {
  const { rows } = await pgQuery(
    `SELECT o.* FROM order_states o
       LEFT JOIN accounting_events e
         ON e.ref_model = 'PaymentOrder' AND e.ref_id = o.order_id
      WHERE o.state = 'COMPLETED'
        AND o.order_type IN ('DEPOSIT', 'WITHDRAWAL')
        AND e.id IS NULL
      ORDER BY o.created_at ASC
      LIMIT ${Math.min(Math.max(Number(limit) || 200, 1), 1000)}`,
    [], 'order_missing_accounting_event',
  );
  return rows.map(toOrder);
}

export async function pendingWithdrawalTotal(userId) {
  const { rows } = await pgQuery(
    `SELECT COALESCE(SUM(token_amount_paise), 0) AS total
       FROM order_states
      WHERE user_id = $1 AND order_type = 'WITHDRAWAL'
        AND state IN ('PENDING_QUEUE', 'ASSIGNED', 'PROCESSING', 'PAID')`,
    [String(userId)], 'order_pending_withdrawal_total',
  );
  return rupees(rows[0].total);
}

/**
 * Set detail on an order.
 *
 * Refuses an unknown field rather than dropping it. The document model
 * discarded a write to an undeclared path and reported success — a rejection
 * that recorded no reviewer, a counter that incremented nothing.
 */
export async function setOrderFields(orderId, patch = {}) {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!entries.length) return getOrderRecord(orderId);

  const unknown = entries.map(([k]) => k).filter((k) => !SETTABLE[k]);
  if (unknown.length) {
    throw new Error(
      `setOrderFields: refusing to write unknown or protected field(s): ${unknown.join(', ')}.`
      + ' A state change goes through the lifecycle module, not here.',
    );
  }

  const sets = []; const params = [String(orderId)];
  for (const [key, value] of entries) {
    const spec = SETTABLE[key];
    const [column, transform] = Array.isArray(spec) ? spec : [spec, null];
    params.push(transform && value !== null ? transform(value) : value);
    sets.push(`${column} = $${params.length}`);
  }

  const { rows } = await pgQuery(
    `UPDATE order_states SET ${sets.join(', ')}, updated_at = now()
      WHERE order_id = $1 RETURNING *`,
    params, 'order_set_fields',
  );
  return toOrder(rows[0]);
}

export async function getOrderRecord(orderId) {
  if (!orderId) return null;
  const { rows } = await pgQuery(
    'SELECT * FROM order_states WHERE order_id = $1', [String(orderId)], 'order_record_get',
  );
  return toOrder(rows[0]);
}

/** Several orders in one round trip. */
export async function getOrderRecords(orderIds = []) {
  const ids = [...new Set(orderIds.filter(Boolean).map(String))];
  if (!ids.length) return [];
  const { rows } = await pgQuery(
    'SELECT * FROM order_states WHERE order_id = ANY($1::text[])', [ids], 'order_record_many',
  );
  return rows.map(toOrder);
}

/**
 * Search orders.
 *
 * Keyset pagination on `(created_at, order_id)`. Not OFFSET: an order placed
 * while an admin pages through the queue shifts every later row by one, and the
 * page after it silently skips an order that is waiting on someone.
 */
export async function findOrders({
  userId = null, merchantId = null, state = null, states = null,
  orderType = null, currency = null, since = null, until = null,
  redFlagged = null, requiresReview = null, disputedOnly = false,
  limit = 50, cursor = null, offset = 0,
} = {}) {
  const where = []; const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('$?', `$${params.length}`)); };

  if (userId) add('user_id = $?', String(userId));
  if (merchantId) add('merchant_id = $?', String(merchantId));
  if (state) add('state = $?', String(state));
  if (states?.length) add('state = ANY($?::text[])', states.map(String));
  if (orderType) add('order_type = $?', String(orderType));
  if (currency) add('currency = $?', String(currency));
  if (since) add('created_at >= $?', since);
  if (until) add('created_at <= $?', until);
  if (redFlagged !== null && redFlagged !== undefined) {
    where.push(redFlagged ? 'red_flagged' : 'NOT red_flagged');
  }
  if (requiresReview !== null && requiresReview !== undefined) {
    where.push(requiresReview ? 'requires_review' : 'NOT requires_review');
  }
  if (disputedOnly) where.push("state = 'DISPUTED'");
  if (cursor?.createdAt && cursor?.orderId) {
    params.push(cursor.createdAt, String(cursor.orderId));
    where.push(`(created_at, order_id) < ($${params.length - 1}, $${params.length})`);
  }

  const size = Math.min(Math.max(Number(limit) || 50, 1), 500);
  // OFFSET is supported for the player's own order history, where the client
  // sends skip/limit and a page is a page. A KEYSET cursor is still the right
  // tool for anything long — an order created while somebody pages shifts every
  // later row by one, and the page after it silently skips an order — so both
  // are here and `cursor` wins when given.
  const skip = cursor ? 0 : Math.max(Number(offset) || 0, 0);
  const { rows } = await pgQuery(
    `SELECT *, COUNT(*) OVER () AS total_count FROM order_states
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, order_id DESC
      LIMIT ${size + 1} OFFSET ${skip}`,
    params, 'order_find',
  );

  const hasMore = rows.length > size;
  const page = rows.slice(0, size);
  const last = page[page.length - 1];
  return {
    orders: page.map(toOrder),
    total: rows[0] ? Number(rows[0].total_count) : 0,
    nextCursor: hasMore && last
      ? { createdAt: last.created_at, orderId: last.order_id } : null,
  };
}

/**
 * Held withdrawals whose hold window has passed.
 *
 * ── The clock is the database's ─────────────────────────────────────────────
 * `merchant_credit_hold_until <= now()`, evaluated where the column lives.
 * Several worker instances comparing against their own `new Date()` disagree by
 * however far their clocks have drifted, and this decides when a merchant's
 * tokens become spendable.
 *
 * Oldest deadline first: a hold that expired an hour ago has a player waiting.
 */
/**
 * The admin payment queue: orders grouped by state, with the parties named.
 *
 * ── The join replaces two populates ────────────────────────────────────────
 * The route this serves called `.populate('userId', …)` and
 * `.populate('merchantId', …)` on plain rows — a TypeError — and before that
 * shape the populates were two extra round trips per page. One statement names
 * both parties.
 *
 * ── The counts come from the same rows as the list ─────────────────────────
 * The route derived its per-state counts by filtering the array it had just
 * fetched, which sounds consistent and is not: the array is CAPPED at 200, so
 * every count was "how many of the most recent 200", presented as the queue
 * depth. A queue with 900 pending orders reported 200 and looked calm.
 *
 * `COUNT(*) FILTER` over the whole table gives the real depths; the list stays
 * capped because a page is a page.
 */
export async function paymentQueue({ state = null, limit = 200 } = {}) {
  const params = [];
  let filter = '';
  if (state && state !== 'all') { params.push(String(state)); filter = 'WHERE o.state = $1'; }

  const size = Math.min(Math.max(Number(limit) || 200, 1), 500);
  params.push(size);

  const [{ rows }, { rows: counts }] = await Promise.all([
    pgQuery(
      `SELECT o.*,
              u.username AS user_username, u.mobile AS user_mobile,
              u.kyc_status AS user_kyc_status,
              m.name AS merchant_name, m.mobile AS merchant_mobile
         FROM order_states o
         LEFT JOIN users u     ON u.user_id = o.user_id
         LEFT JOIN merchants m ON m.merchant_id = o.merchant_id
        ${filter}
        ORDER BY o.created_at DESC
        LIMIT $${params.length}`,
      params, 'orders_payment_queue',
    ),
    pgQuery(
      `SELECT state, COUNT(*)::int AS n FROM order_states GROUP BY state`,
      [], 'orders_payment_queue_counts',
    ),
  ]);

  const byState = Object.fromEntries(counts.map((r) => [r.state, r.n]));
  const orders = rows.map((r) => ({
    ...toOrder(r),
    // A LEFT JOIN, so an order survives a party row that is gone. The money
    // moved; losing the order because an account was deleted would put a hole
    // in the queue an operator has to work.
    user: r.user_username
      ? { userId: r.user_id, username: r.user_username, mobile: r.user_mobile, kycStatus: r.user_kyc_status }
      : null,
    merchant: r.merchant_name
      ? { merchantId: r.merchant_id, name: r.merchant_name, mobile: r.merchant_mobile }
      : null,
  }));

  return {
    orders,
    grouped: {
      pending:    orders.filter((o) => o.status === 'PENDING_QUEUE'),
      assigned:   orders.filter((o) => o.status === 'ASSIGNED'),
      processing: orders.filter((o) => o.status === 'PROCESSING'),
      paid:       orders.filter((o) => o.status === 'PAID'),
      disputed:   orders.filter((o) => o.status === 'DISPUTED'),
      completed:  orders.filter((o) => o.status === 'COMPLETED'),
    },
    // Real depths, over every order — not "how many of the most recent 200".
    stats: {
      pending:    byState.PENDING_QUEUE ?? 0,
      assigned:   byState.ASSIGNED ?? 0,
      processing: byState.PROCESSING ?? 0,
      paid:       byState.PAID ?? 0,
      disputed:   byState.DISPUTED ?? 0,
      completed:  byState.COMPLETED ?? 0,
      total:      counts.reduce((sum, r) => sum + r.n, 0),
      listed:     orders.length,
    },
  };
}

/**
 * The dispute queue, with both parties named.
 *
 * `status: 'ALL'` means "everything that has ever been disputed", not
 * "everything" — a resolved dispute is still a dispute, and the admin screen
 * that reviews decisions needs the ones that are closed.
 *
 * The page and its total come from ONE statement. The two concurrent reads this
 * replaced could report a page of fifty against a total taken a moment later,
 * which on a queue people are actively working is how a paginator grows a page
 * that is not there.
 */
export async function disputeQueue({ status = 'DISPUTED', page = 1, limit = 50 } = {}) {
  const params = [];
  let filter;
  if (status === 'ALL') {
    // Currently disputed, OR carrying the marks of a dispute that was settled.
    filter = `(o.state = 'DISPUTED' OR o.dispute_raised_at IS NOT NULL
               OR COALESCE(o.dispute_reason, '') <> '')`;
  } else {
    params.push(String(status));
    filter = `o.state = $${params.length}`;
  }

  const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const wanted = Math.max(Number(page) || 1, 1);
  params.push(size, (wanted - 1) * size);

  const { rows } = await pgQuery(
    `SELECT o.*,
            u.username AS user_username, u.mobile AS user_mobile,
            u.kyc_status AS user_kyc_status,
            m.name AS merchant_name, m.mobile AS merchant_mobile,
            COUNT(*) OVER () AS total_matching
       FROM order_states o
       LEFT JOIN users u     ON u.user_id = o.user_id
       LEFT JOIN merchants m ON m.merchant_id = o.merchant_id
      WHERE ${filter}
      -- Newest dispute first, falling back to creation for an order whose
      -- dispute timestamp predates the column.
      ORDER BY COALESCE(o.dispute_raised_at, o.created_at) DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params, 'orders_dispute_queue',
  );

  const total = rows.length ? Number(rows[0].total_matching) : 0;
  return {
    disputes: rows.map((r) => ({
      ...toOrder(r),
      user: r.user_username
        ? { userId: r.user_id, username: r.user_username, mobile: r.user_mobile, kycStatus: r.user_kyc_status }
        : null,
      merchant: r.merchant_name
        ? { merchantId: r.merchant_id, name: r.merchant_name, mobile: r.merchant_mobile }
        : null,
    })),
    total, page: wanted, limit: size,
    pages: Math.max(Math.ceil(total / size), 1),
  };
}

/** One order with both parties named — the dispute detail screen's read. */
export async function getOrderWithParties(orderId) {
  const { rows } = await pgQuery(
    `SELECT o.*,
            u.username AS user_username, u.mobile AS user_mobile,
            u.kyc_status AS user_kyc_status,
            m.name AS merchant_name, m.mobile AS merchant_mobile
       FROM order_states o
       LEFT JOIN users u     ON u.user_id = o.user_id
       LEFT JOIN merchants m ON m.merchant_id = o.merchant_id
      WHERE o.order_id = $1`,
    [String(orderId)], 'order_with_parties',
  );
  const r = rows[0];
  if (!r) return null;
  return {
    ...toOrder(r),
    user: r.user_username
      ? { userId: r.user_id, username: r.user_username, mobile: r.user_mobile, kycStatus: r.user_kyc_status }
      : null,
    merchant: r.merchant_name
      ? { merchantId: r.merchant_id, name: r.merchant_name, mobile: r.merchant_mobile }
      : null,
  };
}

/**
 * Drop expired payment-proof images, keeping the orders they belong to.
 *
 * The proof is a high-volume screenshot; the ORDER is the financial record and
 * is never deleted. Two columns are cleared, in one statement, so an order
 * cannot end up with a cleared expiry and a proof still attached — which is a
 * proof nothing will ever come back for.
 *
 * Returns how many were scrubbed. A retention sweep that cannot say what it did
 * is one nobody notices has stopped running.
 */
export async function scrubExpiredProofs() {
  const { rowCount } = await pgQuery(
    `UPDATE order_states
        SET proof_screenshot = NULL, proof_expires_at = NULL, updated_at = now()
      WHERE proof_expires_at IS NOT NULL
        AND proof_expires_at <= now()
        AND proof_screenshot IS NOT NULL`,
    [], 'orders_scrub_proofs',
  );
  return rowCount;
}

export async function findDueHolds({ limit = 200 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM order_states
      WHERE merchant_credit_status = 'HELD'
        AND merchant_credit_hold_until IS NOT NULL
        AND merchant_credit_hold_until <= now()
      ORDER BY merchant_credit_hold_until ASC
      LIMIT ${Math.min(Math.max(Number(limit) || 200, 1), 500)}`,
    [], 'order_find_due_holds',
  );
  return rows.map(toOrder);
}

/**
 * Write a settlement's committed state onto the order it settles.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * A function whose body a codemod had reduced to `return}` — it wrote nothing.
 * The settlement committed, the player's stake was consumed and the merchant
 * credited, and the ORDER never advanced: it stayed HELD, so the sweep offered
 * it again on every pass, forever, after the money had already moved. A
 * settlement is idempotent so nothing was paid twice, but the order never
 * completed and the queue never drained.
 *
 * ONE STATEMENT per outcome, and the terminal state is in the WHERE clause's
 * gift rather than assembled by the caller: a mirror that can write half of a
 * settled order is a mirror that can leave `merchant_credit_status = RELEASED`
 * beside `state = ASSIGNED`.
 */
export async function mirrorSettlementState(orderId, settlementStatus, { reason = null, actor = null } = {}) {
  const OUTCOME = {
    SETTLED:   { credit: 'RELEASED', state: 'COMPLETED', escrow: false },
    CANCELLED: { credit: 'REVERSED', state: 'DISPUTED',  escrow: false },
    REVERSED:  { credit: 'REVERSED', state: 'DISPUTED',  escrow: false },
    RESERVED:  { credit: 'HELD',     state: null,        escrow: true  },
  }[String(settlementStatus).toUpperCase()];
  if (!OUTCOME) throw new Error(`mirrorSettlementState: unknown settlement status '${settlementStatus}'`);

  const { rows } = await pgQuery(
    `UPDATE order_states SET
       merchant_credit_status = $2,
       escrow_locked = $3,
       state = COALESCE($4, state),
       completed_at = CASE WHEN $4 = 'COMPLETED' THEN now() ELSE completed_at END,
       merchant_credit_reversed_at = CASE
         WHEN $2 = 'REVERSED' THEN COALESCE(merchant_credit_reversed_at, now())
         ELSE merchant_credit_reversed_at END,
       merchant_credit_reversed_reason = COALESCE($5, merchant_credit_reversed_reason),
       dispute_resolved_by = COALESCE($6, dispute_resolved_by),
       updated_at = now()
     WHERE order_id = $1
     RETURNING *`,
    [String(orderId), OUTCOME.credit, OUTCOME.escrow, OUTCOME.state,
      reason === null ? null : String(reason).slice(0, 500),
      actor === null ? null : String(actor)],
    'order_mirror_settlement',
  );
  return toOrder(rows[0]);
}

/**
 * The queue manager's worklist: orders waiting for a merchant, oldest first,
 * with the player's identity attached.
 *
 * ── One query, not one per row ──────────────────────────────────────────────
 * The document version used `.populate('userId', …)`, which is a second round
 * trip per page and silently yields `null` for a player who has since been
 * deleted — the mapping then fell back to the string 'Unknown', so an order
 * belonging to a removed account looked like a data problem rather than a
 * closed account. A LEFT JOIN says which it is: the columns come back null and
 * the caller can tell the difference.
 *
 * Oldest first, because the queue manager works a queue and the order that has
 * waited longest is the one a player is complaining about.
 */
export async function queuePendingOrders({ limit = 50 } = {}) {
  const { rows } = await pgQuery(
    `SELECT o.*, u.username, u.mobile, u.kyc_status, u.bank_details
       FROM order_states o
       LEFT JOIN users u ON u.user_id = o.user_id
      WHERE o.state = 'PENDING_QUEUE'
      ORDER BY o.created_at ASC
      LIMIT ${Math.min(Math.max(Number(limit) || 50, 1), 200)}`,
    [], 'order_queue_pending',
  );
  return rows.map((r) => ({
    ...toOrder(r),
    userName: r.username ?? null,
    userMobile: r.mobile ?? null,
    userKycStatus: r.kyc_status ?? null,
    userBankDetails: r.bank_details ?? null,
  }));
}

/**
 * One order, scoped to the merchant who holds it.
 *
 * The ownership check is in the WHERE clause, not a comparison after the fetch.
 * That is an authorisation boundary: a merchant must not be able to read
 * another merchant's order by guessing an id, and a fetch-then-compare has
 * already loaded the row — including the player's bank details — before it
 * decides whether the caller was allowed to see them.
 */
export async function getMerchantOrder(orderId, merchantId) {
  if (!orderId || !merchantId) return null;
  const { rows } = await pgQuery(
    'SELECT * FROM order_states WHERE order_id = $1 AND merchant_id = $2',
    [String(orderId), String(merchantId)], 'order_get_for_merchant',
  );
  return toOrder(rows[0]);
}

/** One order by its UTR — the reconciliation lookup. */
export async function findOrderByUtr(utr) {
  const { rows } = await pgQuery(
    'SELECT * FROM order_states WHERE utr = $1', [String(utr)], 'order_by_utr',
  );
  return toOrder(rows[0]);
}

/**
 * Claim a UTR for an order.
 *
 * Two writes in one statement: the registry row that makes the reference unique
 * platform-wide, and the order's own column. A bank reference reused across two
 * orders is a mistake or a fraud attempt, and both are refused by the primary
 * key rather than by a pre-read two submissions can both pass.
 */
export async function claimUtr({ utr, orderId, userId = null, amountRupees = null }) {
  try {
    const { rows } = await pgQuery(
      `WITH registered AS (
         INSERT INTO utr_registry (utr, order_id, user_id, amount_paise)
         VALUES ($1, $2, $3, $4) RETURNING utr
       )
       UPDATE order_states SET utr = $1, updated_at = now()
        WHERE order_id = $2 AND EXISTS (SELECT 1 FROM registered)
        RETURNING *`,
      [String(utr), String(orderId), userId,
        amountRupees === null ? null : rupeesToPaise(amountRupees)],
      'order_claim_utr',
    );
    return rows[0] ? { ok: true, order: toOrder(rows[0]) } : { ok: false, reason: 'ORDER_NOT_FOUND' };
  } catch (e) {
    if (e.code === '23505') {
      const existing = await findOrderByUtr(utr);
      return existing?.orderId === String(orderId)
        ? { ok: true, idempotent: true, order: existing }
        : { ok: false, reason: 'UTR_ALREADY_USED', usedByOrderId: existing?.orderId ?? null };
    }
    throw e;
  }
}

/** Release a UTR — an admin correcting a mistyped reference. */
export async function releaseUtr(utr, orderId) {
  const { rowCount } = await pgQuery(
    `WITH cleared AS (
       DELETE FROM utr_registry WHERE utr = $1 AND order_id = $2 RETURNING utr
     )
     UPDATE order_states SET utr = NULL, updated_at = now()
      WHERE order_id = $2 AND EXISTS (SELECT 1 FROM cleared)`,
    [String(utr), String(orderId)], 'order_release_utr',
  );
  return rowCount > 0;
}

/**
 * A merchant's withdrawals scheduled for one day's bulk payout.
 *
 * `bulk_payout_date` is a DATE, so the window is a day rather than a
 * timestamp range that has to be built by the caller — three call sites were
 * each computing their own IST midnight, and a difference of one in any of them
 * would have paid a different set of orders.
 */
/**
 * Today's payout date, as the DATABASE reckons it.
 *
 * `bulk_payout_date` is a DATE in IST, and three route handlers each built
 * their own IST midnight from `new Date()`. A server running in UTC is five and
 * a half hours behind, so between 18:30 and midnight UTC each of them could
 * disagree about which day it is — and a batch listed under one date and paid
 * under another pays a different set of orders than the merchant reviewed.
 *
 * There is one owner of that value now, and it is the same clock the column is
 * compared against.
 */
export async function istToday() {
  const { rows } = await pgQuery(
    "SELECT CAST(now() AT TIME ZONE 'Asia/Kolkata' AS DATE) AS today", [], 'order_ist_today',
  );
  // A DATE comes back as a JS Date at local midnight; the ISO date part is the
  // day itself, free of whatever offset the app server happens to run in.
  const d = rows[0].today;
  return d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : String(d);
}

export async function bulkPayoutBatch({ merchantId, payoutDate }) {
  const { rows } = await pgQuery(
    `SELECT * FROM order_states
      WHERE merchant_id = $1
        AND order_type = 'WITHDRAWAL'
        AND state IN ('PAID', 'COMPLETED', 'ASSIGNED', 'PROCESSING')
        AND bulk_payout_date = $2::date
      ORDER BY created_at ASC`,
    [String(merchantId), payoutDate], 'order_bulk_batch',
  );
  return rows.map(toOrder);
}

/**
 * Close a batch of a merchant's withdrawals as paid.
 *
 * ONE STATEMENT, with the eligibility in the WHERE clause: this merchant's
 * withdrawals, in a state a payout may legitimately close. An order that moved
 * between the caller's read and this write matches nothing rather than being
 * closed from a state it has already left — which is what an `updateMany` over
 * ids alone would do.
 *
 * Returns which ids were closed, so the caller can tell the merchant that three
 * of their five went through rather than reporting a count they cannot act on.
 */
export async function bulkCompleteWithdrawals({ orderIds, merchantId, batchId, paidAt = null }) {
  const ids = [...new Set((orderIds || []).filter(Boolean).map(String))];
  if (!ids.length) return { completed: 0, orderIds: [], skipped: [] };

  const { rows } = await pgQuery(
    `UPDATE order_states SET
       state = 'COMPLETED',
       completed_at = COALESCE($4::timestamptz, now()),
       bulk_paid_at = COALESCE($4::timestamptz, now()),
       bulk_payout_batch = $3,
       updated_at = now()
     WHERE order_id = ANY($1::text[])
       AND merchant_id = $2
       AND order_type = 'WITHDRAWAL'
       AND state IN ('PAID', 'ASSIGNED', 'PROCESSING')
     RETURNING order_id`,
    [ids, String(merchantId), String(batchId), paidAt], 'order_bulk_complete',
  );
  const closed = rows.map((r) => r.order_id);
  return {
    completed: closed.length,
    orderIds: closed,
    skipped: ids.filter((id) => !closed.includes(id)),
  };
}

/**
 * Orders that ran out of time.
 *
 * Expiry decided by the READ, not by whether a sweep has run: an order past its
 * window is expired whether or not anything has noticed, and the player is
 * waiting either way.
 */
/**
 * Orders past their deadline, by the DATABASE's clock.
 *
 * `now()` rather than a timestamp the caller computed: three app instances with
 * drifting clocks expiring the same orders is how one gets refunded a minute
 * before its own deadline, and how another sits unexpired past it.
 *
 * There is deliberately NO `FOR UPDATE SKIP LOCKED` here. It was here, and it
 * did nothing: `pgQuery` runs each statement in its own implicit transaction,
 * so the lock is released the moment the SELECT returns and two cron instances
 * still read the same batch. The row lock that matters is the one the
 * TRANSITION takes — the loser gets `idempotent` and skips the refund. Leaving
 * a no-op lock in the query would suggest the coordination lives here, and the
 * next reader would trust it.
 */
export async function findExpiredOrders({ limit = 100 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM order_states
      WHERE expires_at IS NOT NULL AND expires_at <= now()
        AND state IN ('PENDING_QUEUE', 'ASSIGNED', 'PROCESSING')
      ORDER BY expires_at ASC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 100, 1), 500)], 'order_find_expired',
  );
  return rows.map(toOrder);
}

/**
 * What a merchant may see in their queue.
 *
 * Two sets, and they are different in kind: the orders ASSIGNED to them, plus
 * the OPEN withdrawal pool on their own rail — orders nobody holds yet, which
 * any merchant on that rail may claim. Mixing the two in one query is what the
 * panel needs; keeping them separate would make the merchant poll twice and
 * see the pool at a different instant from their own work.
 *
 * The rail filter is not cosmetic: an INR merchant claiming a USDT order cannot
 * settle it, and the player waits for a payment that will never come.
 */
export async function merchantVisibleOrders({
  merchantId, rail = 'INR', state = null, orderType = null,
  limit = 50, offset = 0,
}) {
  const params = [String(merchantId), String(rail)];
  const filters = [];
  if (state) { params.push(String(state)); filters.push(`state = $${params.length}`); }
  if (orderType) { params.push(String(orderType)); filters.push(`order_type = $${params.length}`); }

  const size = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const skip = Math.max(Number(offset) || 0, 0);

  const { rows } = await pgQuery(
    `SELECT *, COUNT(*) OVER () AS total_count FROM order_states
      WHERE (
              merchant_id = $1
              OR (merchant_id IS NULL AND order_type = 'WITHDRAWAL'
                  AND state = 'PENDING_QUEUE' AND currency = $2)
            )
        ${filters.length ? `AND ${filters.join(' AND ')}` : ''}
      ORDER BY created_at DESC, order_id DESC
      LIMIT ${size} OFFSET ${skip}`,
    params, 'order_merchant_visible',
  );
  return {
    orders: rows.map(toOrder),
    total: rows[0] ? Number(rows[0].total_count) : 0,
  };
}

/** What a merchant is currently working. */
export async function merchantOpenOrders(merchantId) {
  const { rows } = await pgQuery(
    `SELECT * FROM order_states
      WHERE merchant_id = $1 AND state IN ('ASSIGNED', 'PROCESSING', 'PAID', 'DISPUTED')
      ORDER BY created_at ASC`,
    [String(merchantId)], 'order_merchant_open',
  );
  return rows.map(toOrder);
}

/**
 * How many funding orders a player has created in a window.
 *
 * The velocity gate. Any status counts — cancellation churn IS velocity, and a
 * player who creates and cancels twenty orders an hour is doing the thing this
 * limit exists to catch, whatever the orders ended up as.
 *
 * The window is measured by the DATABASE's clock, not the app server's: several
 * instances each subtracting an hour from their own `new Date()` disagree by
 * however far their clocks have drifted, and this decides whether a player is
 * refused.
 */
export async function countRecentOrders(userId, { withinMinutes = 60 } = {}) {
  const { rows } = await pgQuery(
    `SELECT COUNT(*)::int AS n FROM order_states
      WHERE user_id = $1
        AND created_at >= now() - ($2 || ' minutes')::interval`,
    [String(userId), String(Math.max(Number(withinMinutes) || 60, 1))],
    'order_recent_count',
  );
  return rows[0].n;
}

/**
 * Per-merchant matched volume: the smaller of what they took in and what they
 * paid out, which is what a completed buy→sell cycle actually is.
 *
 * The bonus engine pays on this figure, so it is computed in one statement over
 * completed orders rather than assembled from two aggregates and a loop that
 * defaulted the side it did not find.
 */
export async function merchantMatchedVolumes() {
  const { rows } = await pgQuery(
    `SELECT merchant_id,
            COALESCE(SUM(fiat_amount_paise) FILTER (WHERE order_type = 'DEPOSIT'), 0)    AS deposit_paise,
            COALESCE(SUM(fiat_amount_paise) FILTER (WHERE order_type = 'WITHDRAWAL'), 0) AS withdrawal_paise
       FROM order_states
      WHERE state = 'COMPLETED' AND merchant_id IS NOT NULL
        AND order_type IN ('DEPOSIT', 'WITHDRAWAL')
      GROUP BY merchant_id`,
    [], 'order_merchant_matched_volumes',
  );
  const out = {};
  for (const r of rows) {
    const depositMinor = Number(r.deposit_paise);
    const withdrawalMinor = Number(r.withdrawal_paise);
    out[r.merchant_id] = {
      depositMinor, withdrawalMinor,
      matchedMinor: Math.min(depositMinor, withdrawalMinor),
    };
  }
  return out;
}

/** Counts for the admin dashboard, in one pass. */
export async function orderCounts({ since = null } = {}) {
  const { rows } = await pgQuery(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE state = 'PENDING_QUEUE')::int AS pending,
       COUNT(*) FILTER (WHERE state IN ('ASSIGNED','PROCESSING','PAID'))::int AS active,
       COUNT(*) FILTER (WHERE state = 'COMPLETED')::int AS completed,
       COUNT(*) FILTER (WHERE state = 'DISPUTED')::int AS disputed,
       COUNT(*) FILTER (WHERE red_flagged)::int AS flagged,
       COUNT(*) FILTER (WHERE requires_review)::int AS awaiting_review,
       COALESCE(SUM(token_amount_paise) FILTER (WHERE state = 'COMPLETED'), 0) AS completed_paise
     FROM order_states
     ${since ? 'WHERE created_at >= $1' : ''}`,
    since ? [since] : [], 'order_counts',
  );
  const r = rows[0];
  return {
    total: r.total, pending: r.pending, active: r.active,
    completed: r.completed, disputed: r.disputed,
    flagged: r.flagged, awaitingReview: r.awaiting_review,
    completedValue: rupees(r.completed_paise),
  };
}
