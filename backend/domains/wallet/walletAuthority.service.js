// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * walletAuthority.service.js
 * ══════════════════════════════════════════════════════════════════════════════
 * THE SOLE authority for all balance mutations in Betting Bazaar.
 *
 * Architecture facts (read from actual repo):
 *  - Backend is ESM ("type":"module" in package.json) → uses import/export
 *  - User schema has flat fields: depositBalance, winningsBalance, lockedBalance,
 *    lockedDepositAmount, lockedWinningsAmount  (NOT user.wallet.*)
 *  - WalletLedger already exists in wallet.model.js with txId uniqueness guard
 *  - the wallet writers live in postgres/walletPg.js — this service wraps them
 *    and adds the missing withdrawal lifecycle + admin paths
 *
 * This is the single-entry-point
 * that every route and engine must call for balance mutations. It delegates
 * for bet/credit/debit operations (keeping SSE push,
 * idempotency, and ledger logic intact) and adds the missing pieces.
 * ══════════════════════════════════════════════════════════════════════════════
 */

import { sseBalancePush } from '../notification/realtimeEmitters.js';
import * as pg from '#db/repositories/wallets.js';
import { applyAdjustment, listAdjustments, ADJUSTABLE_FIELDS } from '#db/repositories/balanceAdjustments.js';

/** Pockets an admin may adjust by hand. Re-exported so routes validate against
 *  the same list the writer enforces, rather than a second copy that drifts. */
export { ADJUSTABLE_FIELDS };

/**
 * Push the new balances to the user's SSE channel after a mutation.
 *
 * Only for the operations that are meant to have it. Reserve credits and
 * withdrawal locking deliberately do not push: the first is not the player's
 * money to see move, and the second would show a balance dropping before the
 * withdrawal it belongs to has been admitted.
 */
function pushBalances(userId, result) {
  const b = result?.balances;
  if (b) sseBalancePush(userId, b.depositBalance || 0, b.winningsBalance || 0);
  return result;
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * getBalances — THE read counterpart to this module's write authority.
 *
 * Direct `user.depositBalance` property access reads a field that does not
 * exist on the accounts table: balances live in `wallets`, behind the row lock
 * the write itself takes. A second copy of one would be a second writer waiting
 * to disagree with the first, which is how an affordability check came to be
 * decided from one number and executed against another.
 *
 * `scripts/audit-balance-reads.mjs` finds every read that bypasses this, and
 * fails the build when one of them GATES money rather than merely displaying it.
 */
export async function getBalances(userId) {
  return pg.getBalances(userId);
}


// ── PUBLIC API ────────────────────────────────────────────────────────────────

/**
 * Credit winnings to winningsBalance.
 * Idempotent via txId. Writes WalletLedger. Pushes SSE balance update.
 *
 * Overloaded signatures:
 *   creditWinnings(userId, amount, reason, refId, txId)          ← gameEngine / settlement
 *   creditWinnings(userId, amount, reason, refModel, refId, txId) ← direct calls
 */
export async function creditWinnings(userId, amount, reason, refIdOrModel, txIdOrRefId, maybeTxId, maybeSession) {
  // Detect which overload was used
  let refModel, refId, txId, session;
  if (maybeSession !== undefined) {
    // 7-arg: (userId, amount, reason, refModel, refId, txId, session)
    refModel  = refIdOrModel;
    refId     = txIdOrRefId;
    txId      = maybeTxId;
    session   = maybeSession;
  } else if (maybeTxId !== undefined) {
    // 6-arg: (userId, amount, reason, refModel, refId, txId)
    refModel  = refIdOrModel;
    refId     = txIdOrRefId;
    txId      = maybeTxId;
  } else {
    // 5-arg: (userId, amount, reason, refId, txId)
    refModel  = 'Bet';
    refId     = refIdOrModel;
    txId      = txIdOrRefId;
  }
  return pushBalances(userId, await pg.creditWinnings(userId, amount, reason, refModel, refId, txId));
}

/**
 * Lock winningsBalance for a pending withdrawal request.
 * Atomically moves amount from winningsBalance → lockedBalance.
 * Writes WalletLedger. Safe to retry (idempotent via withdrawalId).
 *
 * ⚠️ NO PRODUCTION CALLER as of 2026-08-24. Its only one was the parallel
 * withdrawal system removed that day (see domains/user/user.routes.js). The
 * LIVE P2P path performs the identical movement — winnings → locked, one ledger
 * row — through `debitWinningsForWithdrawal` (txId `wd_<orderId>`, refModel
 * PaymentOrder), called from paymentProcessing.createWithdrawalOrder.
 *
 * Two primitives for one movement is what let a reviewer harden the withdrawal
 * path nobody used, so DO NOT build on this one: new work belongs on
 * `debitWinningsForWithdrawal`. It is kept only because three integration suites
 * use it to set up a locked balance for the release/refund tests, and its
 * Postgres twin carries the concurrency coverage in walletPgAuthority.test.js.
 * Retiring it means repointing those suites — worth doing, but as its own change
 * with CI to prove it, not folded into an unrelated one.
 */
export async function lockWithdrawal(userId, amount, withdrawalId) {
  const txId = `wd_lock_${withdrawalId}`;
  return pg.lockWithdrawal(userId, amount, withdrawalId);
}

/**
 * Approve withdrawal — burn lockedBalance (money leaves platform).
 * Writes WalletLedger entry. Idempotent.
 */
export async function releaseWithdrawal(userId, amount, withdrawalId) {
  const txId = `wd_release_${withdrawalId}`;
  return pg.releaseWithdrawal(userId, amount, withdrawalId);
}

/**
 * Reject withdrawal — return the locked amount to winningsBalance.
 * Writes WalletLedger entry. Idempotent.
 *
 * FIXED 2026-07-10 (caught by withdrawalBonus.integration.test.js): this
 * used to delegate to _refundOrder, which credits winningsBalance but never
 * releases lockedBalance — every REJECTED withdrawal left the amount
 * stranded as "in play" forever (approve released it; reject didn't). Now
 * the reversal of lockWithdrawal is atomic: winnings +amount, locked
 * −amount, one ledger entry. txId format `refund_<id>` is kept identical to
 * the old delegation so historical idempotency continuity holds.
 */
export async function refundWithdrawal(userId, amount, withdrawalId) {
  const txId = `refund_${withdrawalId}`;
  return pg.refundWithdrawal(userId, amount, withdrawalId);
}

/**
 * releaseLockedStake — settle-time release of a bet's locked stake (F-2,
 * 2026-07-10). THE sanctioned writer for lockedBalance/lockedDepositAmount/
 * lockedWinningsAmount at settlement (§7) — replaces the raw `$inc`s that
 * lived in domains/settlement/settlementService.js.
 *
 * Concurrency contract: settlement passes can legitimately overlap (engine
 * tick + payout recovery task, or two nodes — the cycle lock re-admits
 * PROCESSING on purpose). Safety comes from the ledger's UNIQUE txId index
 * acting as the atomic gate: the ledger insert and the balance `$inc`
 * happen inside one transaction, so a concurrent duplicate aborts the
 * whole transaction (11000 / transient write-conflict retry → 11000) and
 * the `$inc` never lands twice. Callers pass a deterministic txId
 * (`unlock_win_<anchorBetId>` for wins, `unlock_lost_<betId>` for losses —
 * the loss format predates F-2, preserving idempotency continuity with
 * historical ledger entries).
 */
export async function releaseLockedStake(userId, { amount, fromDeposit = 0, fromWinnings = 0, txId, reason }) {
  if (!txId) throw new Error('releaseLockedStake requires a deterministic txId');
  if (!(amount > 0)) throw new Error(`releaseLockedStake: invalid amount ${amount}`);
  return pg.releaseLockedStake(userId, { amount, fromDeposit, fromWinnings, txId, reason });
}



/**
 * Admin manual balance adjustment — money and its audit row, one transaction.
 *
 * ── `field` used to be accepted and ignored ─────────────────────────────────
 * This function took a `field` argument and never passed it on: every CREDIT
 * went to winnings and every DEBIT came out of deposit first, whatever the
 * admin named. So an admin debiting winnings moved deposit, and the audit row
 * recorded the pocket they asked for rather than the one that moved. It now
 * credits and debits the pocket it was given, and refuses a pocket it cannot
 * honour instead of silently substituting one (`ADJUSTABLE_FIELDS`).
 *
 * ── The refusal moved inside the lock ───────────────────────────────────────
 * Both callers decided "insufficient balance" from the account document before
 * calling, which is a number nothing was going to debit. The check now happens
 * against the locked wallet row, where it cannot be stale, and comes back as a
 * RETURNED refusal rather than a thrown error — see the return shape.
 *
 * @returns {{ok:true, adjustment, balances, beforeRupees, afterRupees}}
 *          {{ok:false, reason:'INSUFFICIENT', availableRupees}}
 *          {{ok:true, idempotent:true, adjustment}}
 */
export async function adminAdjustment(adminId, userId, type, field, amount, reason, adjustmentId) {
  const result = await applyAdjustment({
    adjustmentId, userId, adminId, type, field,
    amountRupees: amount, reason,
  });
  if (result.ok && result.balances) pushBalances(userId, result);
  return result;
}

/** The adjustment history — read side of the above. */
export async function getBalanceAdjustments(filter) {
  return listAdjustments(filter);
}


export async function creditDeposit(userId, amount, orderId) {
  return pushBalances(userId, await pg.creditDeposit(userId, amount, orderId));
}

/**
 * Credit a deposit's reserve-allocation share to reserveBalance — the
 * sanctioned single writer for reserveBalance (§7). Idempotent, ledgered.
 */
export async function creditReserve(userId, amount, orderId) {
  // No SSE push here — see pushBalances: the reserve is not the player's money
  // to watch move, and it is not shown on the balance widget.
  return pg.creditReserve(userId, amount, orderId);
}


/**
 * Lock winnings for a withdrawal. `within` is the order's prepared INSERT
 * (`db.orders.prepareOrderRecord`): it commits in the SAME transaction as the
 * lock, so the lock can never exist without the order that releases it.
 */
export async function debitWinningsForWithdrawal(userId, amount, orderId, { within = null } = {}) {
  return pushBalances(userId, await pg.debitWinningsForWithdrawal(userId, amount, orderId, { within }));
}

/**
 * Refund balance for a cancelled/rejected order.
 * Accepts field param: 'depositBalance' or 'winningsBalance'.
 * Unlike refundWithdrawal, this does not hardcode the balance field.
 */
export async function refundOrder(userId, amount, orderId, field) {
  return pushBalances(userId, await pg.refundOrder(userId, amount, orderId, field));
}

/**
 * Read paginated WalletLedger entries for a user.
 */
export async function getUserLedger(userId, page, limit) {
  return pg.getUserLedger(userId, page, limit);
}
