// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
 *  - wallet.service.js already has correct patterns — this service wraps it
 *    and adds the missing withdrawal lifecycle + admin paths
 *
 * This is NOT a rewrite of wallet.service.js. It is the single-entry-point
 * that every route and engine must call for balance mutations. It delegates
 * to wallet.service.js for bet/credit/debit operations (keeping SSE push,
 * idempotency, and ledger logic intact) and adds the missing pieces.
 * ══════════════════════════════════════════════════════════════════════════════
 */

import { sseBalancePush } from './wallet.service.js';
import { rupeesToPaise } from '../../shared/money.js';
import * as pg from '../../postgres/walletPgAuthority.js';

// ── Source-of-truth routing (hybrid money DB, LAUNCH_READINESS.md §E) ────────
/**
 * Which store owns balances right now. MongoDB unless an operator has
 * deliberately set MONEY_AUTHORITY_WALLET=postgres on a deploy that has a
 * DATABASE_URL — see postgres/moneyAuthority.js, which also refuses an
 * incoherent combination at boot.
 *
 * This is asked PER CALL rather than cached at import time so a process does
 * not have to be rebuilt to be re-pointed, and so tests can exercise both
 * halves in one run.
 */
/**
 * The Postgres path returns balances with every mutation; the Mongo path pushes
 * them to the user's SSE channel as a side effect. This keeps that behaviour
 * identical across the two, for the operations that had it — the ones that
 * never pushed (reserve credits, withdrawal locking) still do not.
 */
function pushBalances(userId, result) {
  const b = result?.balances;
  if (b) sseBalancePush(userId, b.depositBalance || 0, b.winningsBalance || 0);
  return result;
}

// ── Internal ledger helper (for operations wallet.service.js doesn't cover) ──

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
 * Debit bet stake from depositBalance (primary) then winningsBalance.
 * Idempotent via txId. Writes WalletLedger. Pushes SSE balance update.
 */
export async function debitForBet(userId, amount, betId, cycleId, session) {
  const reason = `Bet ₹${amount} on cycle ${cycleId}`;
  const txId = `bet_${userId}_${cycleId}_${betId}`;
  return pushBalances(userId, await pg.debitForBet(userId, amount, reason, 'Bet', betId, txId));
}

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
 * lockBetStake — bet placement: move the stake out of its pockets into
 * `locked`, recording which pocket each slice came from.
 *
 * THE sanctioned writer for a bet's stake lock (§7). This logic used to live
 * inline in domains/markets/bet.routes.js as a raw three-field `$inc`, which
 * meant balances had two writers and the money-authority switch could not
 * reach one of them — flipping the wallet path would have split the source of
 * truth mid-bet.
 *
 * @param {object} args
 * @param {number} args.amount  the full stake (locked gains exactly this)
 * @param {string} args.txId    base key; each slice's row is `${txId}${suffix}`
 * @param {Array<{field:string, suffix:string, amount:number, reason:string}>} args.slices
 *   must sum to `amount` — the pockets the stake is drawn from, already split
 *   by the risk domain's funding plan.
 * @returns {Promise<{ok, insufficient?, balances?}>}
 */
export async function lockBetStake(userId, { amount, txId, refId, slices }) {
  return pg.lockBetStake(userId, {
    amountPaise: rupeesToPaise(amount), txId, refId,
    slices: slices.map((s) => ({ ...s, amountPaise: rupeesToPaise(s.amount) })),
  });
}

/**
 * unlockBetStake — the exact reverse, for the compensating path when the cycle
 * closes between the stake debit and the pool commit.
 */
export async function unlockBetStake(userId, { amount, txId, refId, slices }) {
  return pg.unlockBetStake(userId, {
    amountPaise: rupeesToPaise(amount), txId, refId,
    slices: slices.map((s) => ({ ...s, amountPaise: rupeesToPaise(s.amount) })),
  });
}

/** Lock provenance counters, by the pocket they track. Reserve has none. */
const LOCK_PROVENANCE = {
  depositBalance:  'lockedDepositAmount',
  winningsBalance: 'lockedWinningsAmount',
};


/**
 * Admin manual balance adjustment.
 * type = 'CREDIT' | 'DEBIT'
 * field = 'depositBalance' | 'winningsBalance'
 */
export async function adminAdjustment(adminId, userId, type, field, amount, reason, adjustmentId) {
  const fullReason = `[Admin:${adminId}] ${reason}`;
  const txId = `admin_${adjustmentId}`;
  return pushBalances(userId, type === 'CREDIT'
    ? await pg.creditWinnings(userId, amount, fullReason, 'AdminAdjustment', adjustmentId, txId)
    // Admin debit: same spend order as a bet (deposit first, winnings shortfall).
    : await pg.debitForBet(userId, amount, fullReason, 'AdminAdjustment', adjustmentId, txId));
}


export async function creditDeposit(userId, amount, orderId, extSession) {
  return pushBalances(userId, await pg.creditDeposit(userId, amount, orderId));
}

/**
 * Credit a deposit's reserve-allocation share to reserveBalance — the
 * sanctioned single writer for reserveBalance (§7). Idempotent, ledgered.
 */
export async function creditReserve(userId, amount, orderId, extSession) {
  // No SSE push here — the Mongo counterpart does not push either, and the
  // reserve pocket is not shown on the balance widget.
  return pg.creditReserve(userId, amount, orderId);
}


export async function debitWinningsForWithdrawal(userId, amount, orderId, extSession) {
  return pushBalances(userId, await pg.debitWinningsForWithdrawal(userId, amount, orderId));
}

/**
 * Refund balance for a cancelled/rejected order.
 * Accepts field param: 'depositBalance' or 'winningsBalance'.
 * Unlike refundWithdrawal, this does not hardcode the balance field.
 */
export async function refundOrder(userId, amount, orderId, field, extSession) {
  return pushBalances(userId, await pg.refundOrder(userId, amount, orderId, field));
}

/**
 * Read paginated WalletLedger entries for a user.
 */
export async function getUserLedger(userId, page, limit) {
  return pg.getUserLedger(userId, page, limit);
}

/**
 * Debit deposit balance for a third-party game provider bet.
 * Preserves exact WalletLedger semantics of the original wallet.service call:
 *   refModel = 'GameTransaction', txId = raw provider txId (for idempotency).
 * Do NOT replace with debitForBet() — that function uses a different
 * refModel ('Bet') and a generated txId format which would break
 * existing ledger records and idempotency guards.
 */
export async function debitForGameProviderBet(userId, amount, reason, txId) {
  return pushBalances(userId, await pg.debitForBet(userId, amount, reason, 'GameTransaction', null, txId));
}
