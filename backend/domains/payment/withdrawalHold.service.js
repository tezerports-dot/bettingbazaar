// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/payment/withdrawalHold.service.js — the settlement half of a withdrawal.
 *
 * ── The loss this closes ───────────────────────────────────────────────────
 * On a WITHDRAWAL the merchant sends the player fiat and receives tokens.
 * `POST /api/merchant/confirm/:id` used to perform both sides in the same
 * request: `releaseWithdrawal()` consumed the player's locked stake and
 * `creditMerchantTokens()` made the merchant's tokens spendable.
 *
 * Confirm is an ASSERTION by the merchant, not evidence. A merchant who pressed
 * it without sending the money held liquid tokens immediately, and could convert
 * them through a buy order long before the player noticed nothing had arrived.
 * The player's stake was already gone, so the platform absorbed the loss — the
 * dispute process was arriving after the value had left.
 *
 * ── The shape of the fix ───────────────────────────────────────────────────
 * Confirm now records the assertion and freezes BOTH sides for
 * `SystemConfig.withdrawalHoldMinutes`. A worker settles the order when the
 * window passes; a dispute inside the window reverses it instead.
 *
 * Freezing both sides is the point. Holding only the merchant's tokens would
 * leave the player's stake already consumed, so winning a dispute would give
 * them nothing back — the reversal needs something still held on their side to
 * return. The invariant is that until settlement runs, no value has moved: the
 * player's stake is locked (as it has been since order creation) and the
 * merchant's tokens do not exist yet.
 *
 * ── Why a worker and not a timer ───────────────────────────────────────────
 * The hold outlives any single request and must survive a restart, so expiry is
 * a swept database state rather than an in-process timeout. `settleDueHolds` is
 * idempotent and leader-locked by the job platform, so running it twice, or on
 * several instances, settles each order exactly once.
 */
import { db } from '#db';
import { releaseWithdrawal, refundWithdrawal } from '../wallet/walletAuthority.service.js';
import { creditMerchantTokens } from '../merchant/merchantWallet.service.js';
import { emitOrderUpdate, emitAdminUpdate } from '../notification/realtimeEmitters.js';
import { sendAlert } from '../../services/alerting.service.js';
import { rupeesToPaise } from '../../shared/money.js';
import {
  DIRECTIONS, openSettlement, completeSettlement, cancelSettlement, reverseSettlement,
  getSettlement,
} from '#db/repositories/merchantSettlements.js';
import { getSystemConfig } from '#db/repositories/config.js';

/** One deterministic settlement per order, so a retry addresses the same one. */
const settlementIdFor = (order) => `ms_${order.orderId}`;

/** Fallback matches the SystemConfig schema default (60). */
const DEFAULT_HOLD_MINUTES = 60;

/**
 * Admin-configured hold window, in minutes. 0 means settle immediately on
 * confirm (the pre-2026-07-30 behaviour).
 */
export async function holdMinutes() {
  try {
    const cfg = await getSystemConfig();
    const m = cfg?.withdrawalHoldMinutes;
    // schema default: 60 — an explicit 0 is meaningful and must survive.
    if (Number.isFinite(m) && m >= 0 && m <= 1440) return m;
  } catch { /* fall through to the schema default */ }
  return DEFAULT_HOLD_MINUTES;
}

/**
 * Settle one held withdrawal: consume the player's locked stake, credit the
 * merchant, complete the order.
 *
 * ── The gate ────────────────────────────────────────────────────────────────
 * The settlement's own RESERVED → SETTLED guard, in the UPDATE's WHERE clause.
 * Exactly one concurrent caller wins it; every other outcome is a refusal, not
 * a partial settlement. Two sweeps, or a sweep and a dispute, cannot both
 * proceed.
 *
 * ── Ordering, and what compensates a partial failure ────────────────────────
 * The gate has to come FIRST, so the player's stake is consumed after the
 * settlement has already committed. If that release then fails, the settlement
 * is REVERSED: a real recorded movement that takes the tokens back out of the
 * merchant's spendable pocket, not a silent undo. It may legitimately drive the
 * merchant's available balance negative — they may have spent them in the
 * window — and the books end consistent with the player still holding their
 * stake, which is the outcome an auditor can follow.
 *
 * @returns {Promise<boolean>} true when THIS call settled the order.
 */
export async function settleHold(orderId) {
  const order = await db.orders.getOrderRecord(orderId);
  if (!order) return false;

  const settlementId = settlementIdFor(order);
  const existing = await getSettlement(settlementId);

  // Eligibility, not a gate: it decides whether there is anything here to
  // settle, never which of two concurrent callers wins. Once a settlement row
  // exists its own state machine decides and this check is skipped entirely.
  if (!existing && order.merchantCreditStatus !== 'HELD') return false;

  if (!existing) {
    // Opened lazily. An order held by a confirm that failed to open its
    // settlement is still settleable — the next sweep opens one and proceeds,
    // rather than the order being stranded by a write that did not happen.
    const opened = await openSettlement({
      settlementId, merchantId: order.merchantId, orderId: order.orderId,
      direction: DIRECTIONS.WITHDRAWAL, amountPaise: rupeesToPaise(order.tokenAmount),
      actor: 'settlement-worker',
      reason: `Withdrawal ${order.orderId} held pending settlement`,
    });
    // Nothing to settle if the reservation could not be made. Returning false
    // leaves the order HELD, which is right: the next sweep retries from the
    // same place.
    if (!opened.ok) {
      console.error(`[withdrawal-hold] settlement open failed for ${order.orderId}:`, opened.reason);
      return false;
    }
  }

  // ── The gate ───────────────────────────────────────────────────────────────
  const settled = await completeSettlement({
    settlementId, merchantId: order.merchantId, actor: 'settlement-worker',
    reason: `Withdrawal ${order.orderId} settled after hold`,
  });

  if (!settled.ok || settled.idempotent) {
    // Three ways to land here — already SETTLED, CANCELLED by a dispute, or
    // (impossible after the open above, but not worth assuming away) missing.
    // All mean the same thing: the settlement has already decided and the ORDER
    // has not caught up. The repair is the same in each case, and it is what
    // takes the order out of the sweep's query: write the settlement's real
    // state onto it. Without this the sweep hands the same order back forever.
    const actual = settled.settlement ?? await getSettlement(settlementId);
    if (actual) await mirrorSettlement(order, actual.status);
    else console.warn(`[withdrawal-hold] settlement vanished for ${order.orderId}: ${settled.reason}`);
    return false;
  }

  // The settlement has committed. Everything below is downstream of a decision
  // that is already final.
  try {
    await releaseWithdrawal(order.userId, order.tokenAmount, order.orderId);
  } catch (err) {
    console.error(`[withdrawal-hold] release failed for ${order.orderId}, reversing settlement:`, err.message);
    const reversed = await reverseSettlement({
      settlementId, merchantId: order.merchantId, actor: 'settlement-worker',
      reason: `Withdrawal ${order.orderId} settlement reversed — player stake release failed`,
    }).catch((e) => ({ ok: false, reason: e.message }));

    sendAlert('withdrawal-hold-release-failed', 'Held withdrawal could not release the player stake', {
      orderId: order.orderId, userId: String(order.userId), amount: order.tokenAmount,
      error: err.message,
      // Whether the compensation landed decides whether a human has to act: an
      // un-reversed settlement means the merchant holds tokens for a stake the
      // player never gave up.
      settlementReversed: reversed.ok === true,
      reversalError: reversed.ok ? undefined : reversed.reason,
    }).catch(() => {});
    if (reversed.ok) await mirrorSettlement(order, 'REVERSED');
    throw err;
  }

  await mirrorSettlement(order, 'SETTLED');

  emitOrderUpdate(String(order.userId), 'order_completed', {
    orderId: order.orderId, _id: order.orderId, status: 'COMPLETED', server_ts: Date.now(),
  });
  emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'COMPLETED', server_ts: Date.now() });
  return true;
}

/**
 * Write the settlement's committed state onto the order.
 *
 * ── This function did nothing ───────────────────────────────────────────────
 * Its body was `return}` — a codemod had gutted it. So the settlement
 * committed, the player's stake was consumed and the merchant credited, and the
 * ORDER never advanced: it stayed HELD, and the sweep offered it again on every
 * pass, forever, after the money had already moved. The settlement's own
 * idempotency meant nothing was paid twice; the order simply never completed
 * and the queue never drained.
 *
 * Awaited, not fire-and-forget: the sweeper's query reads these very fields,
 * and racing it hands the same order straight back.
 */
function mirrorSettlement(order, settlementStatus, extra = {}) {
  return db.orders.mirrorSettlementState(order.orderId, settlementStatus, extra)
    .catch((e) => {
      // A failure here does not unwind a committed settlement — it means the
      // order is stale, which the next sweep repairs. It must be loud, because
      // a repeatedly-failing mirror is an order that never completes.
      console.error(`[withdrawal-hold] mirror failed for ${order.orderId}:`, e.message);
      sendAlert('withdrawal-hold-mirror-failed', 'Settlement committed but the order was not updated', {
        orderId: order.orderId, settlementStatus, error: e.message,
      }).catch(() => {});
    });
}

/**
 * Reverse a held withdrawal: the merchant never sent the money, so the player
 * gets their stake back and the merchant is credited nothing.
 *
 * Only ever reachable while the order is HELD, which is precisely the window in
 * which no value has moved. After settlement this returns false and the dispute
 * becomes a clawback question for an admin — which is the outcome the hold
 * exists to make rare.
 *
 * The RESERVED → CANCELLED guard is the gate, the mirror image of settleHold's.
 * Both outcomes of the same race are therefore decided by the same row, so a
 * dispute and a sweep cannot each believe they won.
 *
 * @returns {Promise<boolean>} true when THIS call reversed the order.
 */
export async function reverseHold(orderId, opts = {}) {
  const { reason = 'Dispute upheld — merchant payment not received', by = null } = opts;

  const order = await db.orders.getOrderRecord(orderId);
  if (!order) return false;

  const settlementId = settlementIdFor(order);
  let existing = await getSettlement(settlementId);

  if (!existing) {
    // No settlement row: the confirm that held this order failed to open one.
    // Open it now so the state machine has something to refuse or grant —
    // reversing without one would leave the merchant's reservation unaccounted.
    if (order.merchantCreditStatus !== 'HELD') return false;
    const opened = await openSettlement({
      settlementId, merchantId: order.merchantId, orderId: order.orderId,
      direction: DIRECTIONS.WITHDRAWAL, amountPaise: rupeesToPaise(order.tokenAmount),
      actor: by ? String(by) : 'dispute',
      reason: `Withdrawal ${order.orderId} reservation opened for reversal`,
    });
    if (!opened.ok) {
      console.error(`[withdrawal-hold] settlement open failed for ${order.orderId}:`, opened.reason);
      return false;
    }
    existing = opened.settlement;
  }

  const cancelled = await cancelSettlement({
    settlementId, merchantId: order.merchantId,
    actor: by ? String(by) : 'dispute', reason: String(reason).slice(0, 500),
  });
  // Already SETTLED (the sweep won) or already CANCELLED. Either way this call
  // did not reverse it, and the caller must not tell the player it did.
  if (!cancelled.ok || cancelled.idempotent) return false;

  // Mirror BEFORE refunding, the opposite of settleHold's ordering and for a
  // reason worth stating. The refund is idempotent, so retrying it is free;
  // leaving the order HELD is not. If the refund threw first, the next sweep
  // would find the settlement already CANCELLED, be refused by the state
  // machine, and hand the order straight back — held forever, player never
  // refunded, and nothing in the loop escalating. Writing the state first makes
  // the failure loud instead of circular.
  await mirrorSettlement(order, 'CANCELLED', { reason, actor: by });

  try {
    await refundWithdrawal(order.userId, order.tokenAmount, order.orderId);
  } catch (err) {
    console.error(`[withdrawal-hold] refund failed for ${order.orderId}:`, err.message);
    sendAlert('withdrawal-hold-refund-failed', 'Reversed withdrawal did not return the player stake', {
      orderId: order.orderId, userId: String(order.userId), amount: order.tokenAmount, error: err.message,
    }).catch(() => {});
    throw err;
  }

  emitReversal(order);
  return true;
}

function emitReversal(order) {
  emitOrderUpdate(String(order.userId), 'order_update', {
    orderId: order.orderId, _id: order.orderId, status: 'DISPUTED',
    message: 'Your withdrawal was reversed and the amount returned to your balance.',
    server_ts: Date.now(),
  });
  emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'DISPUTED', server_ts: Date.now() });
}

/**
 * Sweep every hold whose window has passed. Called by the settlement worker.
 *
 * Bounded per run so a backlog cannot monopolise the job slot, and each order is
 * isolated: one failure alerts and the loop continues, because a single stuck
 * order must not block every other player's withdrawal.
 *
 * The deadline is compared IN THE DATABASE. Several worker instances each
 * comparing against their own `new Date()` disagree by however far their clocks
 * have drifted — and this decides when a merchant's tokens become spendable.
 */
export async function settleDueHolds({ limit = 200 } = {}) {
  const due = await db.orders.findDueHolds({ limit });

  let settled = 0;
  for (const order of due) {
    try {
      if (await settleHold(order.orderId)) settled++;
    } catch (err) {
      console.error(`[withdrawal-hold] settle error for ${order.orderId}:`, err.message);
    }
  }
  return settled;
}
