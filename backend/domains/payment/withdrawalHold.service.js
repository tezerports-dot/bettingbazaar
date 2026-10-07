// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/payment/withdrawalHold.service.js — the settlement half of a withdrawal.
 *
 * ── The loss this closes ───────────────────────────────────────────────────
 * On a WITHDRAWAL a team member sends the player fiat, and the player's tokens
 * join the member's TEAM POOL. Confirm is an ASSERTION by the member, not
 * evidence: a member who pressed it without sending the money would put the
 * tokens in their team's pool at once, where the next buy could spend them
 * long before the player noticed nothing had arrived.
 *
 * ── The shape of the fix ───────────────────────────────────────────────────
 * Confirm records the assertion and freezes BOTH sides for
 * `SystemConfig.withdrawalHoldMinutes`. A worker settles the order when the
 * window passes; a dispute inside the window stops it. Until settlement runs,
 * no value has moved: the player's stake is locked (as it has been since order
 * creation) and the pool has not been credited.
 *
 * Settling is ONE transaction, keyed on the order (`walletAuthority.settleSell`
 * → `teamPools.creditSellToPool`): the pool +a, the player's locked stake
 * consumed and USER_FLOAT → TEAM_FLOAT commit together or not at all, after
 * the GATE — under the order's row lock, the order is still PAID.
 *
 * ── Why a worker and not a timer ───────────────────────────────────────────
 * The hold outlives any single request and must survive a restart, so expiry is
 * a swept database state rather than an in-process timeout. `settleDueHolds` is
 * idempotent and leader-locked by the job platform, so running it twice, or on
 * several instances, settles each order exactly once.
 */
import { db } from '#db';
import { settleSell, refundSettledSell, refundWithdrawal } from '../wallet/walletAuthority.service.js';
import { emitOrderUpdate, emitAdminUpdate } from '../notification/realtimeEmitters.js';
import { sendAlert } from '../../services/alerting.service.js';
import { payCommissionFor } from '../team/teamCommission.service.js';
import { getSystemConfig } from '#db/repositories/config.js';

/** Fallback matches the SystemConfig schema default (60), which is also its floor. */
const DEFAULT_HOLD_MINUTES = 60;

/**
 * Admin-configured hold window, in minutes — the SELL escrow window. At least
 * an hour (owner, 2026-10-02): the player is told the member says they paid
 * and has that long to say the money never arrived. The spec refuses less;
 * a value below the floor that reached the row some other way reads as the
 * floor, never as "settle now".
 */
export async function holdMinutes() {
  try {
    const cfg = await getSystemConfig();
    const m = cfg?.withdrawalHoldMinutes;
    // schema default: 60, and the spec's minimum.
    if (Number.isFinite(m) && m >= DEFAULT_HOLD_MINUTES && m <= 1440) return m;
  } catch { /* fall through to the schema default */ }
  return DEFAULT_HOLD_MINUTES;
}

/**
 * Settle one held withdrawal: credit the team's pool, consume the player's
 * locked stake, complete the order.
 *
 * ── The gate ────────────────────────────────────────────────────────────────
 * `walletAuthority.settleSell` → `teamPools.creditSellToPool` with
 * `requireState: 'PAID'`: under the order's row lock, once per order (its keys
 * are the order's). A dispute that landed after the read moved the order to
 * DISPUTED and the settlement is refused; two sweeps settle once.
 *
 * ── One transaction, nothing to compensate ──────────────────────────────────
 * The pool credit, the stake leaving the player's `locked` and
 * USER_FLOAT → TEAM_FLOAT commit together or not at all (owner, 2026-10-07).
 * They were two transactions with a reversal between them; the database now
 * refuses either half alone, so there is no partial state to repair.
 *
 * @returns {Promise<boolean>} true when THIS call settled the order.
 */
export async function settleHold(orderId) {
  const order = await db.orders.getOrderRecord(orderId);
  if (!order || order.type !== 'WITHDRAWAL') return false;
  // Eligibility, not a gate — the settlement below asks the same question under
  // a lock. A DISPUTED withdrawal does not settle, whatever its timer says.
  if (order.merchantCreditStatus !== 'HELD' || order.state !== 'PAID') return false;

  const settled = await settleSell(order.orderId, {
    actor: 'settlement-worker', requireState: 'PAID',
  });
  if (!settled.ok) {
    // `order_state`: disputed since it was read; nothing moved and the admin
    // who resolves the dispute decides. Anything else moved nothing either,
    // and is a defect a person must see.
    if (settled.reason !== 'order_state') {
      console.error(`[withdrawal-hold] settlement refused for ${order.orderId}:`, settled.reason);
      sendAlert('withdrawal-hold-settle-refused', 'A held withdrawal could not settle; nothing moved', {
        orderId: order.orderId, userId: String(order.userId), amount: order.tokenAmount, reason: settled.reason,
      }).catch(() => {});
    }
    return false;
  }

  await mirrorSettlement(order, 'SETTLED');
  // The sell is COMPLETED now: its team may have earned commission (Step 2e).
  await payCommissionFor(order.teamId, { actor: 'settlement-worker' });

  emitOrderUpdate(String(order.userId), 'order_completed', {
    orderId: order.orderId, _id: order.orderId, status: 'COMPLETED', server_ts: Date.now(),
  });
  emitAdminUpdate('queue_order_update', { orderId: order.orderId, status: 'COMPLETED', server_ts: Date.now() });
  return true;
}

/**
 * Write the settlement's committed state onto the order.
 *
 * Without it the money moves and the ORDER never advances: it stays HELD, and
 * the sweep offers it again on every pass, forever (a codemod once gutted this
 * body to `return}` and that is exactly what happened).
 *
 * Awaited, not fire-and-forget: the sweeper's query reads these very fields,
 * and racing it hands the same order straight back.
 */
function mirrorSettlement(order, settlementStatus, extra = {}) {
  return db.orders.mirrorSettlementState(order.orderId, settlementStatus, extra)
    .catch((e) => {
      // A failure here does not unwind committed money — it means the
      // order is stale, which the next sweep repairs. It must be loud, because
      // a repeatedly-failing mirror is an order that never completes.
      console.error(`[withdrawal-hold] mirror failed for ${order.orderId}:`, e.message);
      sendAlert('withdrawal-hold-mirror-failed', 'Settlement committed but the order was not updated', {
        orderId: order.orderId, settlementStatus, error: e.message,
      }).catch(() => {});
    });
}

/**
 * End a withdrawal the way an ADMIN decided it — REFUND it to the player, or
 * RELEASE it to the team — whatever position its money is in.
 *
 * ── THE one owner, for every position of the money ────────────────────────
 * The admin queue action, the Payment Control Centre and the Dispute Manager
 * all end withdrawals, and the money can be in one of two positions:
 *
 *   NOT SETTLED  the stake is LOCKED and the pool has not been credited
 *   SETTLED      the pool was credited and the stake consumed
 *
 * Ten of eleven route × position cells were once wrong when each route wrote
 * its own subset (F-027), so every route calls this and none moves money itself.
 *
 * ── What it does and does not write ──────────────────────────────────────
 * Money and the order's credit/escrow flags. NEVER the order's state: the
 * calling route has already moved it, through the lifecycle's guarded
 * transition, and that is the gate that stops two admins deciding one
 * withdrawal both ways.
 *
 * Every step is one transaction keyed on the order (`pool_sell_<id>` with
 * `wd_release_<id>`; `pool_sellrev_<id>` or `team_sell_cover_<id>` with
 * `dispute_wd_refund_<id>`; `refund_<id>`), so calling this again for the
 * same decision moves nothing twice — and the routes do call it again when
 * their transition reports the decision was already made. Consuming and
 * returning a locked stake are RIVALS: each refuses when the other's key
 * exists, so a stake is consumed or returned, never both. Whether a refund
 * finds the sell settled is asked under the order's lock, of the pool entry
 * the settlement wrote in the same transaction as the stake it consumed —
 * never of the order's flags, which this function itself rewrites.
 *
 * @param {string} orderId
 * @param {'REFUND'|'RELEASE'} decision
 * @returns {Promise<{ok: boolean, reason?: string, refunded?: boolean,
 *   released?: boolean, afterSettlement?: boolean, already?: boolean}>}
 */
export async function endWithdrawal(orderId, decision, { reason = null, by = null } = {}) {
  if (decision !== 'REFUND' && decision !== 'RELEASE') {
    throw new Error(`endWithdrawal: unknown decision '${decision}'`);
  }
  const order = await db.orders.getOrderRecord(orderId);
  if (!order || order.type !== 'WITHDRAWAL') return { ok: false, reason: 'not_a_withdrawal' };
  const actor = by ? String(by) : 'admin';

  if (decision === 'RELEASE') {
    // Refunded already: the stake went back to the player, so crediting the
    // pool now would pay out twice. (The settlement refuses it by key too.)
    if (order.escrowStatus === 'REFUNDED') return { ok: false, reason: 'refunded' };
    const settled = await settleSell(order.orderId, { actor });
    if (!settled.ok) return { ok: false, reason: settled.reason };
    await mirrorSettlement(order, 'SETTLED', { keepState: true, reason, actor });
    return settled.alreadyCredited ? { ok: true, already: true } : { ok: true, released: true };
  }

  // ── REFUND ─────────────────────────────────────────────────────────────
  // Settled already? Then the tokens are in the pool and the stake consumed:
  // take them back out of the pool and return the stake as winnings, in one
  // transaction. A team that has already used those tokens cannot give them
  // back; the platform covers the refund instead (`coverShortfall`), and the
  // team is recovered from by hand, below.
  const reversed = await refundSettledSell(order.orderId, {
    actor, reason: String(reason || `Withdrawal ${order.orderId} refunded by admin`).slice(0, 200),
    coverShortfall: true,
  });
  if (!reversed.ok && reversed.reason !== 'not_settled') {
    // Settled, and still not returnable: nothing has moved, so say so and stop.
    throw Object.assign(new Error(`The refund could not be made: ${reversed.reason}`), { status: 409 });
  }
  if (reversed.ok) {
    if (reversed.covered && !reversed.alreadyCovered) {
      // The team has already spent what this sell brought in. The player is
      // made whole now, from the platform's holding (above), and the team is
      // recovered from by hand — said plainly, rather than silently.
      sendAlert('withdrawal-refund-after-settlement', 'A settled withdrawal was refunded — recover it from the team', {
        orderId: order.orderId, teamId: String(order.teamId), merchantId: String(order.merchantId),
        amount: order.tokenAmount,
      }).catch(() => {});
    }
    await mirrorSettlement(order, 'CANCELLED', { keepState: true, reason, actor });
    return { ok: true, refunded: true, afterSettlement: true };
  }
  // Never settled: the stake is still locked — admission moved it winnings ->
  // locked, so returning it is locked -> winnings, on the one refund key every
  // path uses. A settlement that consumed it in the meantime is its rival and
  // refuses it (409), so the stake is never both consumed and returned.
  if (order.escrowLocked) {
    await refundWithdrawal(order.userId, order.tokenAmount, order.orderId);
  }
  if (order.merchantCreditStatus === 'HELD') {
    await mirrorSettlement(order, 'CANCELLED', { keepState: true, reason, actor });
  }
  await db.orders.setOrderFields(order.orderId, { escrowLocked: false, escrowStatus: 'REFUNDED' });
  return { ok: true, refunded: true };
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
