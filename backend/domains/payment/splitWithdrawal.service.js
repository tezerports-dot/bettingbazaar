// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * splitWithdrawal.service.js — the parent's state, derived from its legs.
 *
 * A withdrawal too large for one denomination becomes a PARENT holding several
 * LEGS, because an ATM dispenses denominations and not amounts. The player
 * asked for one withdrawal and keeps seeing one; the legs are how it gets done.
 *
 * ── The parent moves no money, ever ────────────────────────────────────────
 * This is the whole reason the module is small enough to reason about. The
 * escrow debit locked the full amount ONCE, against the parent, at creation.
 * Every leg releases exactly its own amount when it completes, and refunds
 * exactly its own amount when it is cancelled. Those add up to the parent's
 * lock precisely — which is why `createWithdrawalOrder` refuses to split at all
 * while a payout fee is set: the fee is the gap between the locked tokens and
 * the legs' fiat, and it would sit locked forever with no leg left to release
 * it.
 *
 * So the parent is a CONTAINER. Its state exists to be read — by the player
 * expanding one order, by an admin scanning a queue — and nothing about it
 * moves value. If a change to this file ever needs a wallet call, the model has
 * been broken somewhere else first.
 *
 * ── Why the parent walks the ordinary states ───────────────────────────────
 * PENDING_QUEUE → PROCESSING → COMPLETED, on the edges `ALLOWED_FROM` already
 * has. The alternative was widening `COMPLETED` to accept `PENDING_QUEUE`,
 * which would let ANY queued order in the system jump straight to completed —
 * a hole opened platform-wide to describe one container.
 */
import { db } from '#db';
import { ORDER_STATES } from '#db/repositories/orders.core.js';
import { startOrder, completeOrder, cancelOrder } from './orderLifecycle.service.js';

/** Legs that will never move again. Everything else is still in flight. */
const TERMINAL = Object.freeze([
  ORDER_STATES.COMPLETED, ORDER_STATES.CANCELLED,
  ORDER_STATES.FAILED, ORDER_STATES.REJECTED,
]);

/**
 * What the parent should be, given its legs.
 *
 * Pure, and separated from the write so the RULE can be tested without a
 * database and without a merchant. It reads as the sentence it implements.
 */
export function parentStateFor(legs) {
  if (!legs?.length) return null;
  const states = legs.map((leg) => leg.status ?? leg.state);
  if (!states.every((s) => TERMINAL.includes(s))) {
    // Still going. Once ANY leg is being worked on, the withdrawal is under
    // way — a player watching one order should not see "queued" while a
    // merchant is already at a machine for part of it.
    const started = states.some((s) => s !== ORDER_STATES.PENDING_QUEUE);
    return started ? ORDER_STATES.PROCESSING : null;
  }
  // Every leg is done. One that paid ANY part of it is a withdrawal that
  // happened: the player has money that a cancelled leg does not take back.
  const paidSomething = states.includes(ORDER_STATES.COMPLETED);
  return paidSomething ? ORDER_STATES.COMPLETED : ORDER_STATES.CANCELLED;
}

/**
 * Bring the parent into line with its legs, if it has one.
 *
 * Safe to call after ANY leg changes state, including repeatedly: each
 * transition is guarded by `ALLOWED_FROM` in the UPDATE's WHERE clause, so a
 * parent already in the target state matches no row and the call is a no-op
 * rather than an error. That matters because the callers are ordinary request
 * handlers that can race each other — two legs completing at the same instant
 * both see "all terminal" and both try to complete the parent.
 *
 * Never throws into its caller. The leg's own transition and its money have
 * already committed by the time this runs, and a container's display state is
 * not worth failing a request that has moved cash.
 *
 * @returns the state the parent was moved to, or null if nothing changed.
 */
export async function advanceParentFor(leg) {
  const parentId = leg?.parentOrderId;
  if (!parentId) return null;

  try {
    const legs = await db.orders.getOrderLegs(parentId);
    const want = parentStateFor(legs);
    if (!want) return null;

    const parent = await db.orders.getOrderRecord(parentId);
    if (!parent || parent.status === want) return null;

    // PROCESSING first when the parent is still queued: COMPLETED is only
    // reachable from PROCESSING (or PAID/DISPUTED), so a withdrawal whose legs
    // all finish before this ever ran would otherwise be stuck at
    // PENDING_QUEUE with every leg paid.
    if (want !== ORDER_STATES.PENDING_QUEUE && parent.status === ORDER_STATES.PENDING_QUEUE) {
      await startOrder(parentId, { actor: 'system', reason: 'A leg of this withdrawal is being worked on' });
    }
    if (want === ORDER_STATES.PROCESSING) return ORDER_STATES.PROCESSING;

    const move = want === ORDER_STATES.COMPLETED ? completeOrder : cancelOrder;
    const moved = await move(parentId, {
      actor: 'system',
      reason: want === ORDER_STATES.COMPLETED
        ? 'Every leg of this withdrawal has been settled'
        : 'Every leg of this withdrawal was cancelled',
    });
    return moved ? want : null;
  } catch (error) {
    // Loud, because a parent stuck out of step with its legs is a player told
    // their withdrawal is still running after it finished — but not fatal, for
    // the reason in the doc comment above.
    console.error(`[splitWithdrawal] could not advance parent ${parentId}:`, error.message);
    return null;
  }
}
