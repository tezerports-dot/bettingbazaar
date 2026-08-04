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
import mongoose from 'mongoose';
import { releaseWithdrawal, refundWithdrawal } from '../wallet/walletAuthority.service.js';
import { creditMerchantTokens } from '../merchant/merchantWallet.service.js';
import { emitOrderUpdate, emitAdminUpdate } from '../notification/realtimeEmitters.js';
import { sendAlert } from '../../services/alerting.service.js';
import { rupeesToPaise } from '../../shared/money.js';
import { isPostgresAuthoritative, MONEY_PATHS } from '../../postgres/moneyAuthority.js';
import {
  DIRECTIONS, openSettlement, completeSettlement, cancelSettlement,
} from '../../postgres/merchantSettlementPg.js';

/** Is Postgres the source of truth for the merchant side of a settlement? */
const onPostgres = () => isPostgresAuthoritative(MONEY_PATHS.MERCHANT_SETTLEMENT);

/** One deterministic settlement per order, so a retry addresses the same one. */
const settlementIdFor = (order) => `ms_${order._id}`;

/** Fallback matches the SystemConfig schema default (60). */
const DEFAULT_HOLD_MINUTES = 60;

/**
 * Admin-configured hold window, in minutes. 0 means settle immediately on
 * confirm (the pre-2026-07-30 behaviour).
 */
export async function holdMinutes() {
  try {
    const SystemConfig = mongoose.model('SystemConfig');
    const cfg = await SystemConfig.findOne({ key: 'main' }).select('withdrawalHoldMinutes').lean();
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
 * The status transition is the concurrency gate. `findOneAndUpdate` filtered on
 * `merchantCreditStatus: 'HELD'` means only one caller can move an order out of
 * the hold — a sweep racing a manual admin release cannot both settle it, and
 * a reversal that lands first takes the order out of `HELD` so the sweep skips
 * it entirely.
 *
 * Both money operations are idempotent on their canonical txIds, so a crash
 * between them is repaired by the next sweep rather than double-paying.
 *
 * @returns {Promise<boolean>} true when THIS call settled the order.
 */
export async function settleHold(orderId) {
  const PaymentOrder = mongoose.model('PaymentOrder');

  const order = await PaymentOrder.findOneAndUpdate(
    { _id: orderId, merchantCreditStatus: 'HELD' },
    { $set: { merchantCreditStatus: 'RELEASED', status: 'COMPLETED', completedAt: new Date(), escrowLocked: false } },
    { new: true },
  );
  if (!order) return false; // already settled, reversed, or never held

  // Player side first. If this throws, the merchant is not credited and the
  // next sweep cannot retry (the order has left HELD) — so it alerts rather
  // than failing silently. Ordering it first means the failure mode is "player
  // keeps a locked stake pending manual review", never "merchant paid twice".
  try {
    await releaseWithdrawal(order.userId, order.tokenAmount, order._id.toString());
  } catch (err) {
    console.error(`[withdrawal-hold] release failed for ${order.orderId}:`, err.message);
    sendAlert('withdrawal-hold-release-failed', 'Held withdrawal could not release the player stake', {
      orderId: String(order._id), userId: String(order.userId), amount: order.tokenAmount, error: err.message,
    }).catch(() => {});
    throw err;
  }

  try {
    if (onPostgres()) {
      // The settlement was opened when the hold was placed, so the tokens
      // already exist in the merchant's `settlement` pocket — owed, unspendable.
      // Completing it moves them to `available` in ONE transaction with the
      // state change, which is the whole reason this domain exists: the Mongo
      // branch below flips the order out of HELD first and then credits, so a
      // failure between the two strands the settlement with no way to retry.
      //
      // openSettlement is idempotent, so an order held before the flip (and
      // therefore never opened in Postgres) is opened here rather than failing.
      await openSettlement({
        settlementId: settlementIdFor(order), merchantId: order.merchantId,
        orderId: order._id.toString(), direction: DIRECTIONS.WITHDRAWAL,
        amountPaise: rupeesToPaise(order.tokenAmount),
        reason: `Withdrawal ${order.orderId} held`,
      });
      const settled = await completeSettlement({
        settlementId: settlementIdFor(order), merchantId: order.merchantId,
        actor: 'withdrawal-hold-sweeper',
        reason: `Withdrawal ${order.orderId} settled after hold`,
      });
      if (!settled.ok) throw new Error(`settlement refused: ${settled.reason} (state=${settled.state ?? 'n/a'})`);
    } else {
      await creditMerchantTokens({
        merchantId: order.merchantId, amount: order.tokenAmount,
        reason: `Withdrawal ${order.orderId} settled after hold — tokens received from user`,
        refModel: 'PaymentOrder', refId: order._id.toString(),
        // Same canonical txId the pre-hold path used, so an order settled under
        // either code path can never be credited twice.
        txId: `mw_wd_credit_${order._id}`,
      });
    }
  } catch (err) {
    console.error(`[withdrawal-hold] merchant credit failed for ${order.orderId}:`, err.message);
    sendAlert('withdrawal-hold-credit-failed', 'Held withdrawal released the player stake but did not credit the merchant', {
      orderId: String(order._id), merchantId: String(order.merchantId), amount: order.tokenAmount, error: err.message,
    }).catch(() => {});
    throw err;
  }

  emitOrderUpdate(order.userId.toString(), 'order_completed', {
    orderId: order.orderId, _id: order._id, status: 'COMPLETED', server_ts: Date.now(),
  });
  emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'COMPLETED', server_ts: Date.now() });
  return true;
}

/**
 * Reverse a held withdrawal: the merchant never sent the money, so the player
 * gets their stake back and the merchant is credited nothing.
 *
 * Only ever reachable while the order is `HELD`, which is precisely the window
 * in which no value has moved. After settlement this returns false and the
 * dispute becomes a clawback question for an admin — which is the outcome the
 * hold exists to make rare.
 *
 * @returns {Promise<boolean>} true when THIS call reversed the order.
 */
export async function reverseHold(orderId, { reason = 'Dispute upheld — merchant payment not received', by = null } = {}) {
  const PaymentOrder = mongoose.model('PaymentOrder');

  const order = await PaymentOrder.findOneAndUpdate(
    { _id: orderId, merchantCreditStatus: 'HELD' },
    {
      $set: {
        merchantCreditStatus: 'REVERSED',
        merchantCreditReversedAt: new Date(),
        merchantCreditReversedReason: String(reason).slice(0, 500),
        status: 'DISPUTED',
        escrowLocked: false,
        ...(by ? { disputeResolvedBy: by } : {}),
      },
    },
    { new: true },
  );
  if (!order) return false;

  // Return the stake to the player. refundWithdrawal is the authority's inverse
  // of the debit taken at order creation, and is idempotent on its own key.
  await refundWithdrawal(order.userId, order.tokenAmount, order._id.toString());

  // Take back the merchant's owed tokens. Only meaningful on the Postgres path:
  // on Mongo nothing was ever credited during the hold, so there is nothing to
  // cancel. Cancelling a settlement that was never opened is a no-op, and a
  // settlement already SETTLED refuses — correctly, because after settlement a
  // dispute is a clawback decision for an admin, not an automatic reversal.
  if (onPostgres()) {
    await cancelSettlement({
      settlementId: settlementIdFor(order), merchantId: order.merchantId,
      actor: by ? String(by) : 'dispute', reason: String(reason).slice(0, 500),
    }).catch((e) => console.error(`[withdrawal-hold] settlement cancel failed for ${order.orderId}:`, e.message));
  }

  emitOrderUpdate(order.userId.toString(), 'order_update', {
    orderId: order.orderId, _id: order._id, status: 'DISPUTED',
    message: 'Your withdrawal was reversed and the amount returned to your balance.',
    server_ts: Date.now(),
  });
  emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'DISPUTED', server_ts: Date.now() });
  return true;
}

/**
 * Sweep every hold whose window has passed. Called by the settlement worker.
 *
 * Bounded per run so a backlog cannot monopolise the job slot, and each order is
 * isolated: one failure alerts and the loop continues, because a single stuck
 * order must not block every other player's withdrawal.
 */
export async function settleDueHolds({ limit = 200 } = {}) {
  const PaymentOrder = mongoose.model('PaymentOrder');

  const due = await PaymentOrder.find({
    merchantCreditStatus: 'HELD',
    merchantCreditHoldUntil: { $lte: new Date() },
  }).select('_id orderId').limit(limit).lean();

  let settled = 0;
  for (const row of due) {
    try {
      if (await settleHold(row._id)) settled++;
    } catch (err) {
      console.error(`[withdrawal-hold] settle error for ${row.orderId}:`, err.message);
    }
  }
  return settled;
}
