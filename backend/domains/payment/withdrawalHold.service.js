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
import { reverseMirrorMerchantSettlement } from '../../postgres/reverseMirror.js';
import {
  DIRECTIONS, openSettlement, completeSettlement, cancelSettlement, reverseSettlement,
  getSettlement,
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
 * ── The concurrency gate, and which store owns it ──────────────────────────
 * On MONGO, the gate is the `findOneAndUpdate` filtered on
 * `merchantCreditStatus: 'HELD'`: only one caller can move an order out of the
 * hold. That works, but it forces Mongo to decide FIRST and Postgres to follow,
 * which is authority in name only — and it recreates the stranding window
 * somewhere new, because once the order has left HELD the sweep cannot retry.
 *
 * On POSTGRES the gate is the settlement's own RESERVED→SETTLED guard. Only one
 * caller wins it, exactly as before, but now the source of truth decides and
 * Mongo is written afterwards as a MIRROR. That is the inversion this domain
 * was blocked on.
 *
 * ── Ordering, and what compensates a partial failure ────────────────────────
 * The Mongo path releases the player's stake first, so its worst case is
 * "player keeps a locked stake pending manual review" rather than "merchant
 * paid twice". The Postgres path cannot do that — the gate has to come first or
 * two sweeps could both proceed — so it earns the same safety a different way:
 * if the player-side release fails after the settlement won the gate, the
 * settlement is REVERSED. That is a real recorded movement, not a silent undo,
 * and it leaves the books consistent rather than the merchant credited for a
 * stake the player still holds.
 *
 * @returns {Promise<boolean>} true when THIS call settled the order.
 */
export async function settleHold(orderId) {
  const PaymentOrder = mongoose.model('PaymentOrder');

  if (onPostgres()) return settleHoldOnPostgres(orderId);

  return settleHoldOnMongo(orderId);
}

/**
 * The Postgres-authoritative settlement. Postgres decides; Mongo is written
 * afterwards as a mirror of that decision.
 *
 * ── Why Mongo is still read first ───────────────────────────────────────────
 * Postgres has no merchant, user or order table — `merchant_settlements` keys
 * on an ObjectId string with nothing behind it. The order document is where the
 * userId, merchantId and amount live, so it has to be read. That read is
 * ELIGIBILITY, not a gate: it decides whether there is anything here to settle,
 * and never which of two concurrent callers wins.
 *
 * The distinction shows up in the one branch that consults
 * `merchantCreditStatus`. Once a settlement row exists, its own state machine
 * decides and Mongo's opinion is ignored — which is what stops a lagging mirror
 * from stranding a settlement Postgres is holding at RESERVED. Mongo's status
 * only matters when NO settlement exists, where it answers a different
 * question: may we open one? Without that check a sweep could open a fresh
 * reservation against an order that was completed or reversed long ago under
 * the Mongo path.
 *
 * ── Opening lazily ──────────────────────────────────────────────────────────
 * Orders held BEFORE the flip have no settlement row (merchant.routes only
 * opens one while Postgres is authoritative). Opening here on demand is what
 * lets the flip happen without draining the hold queue first.
 */
async function settleHoldOnPostgres(orderId) {
  const PaymentOrder = mongoose.model('PaymentOrder');

  const order = await PaymentOrder.findById(orderId)
    .select('_id orderId userId merchantId tokenAmount type merchantCreditStatus').lean();
  if (!order) return false;

  const settlementId = settlementIdFor(order);
  const existing = await getSettlement(settlementId);
  if (!existing && order.merchantCreditStatus !== 'HELD') return false;

  if (!existing) {
    const opened = await openSettlement({
      settlementId, merchantId: order.merchantId, orderId: order._id.toString(),
      direction: DIRECTIONS.WITHDRAWAL, amountPaise: rupeesToPaise(order.tokenAmount),
      actor: 'settlement-worker',
      reason: `Withdrawal ${order.orderId} held pending settlement`,
    });
    // Nothing to settle if the reservation itself could not be made. Returning
    // false leaves the order HELD, which is exactly right: the next sweep
    // retries from the same place rather than the order being stranded.
    if (!opened.ok) {
      console.error(`[withdrawal-hold] settlement open failed for ${order.orderId}:`, opened.reason);
      return false;
    }
  }

  // ── The gate ───────────────────────────────────────────────────────────────
  // RESERVED → SETTLED, guarded in the UPDATE's WHERE clause. Exactly one
  // concurrent caller can win it; every other outcome is a refusal, not a
  // partial settlement.
  const settled = await completeSettlement({
    settlementId, merchantId: order.merchantId, actor: 'settlement-worker',
    reason: `Withdrawal ${order.orderId} settled after hold`,
  });

  if (!settled.ok || settled.idempotent) {
    // Three ways to land here, and all of them mean the same thing: Postgres has
    // already decided, and Mongo has not caught up — because a caught-up Mongo
    // would not have shown this order as due in the first place.
    //   idempotent          already SETTLED
    //   invalid_transition  CANCELLED by a dispute, or already REVERSED
    //   not_found           impossible after the open above, but not worth
    //                       assuming away
    // So the repair is the same in each case: push the settlement's REAL state
    // back into Mongo. Without this the sweep would hand the same order back on
    // every pass forever, because the only thing that removes it from the sweep
    // query is the mirror that just failed.
    const actual = settled.settlement ?? await getSettlement(settlementId);
    if (actual) await mirrorSettlement(order, { settlement: actual });
    else console.warn(`[withdrawal-hold] settlement vanished for ${order.orderId}: ${settled.reason}`);
    return false;
  }

  // Postgres has committed. Everything below is downstream of a decision that
  // is already final.
  try {
    await releaseWithdrawal(order.userId, order.tokenAmount, order._id.toString());
  } catch (err) {
    // The settlement won the gate but the player's stake could not be consumed.
    //
    // The Mongo path avoids this by releasing the player first, which the gate's
    // position here makes impossible. So it is compensated instead: SETTLED →
    // REVERSED takes the tokens back out of the merchant's spendable pocket as
    // a RECORDED movement. Not a silent undo — the reversal is an entry, it may
    // legitimately drive `available` negative (the merchant may have spent them
    // in the window), and the books end consistent with the player still
    // holding their stake.
    console.error(`[withdrawal-hold] release failed for ${order.orderId}, reversing settlement:`, err.message);
    const reversed = await reverseSettlement({
      settlementId, merchantId: order.merchantId, actor: 'settlement-worker',
      reason: `Withdrawal ${order.orderId} settlement reversed — player stake release failed`,
    }).catch((e) => ({ ok: false, reason: e.message }));

    sendAlert('withdrawal-hold-release-failed', 'Held withdrawal could not release the player stake', {
      orderId: String(order._id), userId: String(order.userId), amount: order.tokenAmount,
      error: err.message,
      // Whether the compensation landed decides whether a human has to act: an
      // un-reversed settlement means the merchant is holding tokens for a stake
      // the player never gave up.
      settlementReversed: reversed.ok === true,
      reversalError: reversed.ok ? undefined : reversed.reason,
    }).catch(() => {});
    if (reversed.ok) await mirrorSettlement(order, reversed);
    throw err;
  }

  await mirrorSettlement(order, settled);

  emitOrderUpdate(order.userId.toString(), 'order_completed', {
    orderId: order.orderId, _id: order._id, status: 'COMPLETED', server_ts: Date.now(),
  });
  emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'COMPLETED', server_ts: Date.now() });
  return true;
}

/**
 * Write the settlement's committed state onto the order.
 *
 * Drives the same reverse mirror the reconcile repair pass uses, rather than
 * writing the order fields here: one write path per direction is what makes a
 * replay idempotent and keeps the live mirror and the repair from drifting into
 * two different ideas of what a SETTLED order looks like.
 *
 * Awaited — not because a failure can fail the call (mirrorBack swallows and
 * pages) but because the sweeper's query reads these very fields, and racing it
 * would hand the same order back on the next pass.
 */
function mirrorSettlement(order, result) {
  return reverseMirrorMerchantSettlement({
    order_id: order._id.toString(),
    direction: result.settlement.direction ?? DIRECTIONS.WITHDRAWAL,
    state: result.settlement.state,
    updated_at: result.settlement.updatedAt,
  });
}

/** The original Mongo-authoritative path, unchanged. */
async function settleHoldOnMongo(orderId) {
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
    await creditMerchantTokens({
      merchantId: order.merchantId, amount: order.tokenAmount,
      reason: `Withdrawal ${order.orderId} settled after hold — tokens received from user`,
      refModel: 'PaymentOrder', refId: order._id.toString(),
      // Same canonical txId the pre-hold path used, so an order settled under
      // either code path can never be credited twice.
      txId: `mw_wd_credit_${order._id}`,
    });
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
 * Same inversion as settleHold: on Postgres the RESERVED→CANCELLED guard is the
 * gate and Mongo is the mirror. Leaving this one on Mongo's `findOneAndUpdate`
 * while settleHold moved would be worse than not moving either — the two
 * outcomes of the same race would then be decided by two different databases,
 * and a dispute and a sweep could each believe they had won.
 *
 * @returns {Promise<boolean>} true when THIS call reversed the order.
 */
export async function reverseHold(orderId, opts = {}) {
  const { reason = 'Dispute upheld — merchant payment not received', by = null } = opts;
  if (onPostgres()) return reverseHoldOnPostgres(orderId, { reason, by });
  return reverseHoldOnMongo(orderId, { reason, by });
}

async function reverseHoldOnPostgres(orderId, { reason, by }) {
  const PaymentOrder = mongoose.model('PaymentOrder');

  const order = await PaymentOrder.findById(orderId)
    .select('_id orderId userId merchantId tokenAmount merchantCreditStatus').lean();
  if (!order) return false;

  const settlementId = settlementIdFor(order);
  const existing = await getSettlement(settlementId);

  // Eligibility, not a gate — see settleHoldOnPostgres. With no settlement row
  // there is nothing for the state machine to refuse, so a pre-flip hold is
  // reversed the only way it can be: on Mongo's own gate.
  if (!existing) {
    if (order.merchantCreditStatus !== 'HELD') return false;
    return reverseHoldOnMongo(orderId, { reason, by });
  }

  const cancelled = await cancelSettlement({
    settlementId, merchantId: order.merchantId,
    actor: by ? String(by) : 'dispute', reason: String(reason).slice(0, 500),
  });
  // Already SETTLED (the sweep won) or already CANCELLED. Either way this call
  // did not reverse it, and the caller must not tell the player it did.
  if (!cancelled.ok || cancelled.idempotent) return false;

  // Mirror BEFORE refunding, which is the opposite of settleHold's ordering and
  // for a reason worth stating. The refund is idempotent, so retrying it is
  // free; leaving the order HELD is not. If the refund threw first, the next
  // sweep would find a settlement already CANCELLED, be refused by the state
  // machine, and hand the order straight back — held forever, player never
  // refunded, and nothing in the loop escalating. Writing the state first means
  // the failure is loud (below) instead of circular.
  await mirrorSettlement(order, cancelled);
  // Fields the settlement mirror cannot know: the dispute's own narrative.
  await PaymentOrder.updateOne({ _id: order._id }, {
    $set: {
      status: 'DISPUTED',
      merchantCreditReversedReason: String(reason).slice(0, 500),
      ...(by ? { disputeResolvedBy: by } : {}),
    },
  });

  try {
    await refundWithdrawal(order.userId, order.tokenAmount, order._id.toString());
  } catch (err) {
    console.error(`[withdrawal-hold] refund failed for ${order.orderId}:`, err.message);
    sendAlert('withdrawal-hold-refund-failed', 'Reversed withdrawal did not return the player stake', {
      orderId: String(order._id), userId: String(order.userId), amount: order.tokenAmount, error: err.message,
    }).catch(() => {});
    throw err;
  }

  emitReversal(order);
  return true;
}

async function reverseHoldOnMongo(orderId, { reason, by }) {
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

  // Release the reservation if one exists. Guarded on authority because a
  // Mongo-only deployment has no Postgres to ask, and reverseHoldOnPostgres
  // delegates here only for pre-flip orders — which it has already established
  // have no settlement row at all.
  if (onPostgres()) {
    await cancelSettlement({
      settlementId: settlementIdFor(order), merchantId: order.merchantId,
      actor: by ? String(by) : 'dispute', reason: String(reason).slice(0, 500),
    }).catch((e) => console.error(`[withdrawal-hold] settlement cancel failed for ${order.orderId}:`, e.message));
  }

  emitReversal(order);
  return true;
}

function emitReversal(order) {
  emitOrderUpdate(order.userId.toString(), 'order_update', {
    orderId: order.orderId, _id: order._id, status: 'DISPUTED',
    message: 'Your withdrawal was reversed and the amount returned to your balance.',
    server_ts: Date.now(),
  });
  emitAdminUpdate('queue_order_update', { orderId: order._id, status: 'DISPUTED', server_ts: Date.now() });
}

/**
 * Sweep every hold whose window has passed. Called by the settlement worker.
 *
 * Bounded per run so a backlog cannot monopolise the job slot, and each order is
 * isolated: one failure alerts and the loop continues, because a single stuck
 * order must not block every other player's withdrawal.
 *
 * ── Why the queue is read from Mongo even under Postgres authority ──────────
 * Two fields only exist there: the hold DEADLINE (`merchantCreditHoldUntil`)
 * and the order itself. A settlement has no deadline of its own.
 *
 * That is safe rather than merely convenient, because of the direction the
 * writes go. An order is put into HELD by the confirm request — Mongo's own
 * primary write, not a mirror — and it leaves HELD only via a mirror of a
 * decision Postgres already made. So Mongo's HELD set is always a SUPERSET of
 * the settlements still awaiting one: a dropped mirror leaves an order in the
 * queue (where the next pass repairs it), never out of it. A work queue that
 * errs towards re-offering is exactly the kind that is safe to build on
 * idempotent settlement.
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
