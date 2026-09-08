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
import { stampForNewOrder } from './paymentModePolicy.js';

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
    rejectionProofUrl: r.rejection_proof_url,
    cancelReason: r.cancel_reason, cancelledAt: r.cancelled_at,
    warningIssued: r.warning_issued,
    paidAt: r.paid_at, completedAt: r.completed_at, expiresAt: r.expires_at,
    bulkPayoutDate: r.bulk_payout_date, bulkPaidAt: r.bulk_paid_at,
    bulkPayoutBatch: r.bulk_payout_batch,

    // The tamper-evidence tag, READ-ONLY. It is written once by `openOrder`
    // with the row and never updated, and `SETTABLE` below deliberately does
    // not name it, so no caller can rewrite it.
    //
    // This mapper omitted it while `orders.core.js`'s did, which meant
    // `orderAccessGuard` — reading the full record so handlers get every field
    // they render — saw `undefined` and skipped the verification entirely. The
    // guard was mounted, the check was there, and it silently never ran. Its
    // test is what found this.
    orderHmac: r.order_hmac ?? null,

    // The rail this order was BORN on — not the rail that is live now. Every
    // worker and every screen branches on this: after a switch both rails run
    // side by side until the last pre-flip order settles.
    paymentMode: r.payment_mode,
    paymentModeVersion: r.payment_mode_version === null ? null : Number(r.payment_mode_version),
    // The ATM link serving this order, on the cash rail. The id only — the
    // link itself lives in `cash_link_queue` and is resolved for the ORDER'S
    // OWNER alone, because it is a claim on notes about to leave a machine.
    cashLinkId: r.cash_link_id ?? null,

    // ── The CDM receipt is NOT mapped here, on purpose ────────────────────
    // `cdm_transaction_id`, `cdm_receipt_url` and `cdm_receipt_at` are absent
    // from this object and must stay absent. Every projection on this platform
    // — the merchant view, the player's order read, the admin panel — is built
    // from this mapper, so a field it does not name cannot reach any of them.
    // That is what makes the receipt write-only BY CONSTRUCTION rather than by
    // each reader remembering to strip it, which is the shape that fails open.
    //
    // `getCdmReceipt` is the one way to read it, and the admin route gated on
    // canResolveDisputes is its only caller. Adding these three lines here
    // would hand a CDM slip — account number, branch, timestamp — to the
    // merchant who uploaded it and to the player, and nothing would fail.

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
  rejectedBy: 'rejected_by',
  rejectionProofUrl: 'rejection_proof_url', rejectedAt: 'rejected_at',
  cancelReason: 'cancel_reason', cancelledAt: 'cancelled_at',
  warningIssued: 'warning_issued',
  paidAt: 'paid_at', completedAt: 'completed_at', expiresAt: 'expires_at',
  bulkPayoutDate: 'bulk_payout_date', bulkPaidAt: 'bulk_paid_at',
  bulkPayoutBatch: 'bulk_payout_batch',

  // The CDM receipt. WRITABLE here and deliberately absent from `toOrder`
  // below: a merchant submits it, and only an admin or a disputes manager may
  // ever read it back. See `getCdmReceipt`.
  cdmTransactionId: 'cdm_transaction_id',
  cdmReceiptUrl: 'cdm_receipt_url',
  cdmReceiptAt: 'cdm_receipt_at',
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
  state = 'PENDING_QUEUE',
  // The rail to stamp on this order, for tests that need to build one on a
  // rail other than the live policy's. Deliberately NOT part of `detail`: it
  // is not a SETTABLE field, because nothing may update it afterwards.
  //
  // A MODE string ('CASH_ATM'), not a policy object. It used to be handed to a
  // `stampForNewOrder` that read `.activeMode` off it, so every value passed
  // here was silently discarded and the order opened on the live rail instead —
  // a cash-rail fixture that was in fact a UPI order. `stampForNewOrder` now
  // takes the mode and throws on one it does not know.
  paymentMode = null,
  ...detail
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

  // ── The rail this order is born on, snapshotted here and nowhere else ─────
  // Read HERE rather than taken from the caller. A parameter every caller must
  // remember is a parameter one caller forgets, and the failure is silent: the
  // column has a DEFAULT, so a forgotten snapshot produces a P2P_UPI order on
  // a CASH_ATM platform that looks exactly like a correct one.
  //
  // The row is immutable afterwards (order_states_mode_immutable), so an admin
  // switching rails mid-flight cannot change what this order is running under.
  const stamp = await stampForNewOrder(paymentMode);
  const columns = ['order_id', 'user_id', 'order_type', 'state', 'token_amount_paise', 'fiat_amount_paise',
    'payment_mode', 'payment_mode_version'];
  const params = [String(orderId), String(userId), type, state, tokenPaise, rupeesToPaise(fiatAmountRupees),
    stamp.mode, stamp.version];

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

/**
 * Deposits this player already has in flight, on one currency.
 *
 * A COUNT of rows, not an accumulator: the number is reconstructed from the
 * orders themselves every time it is asked for, so a crash mid-flow cannot
 * leave a player permanently unable to buy with a counter nothing can correct.
 *
 * The states are the ones where the player still owes or is owed something.
 * CANCELLED, FAILED, REJECTED and COMPLETED are finished and must not block a
 * new purchase — a player whose order failed has to be able to try again.
 */
/**
 * The CDM receipt for one order — the ONLY way to read it.
 *
 * Separate from `getOrderRecord` because the answer must not travel with the
 * order. `toOrder` does not map these columns, so no existing projection can
 * carry them; this query is the deliberate exception, and its only caller is
 * the admin route gated on `canResolveDisputes`.
 *
 * Returns null when nothing has been submitted, which is a real and expected
 * state: the merchant's confirm completes the order and the receipt is chased
 * afterwards, so an order can legitimately be settled with none yet.
 */
export async function getCdmReceipt(orderId) {
  const { rows } = await pgQuery(
    `SELECT order_id, merchant_id, cdm_transaction_id, cdm_receipt_url, cdm_receipt_at
       FROM order_states WHERE order_id = $1`,
    [String(orderId)], 'order_cdm_receipt',
  );
  const r = rows[0];
  if (!r || !r.cdm_receipt_url) return null;
  return {
    orderId: r.order_id,
    merchantId: r.merchant_id,
    transactionId: r.cdm_transaction_id,
    receiptUrl: r.cdm_receipt_url,
    submittedAt: r.cdm_receipt_at,
  };
}

/**
 * Settled cash withdrawals whose receipt never arrived.
 *
 * The merchant's confirm completes the order and the receipt is chased after —
 * so a missing one does not block the player, and nothing would otherwise
 * notice it was never sent. This is what makes that pattern visible: a merchant
 * appearing here repeatedly is asserting payments they are not evidencing.
 */
export async function withdrawalsMissingCdmReceipt({ olderThanMinutes = 60, limit = 200 } = {}) {
  const { rows } = await pgQuery(
    `SELECT order_id, merchant_id, user_id, token_amount_paise, completed_at
       FROM order_states
      WHERE order_type = 'WITHDRAWAL'
        AND payment_mode = 'CASH_ATM'
        AND cdm_receipt_url IS NULL
        AND completed_at IS NOT NULL
        AND completed_at < now() - make_interval(mins => $1)
      ORDER BY completed_at ASC
      LIMIT ${Math.min(Math.max(Number(limit) || 200, 1), 1000)}`,
    [Math.max(Number(olderThanMinutes) || 0, 0)], 'orders_missing_cdm_receipt',
  );
  return rows.map((r) => ({
    orderId: r.order_id,
    merchantId: r.merchant_id,
    userId: r.user_id,
    tokenAmount: rupees(r.token_amount_paise),
    completedAt: r.completed_at,
  }));
}

/**
 * The receipts THIS merchant still owes.
 *
 * The admin query above answers "who is not evidencing their payouts". This
 * answers the merchant's own half of it: which of my completed cash payouts
 * still needs a slip. Without it the receipt can only ever be submitted in the
 * seconds after the confirm — a merchant whose upload failed, or who did not
 * have the slip in hand yet, has no way back to the order, and the admin queue
 * fills with items nobody can clear.
 *
 * Deliberately NOT built on `toOrder`: three columns, chosen here, and the
 * player is not one of them. There is no `user_id` in this result because a
 * list of "things you owe paperwork for" is not an occasion to re-identify the
 * people involved.
 *
 * `cdm_receipt_url` is read only as IS NULL. The merchant learns whether they
 * still owe a receipt, never what a submitted one contains — the slip stays
 * unreadable to them the moment it is stored.
 */
export async function merchantWithdrawalsMissingCdmReceipt(merchantId, { limit = 50 } = {}) {
  const { rows } = await pgQuery(
    `SELECT order_id, fiat_amount_paise, completed_at
       FROM order_states
      WHERE merchant_id = $1
        AND order_type = 'WITHDRAWAL'
        AND payment_mode = 'CASH_ATM'
        AND cdm_receipt_url IS NULL
        AND completed_at IS NOT NULL
      ORDER BY completed_at ASC
      LIMIT ${Math.min(Math.max(Number(limit) || 50, 1), 200)}`,
    [String(merchantId)], 'merchant_orders_missing_cdm_receipt',
  );
  return rows.map((r) => ({
    orderId: r.order_id,
    fiatAmount: rupees(r.fiat_amount_paise),
    completedAt: r.completed_at,
  }));
}

export async function countOpenDeposits(userId, { currency = 'INR' } = {}) {
  const { rows } = await pgQuery(
    `SELECT COUNT(*)::int AS n
       FROM order_states
      WHERE user_id = $1
        AND order_type = 'DEPOSIT'
        AND currency = $2
        AND state IN ('PENDING_QUEUE', 'ASSIGNED', 'PROCESSING', 'PAID')`,
    [String(userId), String(currency)], 'order_open_deposits_for_user',
  );
  return rows[0]?.n ?? 0;
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

/**
 * The transitions an order went through, oldest first.
 *
 * The audit walk an order-history screen shows and a test asserts on: each row
 * carries the states it moved between and the ledger key it produced, so an
 * auditor can step from a status change to the accounting entry behind it
 * without guessing at a key format. A READ of the append-only history — it
 * writes nothing.
 */
export async function listOrderTransitions(orderId) {
  if (!orderId) return [];
  const { rows } = await pgQuery(
    `SELECT id, tx_id, from_state, to_state, actor, reason, ledger_key, created_at
       FROM order_transitions WHERE order_id = $1 ORDER BY id ASC`,
    [String(orderId)], 'order_list_transitions',
  );
  return rows.map((r) => ({
    id: Number(r.id), txId: r.tx_id,
    fromState: r.from_state, toState: r.to_state,
    actor: r.actor, reason: r.reason,
    ledgerKey: r.ledger_key, createdAt: r.created_at,
  }));
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

/*
 * bulkCompleteWithdrawals was REMOVED 2026-09-08.
 *
 * It was one raw UPDATE straight to `state = 'COMPLETED'`, and it bypassed
 * every guarantee the single confirm provides: no `order_transitions` row, no
 * escrow flags, and no withdrawal HOLD — so the settlement worker never picked
 * the orders up. They read COMPLETED while the player's stake stayed locked and
 * the merchant's tokens were never credited, with nothing looking for the gap.
 *
 * A bulk payout is N confirms, not a different operation, so the route now
 * loops through the same lifecycle calls `POST /merchant/confirm/:id` makes.
 * The state machine is the one owner of a state change; a second writer that
 * sets `state` directly is how the two came apart in the first place.
 */


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
