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
import { db } from '#db';
import { paiseToRupees } from '../../shared/money.js';
import { notify } from '../communication/communication.service.js';
import { sendAlert } from '../../services/alerting.service.js';
import * as pg from '#db/repositories/wallets.js';
import { UsdtCreditRefused } from '#db/repositories/usdtDeposits.js';
import { completeOrder } from '../payment/orderLifecycle.service.js';
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
  if (b) sseBalancePush(userId, b);
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

/** `getBalances` for many users in one query: `{ [userId]: balances }`. Display only. */
export async function getBalancesMany(userIds) {
  return pg.getBalancesMany(userIds);
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
  let refModel, refId, txId;
  if (maybeSession !== undefined) {
    // 7-arg: (userId, amount, reason, refModel, refId, txId, session); the
    // session is a leftover of the document store and is not used.
    refModel  = refIdOrModel;
    refId     = txIdOrRefId;
    txId      = maybeTxId;
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
  return pg.lockWithdrawal(userId, amount, withdrawalId);
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
  return pushBalances(userId, await pg.refundWithdrawal(userId, amount, withdrawalId));
}

// ── A player's half of a team pool movement ─────────────────────────────────
// A completed buy, a settled sell and a settled sell refunded move the team's
// pool, the player's wallet and the treasury between them in ONE transaction,
// and the database refuses any of the three alone (owner, 2026-10-07). The
// transaction is `teamPools.js`'s, which takes the order and pool locks first;
// the wallet half inside it is `wallets.js`'s `…Within`. These are the doors.

/**
 * A completed BUY: the team's held tokens to the player, split by the order's
 * own allocation. `requireState` is asked under the order's lock.
 * @returns {Promise<{ok:boolean, reason?:string, alreadyTaken?:boolean}>}
 */
export async function completeBuy(orderId, { actor = 'deposit-credit', requireState } = {}) {
  const done = await db.teamPools.spendForBuy(orderId, { actor, requireState });
  if (done.ok && done.balances) pushBalances(done.userId, { balances: rupeeBalances(done.balances) });
  const bonus = done.ok ? done.firstDepositBonus : null;
  if (bonus?.paid) {
    // After commit, and never able to undo it: a notice that fails is logged.
    notify({
      userId: done.userId, type: 'SUCCESS', title: 'First deposit bonus',
      message: `₹${paiseToRupees(bonus.amountPaise)} is in your General balance. Play it and it unlocks into withdrawable winnings; see Wallet › General for how.`,
    }).catch((e) => console.warn('[completeBuy] first deposit bonus notice failed:', e?.message));
  } else if (bonus?.refused) {
    // The buy completed; the bonus did not. Somebody must look.
    sendAlert(`first-deposit-bonus-refused:${orderId}`, 'First deposit bonus refused; the buy completed without it',
      { orderId: String(orderId), reason: bonus.refused }).catch(() => {});
  }
  return done;
}

/**
 * A USDT buy paid on chain to the platform's own address (owner, 2026-10-18):
 * the order's COMPLETED transition and the credit out of the platform's
 * holding commit together (`usdtDeposits.creditUsdtBuyWithin`, run inside the
 * transition under the order's lock). Not covered yet, or refused: nothing
 * moved, and the answer says why.
 * @returns {Promise<{ok:boolean, idempotent?:boolean, reason?:string, detail?:object, order?:object, credit?:object}>}
 */
export async function completeUsdtBuy(orderId, { actor = 'usdt-watcher' } = {}) {
  let credit = null;
  let moved;
  try {
    moved = await completeOrder(orderId, {
      expectFrom: 'PROCESSING', actor, reason: 'USDT received on chain',
      within: async (client) => { credit = await db.usdtDeposits.creditUsdtBuyWithin(client, orderId, { actor }); },
    });
  } catch (e) {
    if (e instanceof UsdtCreditRefused) return { ok: false, reason: e.reason, detail: e.detail };
    throw e;
  }
  if (!moved.ok) return { ok: false, reason: moved.reason, status: moved.status };
  if (moved.idempotent || !credit) return { ok: true, idempotent: true, order: moved.order };
  if (credit.balances) pushBalances(credit.userId, { balances: rupeeBalances(credit.balances) });
  const bonus = credit.firstDepositBonus;
  if (bonus?.paid) {
    notify({
      userId: credit.userId, type: 'SUCCESS', title: 'First deposit bonus',
      message: `₹${paiseToRupees(bonus.amountPaise)} is in your General balance. Play it and it unlocks into withdrawable winnings; see Wallet › General for how.`,
    }).catch((e) => console.warn('[completeUsdtBuy] first deposit bonus notice failed:', e?.message));
  } else if (bonus?.refused) {
    sendAlert(`first-deposit-bonus-refused:${orderId}`, 'First deposit bonus refused; the buy completed without it',
      { orderId: String(orderId), reason: bonus.refused }).catch(() => {});
  }
  return { ok: true, order: moved.order, credit };
}

/**
 * A SELL settles: the player's locked stake to the team's pool. No push — the
 * locked stake is not on the player's balance widget.
 */
export async function settleSell(orderId, { actor = 'system', requireState = null } = {}) {
  return db.teamPools.creditSellToPool(orderId, { actor, requireState });
}

/**
 * A settled SELL refunded: the tokens back out of the pool (or the platform
 * covers them) and the stake back to the player as winnings.
 */
export async function refundSettledSell(orderId, { actor = 'admin', reason = null, coverShortfall = false } = {}) {
  const done = await db.teamPools.reverseSellFromPool(orderId, { actor, reason, coverShortfall });
  if (done.ok && done.balances) pushBalances(done.userId, { balances: rupeeBalances(done.balances) });
  return done;
}

function rupeeBalances(paise) {
  return Object.fromEntries(Object.entries(paise).map(([f, v]) => [f, paiseToRupees(v)]));
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


/**
 * Lock winnings for a withdrawal. `within` is the order's prepared INSERT
 * (`db.orders.prepareOrderRecord`): it commits in the SAME transaction as the
 * lock, so the lock can never exist without the order that releases it.
 */
export async function debitWinningsForWithdrawal(userId, amount, orderId, { within = null } = {}) {
  return pushBalances(userId, await pg.debitWinningsForWithdrawal(userId, amount, orderId, { within }));
}

/**
 * Read paginated WalletLedger entries for a user.
 */
export async function getUserLedger(userId, page, limit) {
  return pg.getUserLedger(userId, page, limit);
}
