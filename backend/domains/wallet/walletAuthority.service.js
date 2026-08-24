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

import mongoose from 'mongoose';
import {
  debitForBet        as _debitForBet,
  creditWinnings     as _creditWinnings,
  debitWinningsForWithdrawal as _debitWinningsForWithdrawal,
  refundOrder        as _refundOrder,
  adminAdjust        as _adminAdjust,
  getUserLedger      as _getUserLedger,
  sseBalancePush,
} from './wallet.service.js';
import { rupeesToPaise } from '../../shared/money.js';
import { isPostgresAuthoritative, MONEY_PATHS } from '../../postgres/moneyAuthority.js';
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
function onPostgres() {
  return isPostgresAuthoritative(MONEY_PATHS.WALLET);
}

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

function round2(n) { return Math.round((n || 0) * 100) / 100; }

/**
 * getBalances — THE read counterpart to this module's write authority.
 *
 * Balance reads are scattered across the codebase as direct `user.depositBalance`
 * property access, which silently keeps reading MongoDB whatever the switch
 * says. Call sites move here incrementally; until one does, it is reading the
 * Mongo copy, which the reverse mirror keeps current — stale by at most a
 * reconcile pass rather than wrong, but not authoritative. Any NEW read of a
 * balance should go through this function.
 */
export async function getBalances(userId) {
  if (onPostgres()) return pg.getBalances(userId);

  const user = await mongoose.model('User').findById(userId)
    .select('depositBalance winningsBalance tokenBalance reserveBalance lockedBalance lockedDepositAmount lockedWinningsAmount')
    .lean();
  return {
    depositBalance:       round2(user?.depositBalance       || 0),
    winningsBalance:      round2(user?.winningsBalance      || 0),
    tokenBalance:         round2(user?.tokenBalance         || 0),
    reserveBalance:       round2(user?.reserveBalance       || 0),
    lockedBalance:        round2(user?.lockedBalance        || 0),
    lockedDepositAmount:  round2(user?.lockedDepositAmount  || 0),
    lockedWinningsAmount: round2(user?.lockedWinningsAmount || 0),
  };
}

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
  const reason = `Bet ₹${amount} on cycle ${cycleId}`;
  const txId = `bet_${userId}_${cycleId}_${betId}`;
  if (onPostgres()) {
    return pushBalances(userId, await pg.debitForBet(userId, amount, reason, 'Bet', betId, txId));
  }
  return _debitForBet(userId, amount, reason, 'Bet', betId, txId, session);
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
  if (onPostgres()) {
    return pushBalances(userId, await pg.creditWinnings(userId, amount, reason, refModel, refId, txId));
  }
  return _creditWinnings(userId, amount, reason || 'Bet win payout', refModel, refId, txId, session);
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
  if (onPostgres()) return pg.lockWithdrawal(userId, amount, withdrawalId);

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
  if (onPostgres()) return pg.releaseWithdrawal(userId, amount, withdrawalId);

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
  if (onPostgres()) return pg.refundWithdrawal(userId, amount, withdrawalId);

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

      const winBefore    = round2(user.winningsBalance || 0);
      const lockedBefore = round2(user.lockedBalance   || 0);
      const winAfter     = round2(winBefore + amount);
      const lockedAfter  = round2(lockedBefore - amount);
      if (lockedAfter < 0)
        throw new Error(`lockedBalance would go negative on refund: current=${lockedBefore} refund=${amount}`);

      // Ledger first — its unique txId index is the concurrency race gate
      // (same pattern as releaseLockedStake / wallet.service movers).
      await _appendLedger(session, userId, 'winningsBalance', 'CREDIT',
        amount, winBefore, winAfter,
        `Withdrawal rejected — request ${withdrawalId} refunded to winnings`,
        'PaymentOrder', txId
      );

      await User.findByIdAndUpdate(userId,
        { $inc: { winningsBalance: amount, lockedBalance: -amount } },
        { session }
      );

      result = { winningsBefore: winBefore, winningsAfter: winAfter, lockedAfter, txId };
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
  if (onPostgres()) {
    return pg.releaseLockedStake(userId, { amount, fromDeposit, fromWinnings, txId, reason });
  }

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
  if (onPostgres()) {
    return pg.lockBetStake(userId, {
      amountPaise: rupeesToPaise(amount), txId, refId,
      slices: slices.map((s) => ({ ...s, amountPaise: rupeesToPaise(s.amount) })),
    });
  }
  return _mongoBetStake(userId, { amount, txId, refId, slices, direction: 'LOCK' });
}

/**
 * unlockBetStake — the exact reverse, for the compensating path when the cycle
 * closes between the stake debit and the pool commit.
 */
export async function unlockBetStake(userId, { amount, txId, refId, slices }) {
  if (onPostgres()) {
    return pg.unlockBetStake(userId, {
      amountPaise: rupeesToPaise(amount), txId, refId,
      slices: slices.map((s) => ({ ...s, amountPaise: rupeesToPaise(s.amount) })),
    });
  }
  return _mongoBetStake(userId, { amount, txId, refId, slices, direction: 'UNLOCK' });
}

/** Lock provenance counters, by the pocket they track. Reserve has none. */
const LOCK_PROVENANCE = {
  depositBalance:  'lockedDepositAmount',
  winningsBalance: 'lockedWinningsAmount',
};

/**
 * The MongoDB half of lock/unlockBetStake — the behaviour bet.routes.js had,
 * moved here unchanged so the cutover switch is the only new variable.
 *
 * The `$gte` filters are what make the debit atomic: if a concurrent bet landed
 * between the caller's split and this write, the filter matches no document and
 * the caller is told to retry. Postgres achieves the same thing by holding the
 * wallet row lock while it computes the split, which is strictly stronger.
 */
async function _mongoBetStake(userId, { amount, txId, refId, slices, direction }) {
  const User         = mongoose.model('User');
  const WalletLedger = mongoose.model('WalletLedger');
  const locking = direction === 'LOCK';
  const sign = locking ? -1 : 1;   // sign applied to the source pockets

  // ── Idempotency fast-path (M-2) ─────────────────────────────────────────
  // Each slice's ledger row is `${txId}${suffix}` under a UNIQUE index, so a
  // REDELIVERED request (same txId) has already moved this money. Return the
  // current balances and move NOTHING again — the same guard lockWithdrawal /
  // releaseLockedStake above already apply to their own txIds. This is what
  // closes the double-debit the audit recorded as M-2 (`docs/MONGO_MONEY_AUDIT.md`):
  // now that the id is the caller's `Idempotency-Key`, a retry reuses it and this
  // gate fires. The residual is the same one every best-effort-ledger mover has —
  // if the ledger write itself failed on the first delivery (metered as an
  // unaudited movement) there is no row to find, and only then can a retry move
  // the money twice; the Postgres path has no such window and is the launch path.
  if (slices.length) {
    const prior = await WalletLedger.findOne({ txId: `${txId}${slices[0].suffix}` })
      .select('_id').lean();
    if (prior) {
      const u = await User.findById(userId)
        .select('depositBalance winningsBalance reserveBalance lockedBalance').lean();
      return {
        ok: true,
        idempotent: true,
        txId,
        balances: {
          depositBalance:  round2(u?.depositBalance  || 0),
          winningsBalance: round2(u?.winningsBalance || 0),
          reserveBalance:  round2(u?.reserveBalance  || 0),
          lockedBalance:   round2(u?.lockedBalance   || 0),
        },
      };
    }
  }

  const inc = { lockedBalance: locking ? amount : -amount };
  const filter = { _id: userId };
  for (const slice of slices) {
    inc[slice.field] = (inc[slice.field] || 0) + sign * slice.amount;
    const counter = LOCK_PROVENANCE[slice.field];
    if (counter) inc[counter] = (inc[counter] || 0) + (locking ? slice.amount : -slice.amount);
    if (locking) filter[slice.field] = { $gte: slice.amount };
  }

  // ── Atomic move: ledger FIRST, then the balance, in ONE transaction ──────
  // This is the exact shape releaseLockedStake / lockWithdrawal use above, and
  // the shape the Postgres path has by construction. Two guarantees fall out of
  // the ordering, and they are M-4 and the concurrent half of M-2:
  //   • The per-slice txId UNIQUE index is the race gate. A concurrent delivery
  //     of the same key throws 11000 on the ledger insert and aborts the WHOLE
  //     transaction, so the `$inc` cannot run twice — no double debit even when
  //     two requests slip past the fast-path above at the same instant.
  //   • Balance and ledger commit together or not at all. The old best-effort
  //     write — money moved, rows attempted afterwards, a failure only METERED
  //     as an unaudited movement — is gone: there is no window where a stake can
  //     move without the postings the trial balance is computed from.
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const before = await User.findById(userId).session(session).lean();
      if (!before) { const e = new Error('User not found'); e.__notFound = true; throw e; }

      // Sufficiency (LOCK only) against the transaction snapshot: a concurrent
      // bet may have drained a pocket since the caller computed the split.
      const balanceAfter = {};
      for (const slice of slices) {
        const cur = round2(before[slice.field] || 0);
        if (locking && cur < slice.amount) { const e = new Error('insufficient'); e.__insufficient = true; throw e; }
        balanceAfter[slice.field] = round2(cur + sign * slice.amount);
      }

      // 1. Ledger rows first — the UNIQUE txId index is the idempotency gate.
      const rows = slices.map((slice) => ({
        userId,
        type: locking ? 'DEBIT' : 'CREDIT',
        field: slice.field,
        amount: slice.amount,
        balanceBefore: round2(before[slice.field] || 0),
        balanceAfter:  balanceAfter[slice.field],
        reason: slice.reason,
        refModel: 'Bet',
        refId,
        txId: `${txId}${slice.suffix}`,
      }));
      if (rows.length) await WalletLedger.insertMany(rows, { session, ordered: true });

      // 2. Balance move, still guarded by $gte so a race the snapshot read
      //    missed cannot over-draw. No match ⇒ insufficient ⇒ abort.
      const updated = await User.findOneAndUpdate(filter, { $inc: inc }, { new: true, session });
      if (!updated) { const e = new Error('insufficient'); e.__insufficient = true; throw e; }

      result = {
        ok: true,
        txId,
        balances: {
          depositBalance:  round2(updated.depositBalance  || 0),
          winningsBalance: round2(updated.winningsBalance || 0),
          reserveBalance:  round2(updated.reserveBalance  || 0),
          lockedBalance:   round2(updated.lockedBalance   || 0),
        },
      };
    });
    return result;
  } catch (err) {
    if (err?.__insufficient) return { ok: false, insufficient: true, txId };
    if (err?.__notFound)     return { ok: false, insufficient: true, txId };
    if (err?.code === 11000 || /duplicate key/i.test(err?.message || '')) {
      // A concurrent delivery of the same txId committed first: the money moved
      // exactly once (theirs). Report ours as the idempotent replay it is.
      const u = await User.findById(userId)
        .select('depositBalance winningsBalance reserveBalance lockedBalance').lean();
      return {
        ok: true, idempotent: true, txId,
        balances: {
          depositBalance:  round2(u?.depositBalance  || 0),
          winningsBalance: round2(u?.winningsBalance || 0),
          reserveBalance:  round2(u?.reserveBalance  || 0),
          lockedBalance:   round2(u?.lockedBalance   || 0),
        },
      };
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
  const fullReason = `[Admin:${adminId}] ${reason}`;
  if (onPostgres()) {
    const txId = `admin_${adjustmentId}`;
    return pushBalances(userId, type === 'CREDIT'
      ? await pg.creditWinnings(userId, amount, fullReason, 'AdminAdjustment', adjustmentId, txId)
      // Admin debit: same spend order as a bet (deposit first, winnings shortfall).
      : await pg.debitForBet(userId, amount, fullReason, 'AdminAdjustment', adjustmentId, txId));
  }
  return _adminAdjust(userId, type, field, amount, fullReason, adjustmentId);
}


export async function creditDeposit(userId, amount, orderId, extSession) {
  if (onPostgres()) return pushBalances(userId, await pg.creditDeposit(userId, amount, orderId));
  const { creditDeposit: _cd } = await import('./wallet.service.js');
  return _cd(userId, amount, orderId, extSession);
}

/**
 * Credit a deposit's reserve-allocation share to reserveBalance — the
 * sanctioned single writer for reserveBalance (§7). Idempotent, ledgered.
 */
export async function creditReserve(userId, amount, orderId, extSession) {
  // No SSE push here — the Mongo counterpart does not push either, and the
  // reserve pocket is not shown on the balance widget.
  if (onPostgres()) return pg.creditReserve(userId, amount, orderId);
  const { creditReserve: _cr } = await import('./wallet.service.js');
  return _cr(userId, amount, orderId, extSession);
}


export async function debitWinningsForWithdrawal(userId, amount, orderId, extSession) {
  if (onPostgres()) {
    return pushBalances(userId, await pg.debitWinningsForWithdrawal(userId, amount, orderId));
  }
  return _debitWinningsForWithdrawal(userId, amount, orderId, extSession);
}

/**
 * Refund balance for a cancelled/rejected order.
 * Accepts field param: 'depositBalance' or 'winningsBalance'.
 * Unlike refundWithdrawal, this does not hardcode the balance field.
 */
export async function refundOrder(userId, amount, orderId, field, extSession) {
  if (onPostgres()) {
    return pushBalances(userId, await pg.refundOrder(userId, amount, orderId, field));
  }
  return _refundOrder(userId, amount, orderId, field, extSession);
}

/**
 * Read paginated WalletLedger entries for a user.
 */
export async function getUserLedger(userId, page, limit) {
  if (onPostgres()) return pg.getUserLedger(userId, page, limit);
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
  if (onPostgres()) {
    return pushBalances(userId, await pg.debitForBet(userId, amount, reason, 'GameTransaction', null, txId));
  }
  return _debitForBet(userId, amount, reason, 'GameTransaction', null, txId);
}
