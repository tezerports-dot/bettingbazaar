// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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

import mongoose from 'mongoose';
import {
  debitForBet        as _debitForBet,
  creditWinnings     as _creditWinnings,
  debitWinningsForWithdrawal as _debitWinningsForWithdrawal,
  refundOrder        as _refundOrder,
  adminAdjust        as _adminAdjust,
  getUserLedger      as _getUserLedger,
} from './wallet.service.js';

// ── Internal ledger helper (for operations wallet.service.js doesn't cover) ──

function round2(n) { return Math.round((n || 0) * 100) / 100; }

async function _appendLedger(session, userId, field, type, amount, before, after, reason, refModel, txId) {
  const WalletLedger = mongoose.model('WalletLedger');
  await WalletLedger.create([{
    userId, type, field, amount,
    balanceBefore: before, balanceAfter: after,
    reason, refModel, txId,
  }], { session });
}

// ── PUBLIC API ────────────────────────────────────────────────────────────────

/**
 * Debit bet stake from depositBalance (primary) then winningsBalance.
 * Idempotent via txId. Writes WalletLedger. Pushes SSE balance update.
 */
export async function debitForBet(userId, amount, betId, cycleId, session) {
  return _debitForBet(
    userId, amount,
    `Bet ₹${amount} on cycle ${cycleId}`,
    'Bet', betId,
    `bet_${userId}_${cycleId}_${betId}`,
    session
  );
}

/**
 * Credit winnings to winningsBalance.
 * Idempotent via txId. Writes WalletLedger. Pushes SSE balance update.
 *
 * Overloaded signatures:
 *   creditWinnings(userId, amount, reason, refId, txId)          ← gameEngine / settlement
 *   creditWinnings(userId, amount, reason, refModel, refId, txId) ← direct calls
 */
export async function creditWinnings(userId, amount, reason, refIdOrModel, txIdOrRefId, maybeTxId) {
  // Detect which overload was used
  let refModel, refId, txId;
  if (maybeTxId !== undefined) {
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
  return _creditWinnings(userId, amount, reason || 'Bet win payout', refModel, refId, txId);
}

/**
 * Credit F1 referral commission to winningsBalance.
 * Uses unique txId to prevent double-crediting across retries.
 */
export async function creditCommission(referrerId, amount, fromUserId, cycleId) {
  const txId = `commission_${referrerId}_${fromUserId}_${cycleId}`;
  return _creditWinnings(
    referrerId, amount,
    `F1 commission from cycle ${cycleId}`,
    'Commission', null,
    txId
  );
}

/**
 * Lock winningsBalance for a pending withdrawal request.
 * Atomically moves amount from winningsBalance → lockedBalance.
 * Writes WalletLedger. Safe to retry (idempotent via withdrawalId).
 */
export async function lockWithdrawal(userId, amount, withdrawalId) {
  const txId = `wd_lock_${withdrawalId}`;
  const User         = mongoose.model('User');
  const WalletLedger = mongoose.model('WalletLedger');

  // Idempotency
  if (await WalletLedger.findOne({ txId }).lean()) {
    return { idempotent: true, txId };
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const user = await User.findById(userId).session(session);
      if (!user) throw new Error('User not found');

      const winBal = round2(user.winningsBalance || 0);
      if (winBal < amount)
        throw new Error(`Insufficient withdrawable balance: have ₹${winBal}, need ₹${amount}`);

      const newWinnings = round2(winBal - amount);
      const newLocked   = round2((user.lockedBalance || 0) + amount);

      await User.findOneAndUpdate(
        { _id: userId, winningsBalance: { $gte: amount } },
        { $inc: { winningsBalance: -amount, lockedBalance: amount } },
        { session }
      );

      await _appendLedger(session, userId, 'winningsBalance', 'DEBIT',
        amount, winBal, newWinnings,
        `Withdrawal locked — request ${withdrawalId}`,
        'PaymentOrder', txId
      );

      result = { winningsBefore: winBal, winningsAfter: newWinnings, lockedAfter: newLocked, txId };
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * Approve withdrawal — burn lockedBalance (money leaves platform).
 * Writes WalletLedger entry. Idempotent.
 */
export async function releaseWithdrawal(userId, amount, withdrawalId) {
  const txId = `wd_release_${withdrawalId}`;
  const User         = mongoose.model('User');
  const WalletLedger = mongoose.model('WalletLedger');

  if (await WalletLedger.findOne({ txId }).lean()) {
    return { idempotent: true, txId };
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const user = await User.findById(userId).session(session);
      if (!user) throw new Error('User not found');

      const lockedBal = round2(user.lockedBalance || 0);
      const newLocked = round2(lockedBal - amount);

      if (newLocked < 0)
        throw new Error(`lockedBalance would go negative: current=${lockedBal} debit=${amount}`);

      await User.findByIdAndUpdate(userId,
        { $inc: { lockedBalance: -amount } },
        { session }
      );

      await _appendLedger(session, userId, 'winningsBalance', 'DEBIT',
        amount, lockedBal, newLocked,
        `Withdrawal approved — request ${withdrawalId}`,
        'PaymentOrder', txId
      );

      result = { lockedBefore: lockedBal, lockedAfter: newLocked, txId };
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * Reject withdrawal — return lockedBalance to winningsBalance.
 * Writes WalletLedger entry. Idempotent.
 */
export async function refundWithdrawal(userId, amount, withdrawalId) {
  return _refundOrder(userId, amount, withdrawalId, 'winningsBalance');
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
  const User         = mongoose.model('User');
  const WalletLedger = mongoose.model('WalletLedger');

  // Fast path — this unlock already happened (re-run / recovery).
  if (await WalletLedger.findOne({ txId }).lean()) {
    return { idempotent: true, txId };
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const user = await User.findById(userId).session(session);
      if (!user) throw new Error('User not found');
      const before = round2(user.lockedBalance || 0);
      const after  = round2(before - amount);

      // Ledger FIRST inside the transaction: its unique txId index is the
      // race gate — if a concurrent pass committed the same txId, this
      // insert throws and the transaction (including the $inc) aborts.
      await _appendLedger(session, userId, 'lockedBalance', 'DEBIT',
        amount, before, after, reason || 'Bet stake unlock — cycle settlement',
        'Bet', txId
      );

      await User.findByIdAndUpdate(userId, {
        $inc: {
          lockedBalance:        -amount,
          lockedDepositAmount:  -(fromDeposit  || 0),
          lockedWinningsAmount: -(fromWinnings || 0),
        }
      }, { session });

      result = { lockedBefore: before, lockedAfter: after, txId };
    });
    return result;
  } catch (err) {
    if (err?.code === 11000 || /duplicate key/i.test(err?.message || '')) {
      return { idempotent: true, txId };
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

/**
 * Admin manual balance adjustment.
 * type = 'CREDIT' | 'DEBIT'
 * field = 'depositBalance' | 'winningsBalance'
 */
export async function adminAdjustment(adminId, userId, type, field, amount, reason, adjustmentId) {
  return _adminAdjust(userId, type, field, amount, `[Admin:${adminId}] ${reason}`, adjustmentId);
}


export async function creditDeposit(userId, amount, orderId, extSession) {
  const { creditDeposit: _cd } = await import('./wallet.service.js');
  return _cd(userId, amount, orderId, extSession);
}

/**
 * Credit a deposit's reserve-allocation share to reserveBalance — the
 * sanctioned single writer for reserveBalance (§7). Idempotent, ledgered.
 */
export async function creditReserve(userId, amount, orderId, extSession) {
  const { creditReserve: _cr } = await import('./wallet.service.js');
  return _cr(userId, amount, orderId, extSession);
}


export async function debitWinningsForWithdrawal(userId, amount, orderId, extSession) {
  return _debitWinningsForWithdrawal(userId, amount, orderId, extSession);
}

/**
 * Refund balance for a cancelled/rejected order.
 * Accepts field param: 'depositBalance' or 'winningsBalance'.
 * Unlike refundWithdrawal, this does not hardcode the balance field.
 */
export async function refundOrder(userId, amount, orderId, field, extSession) {
  return _refundOrder(userId, amount, orderId, field, extSession);
}

/**
 * Read paginated WalletLedger entries for a user.
 */
export async function getUserLedger(userId, page, limit) {
  return _getUserLedger(userId, page, limit);
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
  return _debitForBet(userId, amount, reason, 'GameTransaction', null, txId);
}
