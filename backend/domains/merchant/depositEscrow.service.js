// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * depositEscrow.service.js — the merchant's side of a buy order, HELD.
 *
 * ── What this closes ────────────────────────────────────────────────────────
 * A buy order promises a player that a named merchant will hand over tokens.
 * Until this existed, nothing held those tokens: eligibility was CHECKED at
 * assignment and the tokens stayed spendable on anything else for the whole
 * life of the order. Two orders arriving in the same instant both passed the
 * check and were both assigned to a merchant who could fund one — measured, not
 * theorised: two 600-token orders on a merchant holding 1,000.
 *
 * Making the check read a more accurate number does not fix that. A number read
 * in one statement and acted on in another is a snapshot however good the
 * number is; the only thing that holds is a hold.
 *
 * ── The platform escrowed one side and not the other ────────────────────────
 * `lockWithdrawal` holds a PLAYER's tokens the instant they place a sell, so
 * they cannot spend or re-sell what is promised. All 21 escrow call sites are
 * guarded by `order.type === 'WITHDRAWAL'`. The platform protected itself from
 * the player and never the player from the merchant. This is the other half.
 *
 * ── It is not a new mechanism ───────────────────────────────────────────────
 * `merchant_settlements` already implements exactly this, with a state machine,
 * a two-lock ordering, a ledger entry per transition, a reconciler and a
 * stranded-pocket detector — and `POCKET_PLAN[DEPOSIT]` was written in full:
 *
 *     reserve   available -a, reserved +a     the hold
 *     complete  reserved  -a                  tokens dispensed, gone
 *     cancel    reserved  -a, available +a    released, automatically
 *
 * `DIRECTIONS.DEPOSIT` appeared three times in the entire codebase, all three
 * inside that module's own definitions. Nothing — not even a test — ever opened
 * one. The deposit half was built, merged and never called (§28: built is not
 * shipped), and this file is the caller it was missing.
 *
 * ── Why the hold is a real guard and not another check ──────────────────────
 * The reserve leg's refusal lives in the UPDATE's WHERE
 * (`available_paise + $n >= 0`) under `SELECT … FOR UPDATE`. Two concurrent
 * reserves against one merchant queue behind the row lock and the second is
 * refused by the database. There is no window to lose.
 *
 * ── Nothing here throws ─────────────────────────────────────────────────────
 * Every caller is either mid-assignment or has already moved an order's state.
 * An exception would turn a completed action into a 500 (§21) or take down a
 * sweep mid-batch. Each function returns an outcome the caller decides on.
 */
import {
  openSettlement, completeSettlement, cancelSettlement,
  liveDepositSettlementFor, findStrandedDepositHolds, findUnheldDepositOrders,
  DIRECTIONS,
} from '#db/repositories/merchantSettlements.js';
import { sendAlert } from '../../services/alerting.service.js';
import { rupeesToPaise } from '../../shared/money.js';
import { randomBytes } from 'node:crypto';

/**
 * The settlement id for one attachment of one order to one merchant.
 *
 * NOT `dep~<order>~<merchant>` alone. An order can be attached to the same
 * merchant more than once across its life — assigned, rejected, requeued, and
 * later assigned back — and a deterministic id would collide with the CANCELLED
 * settlement from the first attachment. `openSettlement` reports an existing
 * settlement as `idempotent: true` whatever state it reached, so the second
 * attachment would be told its hold was already in place while holding nothing.
 *
 * The idempotency that matters is therefore NOT carried by this key. It is
 * carried by `merchant_settlements_one_live_deposit`, a partial unique index
 * over `(order_id) WHERE direction='DEPOSIT' AND state='RESERVED'`, which the
 * database enforces against every racing caller at once. A retry loses that
 * race, reads back the winner's hold, and reports success — which is what a
 * retry should see.
 *
 * `~` and not `_`: a merchant id may contain an underscore, so a pattern
 * splitting on one cannot find where the id ends (§26.5).
 */
const newSettlementId = (orderId, merchantId) =>
  `dep~${orderId}~${merchantId}~${randomBytes(4).toString('hex')}`;

const amountPaiseOf = (order) => rupeesToPaise(order.tokenAmount);

/**
 * Hold this merchant's tokens for this order.
 *
 * Called at ATTACHMENT — the moment the order becomes theirs, by any of the
 * three routes that can attach one (automatic assignment, an admin assigning by
 * hand, or the merchant claiming from the open pool). That is the moment the
 * platform promises the player a merchant, so it is the moment the player's
 * protection starts.
 *
 * @returns {Promise<{ok: boolean, reason?: string, held?: number}>}
 *   `ok:false` with `reason:'insufficient'` means the merchant cannot fund it
 *   and MUST NOT be attached — the caller picks someone else or refuses.
 */
export async function holdForOrder(order, merchantId, { actor = 'assignment' } = {}) {
  const amountPaise = amountPaiseOf(order);
  if (!(amountPaise > 0)) return { ok: false, reason: 'bad_amount' };

  // Already held? Read first so an ordinary retry does not depend on catching a
  // constraint violation. The index still decides the race; this only keeps the
  // common path quiet.
  const existing = await liveDepositSettlementFor(order.orderId);
  if (existing) {
    return String(existing.merchantId) === String(merchantId)
      ? { ok: true, held: amountPaise, idempotent: true }
      // Someone else holds this order. The caller is reassigning and has not
      // released the previous hold — refused rather than opening a second,
      // because two holds for one promise is the thing the index exists to stop.
      : { ok: false, reason: 'held_by_another', heldBy: String(existing.merchantId) };
  }

  try {
    const opened = await openSettlement({
      settlementId: newSettlementId(order.orderId, merchantId),
      merchantId, orderId: order.orderId,
      direction: DIRECTIONS.DEPOSIT, amountPaise,
      actor,
      reason: `Buy order ${order.orderId} — tokens held for the player`,
    });
    if (!opened.ok) {
      // `reason: 'insufficient'` is the reserve leg's WHERE refusing. It is the
      // whole point of this call and is not an error: the merchant cannot fund
      // it. Read off `reason` — there is no boolean flag, and testing for one
      // would classify every refusal as 'refused' and lose the distinction the
      // caller decides on.
      return { ok: false, reason: opened.reason || 'refused' };
    }
    return { ok: true, held: amountPaise };
  } catch (error) {
    // 23505 on the partial index: a racing caller won. Whoever won holds it —
    // read back and answer about the world as it now is, not as we found it.
    if (error?.code === '23505') {
      const winner = await liveDepositSettlementFor(order.orderId);
      if (winner && String(winner.merchantId) === String(merchantId)) {
        return { ok: true, held: amountPaise, idempotent: true };
      }
      return { ok: false, reason: 'held_by_another', heldBy: winner ? String(winner.merchantId) : null };
    }
    console.error(`[deposit-escrow] hold failed for ${order.orderId}:`, error);
    return { ok: false, reason: 'error' };
  }
}

/**
 * The tokens have gone to the player. RESERVED → SETTLED, `reserved -a`.
 *
 * The merchant's inventory genuinely leaves the platform's merchant books here,
 * which is why `complete` has no second leg: it is not moved anywhere, it is
 * spent. Called from the deposit-completion path, beside the wallet debit.
 */
export async function dispenseForOrder(order, { actor = 'confirm' } = {}) {
  return finish(order, completeSettlement, actor,
    `Buy order ${order.orderId} completed — tokens dispensed`, 'dispense');
}

/**
 * The order will not be served by this merchant. RESERVED → CANCELLED,
 * `reserved -a, available +a` — the tokens come back on their own.
 *
 * Every terminal path calls this: reject, expiry, reassignment, cancellation,
 * and a dispute resolved against the deposit. It is safe to call when there is
 * no hold, because an order that never reached a merchant never had one.
 */
export async function releaseForOrder(order, { actor = 'system', reason = null } = {}) {
  return finish(order, cancelSettlement, actor,
    reason || `Buy order ${order.orderId} released — not served by this merchant`, 'release');
}

/**
 * The shared half of dispense and release.
 *
 * Both find the live hold and advance it; only the transition and the words
 * differ. Written once because two copies of "find the hold, decide what to do
 * when there isn't one" is how the two answers drift (§5).
 *
 * **No hold is `ok: true`, not a failure.** An order can legitimately reach a
 * terminal state without one — it was never attached, or it predates this
 * mechanism, or a sweep already released it. A caller that treated absence as
 * an error would refuse to finish orders that are perfectly fine.
 */
async function finish(order, advance, actor, reason, what) {
  try {
    const held = await liveDepositSettlementFor(order.orderId);
    if (!held) return { ok: true, noHold: true };
    const done = await advance({
      settlementId: held.settlementId, merchantId: held.merchantId, actor, reason,
    });
    if (!done.ok) {
      console.error(`[deposit-escrow] ${what} failed for ${order.orderId}: ${done.reason}`);
      return { ok: false, reason: done.reason };
    }
    return { ok: true, amountPaise: held.amountPaise, merchantId: held.merchantId };
  } catch (error) {
    console.error(`[deposit-escrow] ${what} threw for ${order.orderId}:`, error);
    return { ok: false, reason: 'error' };
  }
}

/**
 * The net under every path that takes a hold — run on a schedule, not on a
 * request.
 *
 * Every terminal path in this codebase releases its own hold today, and each is
 * covered by a test. The day one is added that does not is the day this matters,
 * and it is the reason a derived figure was not good enough on its own: a real
 * hold that nobody releases is money a merchant cannot use, and a promise with
 * no hold behind it is money a player will not get.
 *
 * Two opposite faults, so two queries. Neither implies the other:
 *
 *   STRANDED  a live hold on an order that has FINISHED — released here, which
 *             is always safe: the order is terminal and cannot need it again.
 *
 *   UNHELD    an order still owing tokens with no hold — REPORTED, never
 *             silently re-held. Re-taking it could fail (the merchant has since
 *             spent the tokens) and succeeding would hide a path that forgot,
 *             which is the thing worth knowing about. An operator decides.
 *
 * The `olderThanMinutes` grace is what keeps this off the toes of ordinary
 * traffic: an order mid-assignment is legitimately unheld for a few
 * milliseconds, and a sweep with no grace would report every one of them.
 */
export async function sweepDepositHolds({ graceMinutes = 15 } = {}) {
  const report = { released: 0, unheld: 0, failures: 0 };

  try {
    const stranded = await findStrandedDepositHolds({ olderThanMinutes: graceMinutes });
    for (const hold of stranded) {
      const done = await cancelSettlement({
        settlementId: hold.settlementId, merchantId: hold.merchantId,
        actor: 'escrow-sweep',
        reason: `Order is ${hold.orderState}; hold released by sweep`,
      });
      if (done.ok) {
        report.released += 1;
        console.warn(
          `[deposit-escrow] swept a stranded hold: ${hold.orderId} (${hold.orderState}) `
          + `held ${hold.amountPaise} paise of merchant ${hold.merchantId} since ${hold.heldSince}. `
          + 'A terminal path released the order and not its hold — find which.',
        );
      } else {
        report.failures += 1;
      }
    }
  } catch (error) {
    console.error('[deposit-escrow] stranded sweep failed:', error);
    report.failures += 1;
  }

  try {
    // Reported only. See above: re-holding would paper over the path that
    // forgot, and can fail in a way that leaves a worse story than the truth.
    const unheld = await findUnheldDepositOrders({ olderThanMinutes: graceMinutes });
    report.unheld = unheld.length;
    for (const order of unheld) {
      console.error(
        `[deposit-escrow] UNHELD buy order ${order.orderId} (${order.orderState}) — merchant `
        + `${order.merchantId} owes ${order.amountPaise} paise with nothing reserved since ${order.since}. `
        + 'The player is promised tokens the merchant is free to spend elsewhere.',
      );
    }
    if (unheld.length) {
      await sendAlert(
        'deposit-escrow-unheld',
        `${unheld.length} buy order(s) owe merchant tokens with no hold behind them.`,
      ).catch(() => {});
    }
  } catch (error) {
    console.error('[deposit-escrow] unheld sweep failed:', error);
    report.failures += 1;
  }

  return report;
}
