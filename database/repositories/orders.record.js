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
  limit = 50, cursor = null,
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
  const { rows } = await pgQuery(
    `SELECT *, COUNT(*) OVER () AS total_count FROM order_states
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, order_id DESC
      LIMIT ${size + 1}`,
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
 * Orders that ran out of time.
 *
 * Expiry decided by the READ, not by whether a sweep has run: an order past its
 * window is expired whether or not anything has noticed, and the player is
 * waiting either way.
 */
export async function findExpiredOrders({ limit = 100 } = {}) {
  const { rows } = await pgQuery(
    `SELECT * FROM order_states
      WHERE expires_at IS NOT NULL AND expires_at <= now()
        AND state IN ('PENDING_QUEUE', 'ASSIGNED', 'PROCESSING')
      ORDER BY expires_at ASC LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [Math.min(Math.max(Number(limit) || 100, 1), 500)], 'order_find_expired',
  );
  return rows.map(toOrder);
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
