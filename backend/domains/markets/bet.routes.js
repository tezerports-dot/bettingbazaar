// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)


import express from 'express';
import { randomUUID } from 'crypto'; // MED-01: for collision-safe ledger txId
import { creditWinnings, lockBetStake, unlockBetStake } from '../wallet/walletAuthority.service.js'; // HIGH-03: atomicBet removed (never called; inline atomic pattern used instead)
import mongoose from 'mongoose';
import { authenticate, requireApprovedKyc } from '../identity/auth.middleware.js';
import { betLimiter } from '../../middleware/security.js';
import { readIdempotencyKey, assertValidIdempotencyKey } from '../../middleware/idempotencyKey.js';
import * as betAuthority from '../../postgres/betPgAuthority.js';
// Risk Platform (Phase 010): the single validation authority for bets.
// Phase A (2026-07-10): computeBetFundingPlan owns the stake-split arithmetic.
import { assessBet, computeBetFundingPlan } from '../risk/riskValidation.service.js';
// Shared trading vocabulary (Phase 011) — one source for sides/statuses.
import { MARKET_SIDES } from '../trading/tradingModels.js';
// Derived cycle pools (FLAGS.DERIVED_CYCLE_POOLS, default off) — see
// cyclePool.service.js for why the running total is the scaling ceiling.
import { derivedPoolsEnabled, refreshRealPools } from './cyclePool.service.js';
// Pages the operator when a bet's stake cannot be conclusively refunded or
// released — the one outcome no automated path can resolve on its own.
import { sendAlert } from '../../services/alerting.service.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// safeSession — kept for phantom route which still uses it
// ─────────────────────────────────────────────────────────────────────────────
async function safeSession() {
  try {
    const session = await mongoose.startSession();
    session.startTransaction();
    return session;
  } catch {
    return null;
  }
}

async function commitOrEnd(session) {
  if (!session) return;
  try { await session.commitTransaction(); } finally { session.endSession(); }
}

async function abortOrEnd(session) {
  if (!session) return;
  try { await session.abortTransaction(); } finally { session.endSession(); }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/bet/place
// Places a real bet. Deducts from winnings first, then deposits.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/place', authenticate, requireApprovedKyc, betLimiter, async (req, res) => {
  // NOTE: No session opened here — the critical balance step is a single atomic
  // findOneAndUpdate (see FIX B). Remaining writes (Bet, Cycle pool, Transaction)
  // are idempotent/append-only and do not need a multi-document transaction.

  try {
    const { cycleId, side, amount: rawAmount, type } = req.body;
    const amount = Number(rawAmount);
    const userId = req.user._id;

    const User         = mongoose.model('User');
    const Cycle        = mongoose.model('Cycle');
    const Bet          = mongoose.model('Bet');
    const Transaction  = mongoose.model('Transaction');
    const SystemConfig = mongoose.model('SystemConfig');

    // ── FIX A: DB-driven limits ──────────────────────────────────────────────
    // Old: const minBet = type === 'FULL_DAY' ? 100 : 10;  ← always hardcoded
    // New: read betLimits from SystemConfig.betLimits; fall back to safe defaults.
    const config    = await SystemConfig.findOne({ key: 'main' }).lean();
    const isFullDay = type === 'FULL_DAY';
    const limitsKey = isFullDay ? 'fullDay' : 'thirtyMin';
    const minBet    = config?.betLimits?.[limitsKey]?.min ?? (isFullDay ? 100  : 10);
    const maxBet    = config?.betLimits?.[limitsKey]?.max ?? (isFullDay ? 500000 : 100000);

    if (!MARKET_SIDES.includes(side)) {
      return res.status(400).json({ success: false, message: 'Invalid side — must be DELHI or BOMBAY' });
    }

    // ── Risk Platform gate (Phase 010) — the single validation authority ────
    // positive/whole/multiples-of-10, min/max, and the config-gated
    // opposite-side restriction. Replaces the inline checks this route
    // previously ran itself.
    try {
      await assessBet({ userId, cycleId, side, amount, min: minBet, max: maxBet });
    } catch (riskErr) {
      return res.status(riskErr.status || 400).json({ success: false, message: riskErr.message, code: riskErr.code });
    }

    // ── Cycle check ──────────────────────────────────────────────────────────
    const cycle = await Cycle.findOne({ cycleId });

    if (!cycle) {
      return res.status(404).json({ success: false, message: 'Cycle not found' });
    }

    if (!['OPEN', 'MERGED'].includes(cycle.status)) {
      return res.status(400).json({
        success: false,
        message: `Betting closed. Cycle status: ${cycle.status}`
      });
    }

    // ── Read user ONCE to compute the balance split ──────────────────────────
    // .lean() for speed — we won't save this document, just read current values.
    const user = await User.findById(userId).lean();

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const availableDeposit  = user.depositBalance  || 0;
    const availableWinnings = user.winningsBalance  || 0;
    const availableReserve  = user.reserveBalance   || 0;
    const totalAvailable    = availableDeposit + availableWinnings + availableReserve;

    if (totalAvailable < amount) {
      return res.status(400).json({
        success: false,
        message: `Insufficient balance. Available: ₹${totalAvailable}`,
        balance: { deposit: availableDeposit, winnings: availableWinnings, reserve: availableReserve, total: totalAvailable }
      });
    }

    // ── Bet funding split (Phase A, 2026-07-10) ──────────────────────────────
    // Admin-editable reserve % (Business Policy owns the number; Risk owns the
    // arithmetic). Replaces the hardcoded 0.97/0.03 Math.round pair, which
    // wasn't configurable, rounded 9.7/0.3 to 10/0, and could over-deduct
    // (₹50 → 49+2 = ₹51). Paise-exact: parts always conserve the stake.
    // Fallbacks preserved: reserve short → main; deposit short → winnings.
    const reservePercent = config?.betReservePercent ?? 3; // schema default: 3
    let plan;
    try {
      plan = computeBetFundingPlan({
        amount, reservePercent,
        availableDeposit, availableWinnings, availableReserve,
      });
    } catch (planErr) {
      return res.status(planErr.status || 400).json({
        success: false,
        message: planErr.message,
        balance: { deposit: availableDeposit, winnings: availableWinnings, reserve: availableReserve, total: totalAvailable }
      });
    }
    const { fromDeposit, fromWinnings, fromReserve } = plan;

    // ── Stake lock (§7: walletAuthority is the sole balance writer) ─────────
    // This used to be a raw three-field `findOneAndUpdate` plus a
    // fire-and-forget ledger write, right here in the route. That made
    // balances have two writers, one of which the money-authority switch
    // could not reach — so flipping the wallet path to Postgres would have
    // split the source of truth mid-bet. The authority now owns it, and picks
    // the store per postgres/moneyAuthority.js.
    // ── The bet's identity ─────────────────────────────────────────────────
    // The idempotency key for BOTH the stake movement and (on Postgres) the bet
    // row itself, so a redelivered request cannot produce a second of either.
    //
    // A client-supplied `Idempotency-Key` is preferred and is the only version
    // that actually protects a retry: with the generated fallback, a dropped
    // connection produces a DIFFERENT id, which is a genuinely new bet and a
    // second debit. That residual is documented in postgres/betPgAuthority.js
    // rather than papered over — requiring the header outright would break any
    // client that does not send it, and this is the highest-traffic endpoint in
    // the system, so switching it on is an operator's decision once they know
    // every client, not a surprise inside a migration commit.
    //
    // Unlike the /fund bug this pattern resembles, the fallback here is not a
    // gate that cannot fire: the id is genuinely new, and the gate genuinely
    // fires for the id it is given.
    const clientKey = readIdempotencyKey(req);
    if (clientKey) assertValidIdempotencyKey(clientKey);
    const betTxBase = clientKey ? `bet_${userId}_${clientKey}` : `bet_${userId}_${randomUUID()}`;
    const stakeSlices = [
      { field: 'depositBalance',  suffix: '_dep', amount: fromDeposit,
        reason: `BET_PLACED deposit portion — ₹${amount} on ${side}` },
      { field: 'winningsBalance', suffix: '_win', amount: fromWinnings,
        reason: `BET_PLACED winnings portion — ₹${amount} on ${side}` },
      { field: 'reserveBalance',  suffix: '_res', amount: fromReserve,
        reason: `BET_PLACED reserve portion (${plan.reservePercentApplied}%) — ₹${amount} on ${side}` },
    ].filter((s) => s.amount > 0);

    // ── Stake + bet record ─────────────────────────────────────────────────
    // On MONGO these are two operations: lock the stake, then insert the bet.
    // Between them the user's money is locked against a bet that does not
    // exist, and nothing sweeps that — the stake is attributed to a bet id
    // never written, so no settlement releases it and no reconciliation can
    // attribute it. The balance is simply short until a human finds it.
    //
    // On POSTGRES both are ONE transaction (betPg.placeBet), so the window
    // cannot open. Which store runs is the authority resolver's decision.
    const betsOnPostgres = betAuthority.onPostgres();

    let stakeLock;
    let pgBet = null;
    if (betsOnPostgres) {
      const placed = await betAuthority.placeBet({
        betId: betTxBase, userId, cycleId, side, amount,
        slices: stakeSlices,
        reason: `BET_PLACED — ₹${amount} on ${side}`,
      });
      stakeLock = { ok: placed.ok, balances: placed.balances };
      pgBet = placed.ok ? placed.bet : null;
    } else {
      stakeLock = await lockBetStake(userId, {
        amount, txId: betTxBase, refId: null, slices: stakeSlices,
      });
    }

    if (!stakeLock.ok) {
      // Concurrent request won the race — our pre-computed split is now stale.
      return res.status(400).json({
        success: false,
        message: 'Insufficient balance. Please try again.',
        balance: { deposit: availableDeposit, winnings: availableWinnings, reserve: availableReserve, total: totalAvailable }
      });
    }

    const updatedUser = stakeLock.balances;

    // SSE: push updated balance to user's personal channel (Finding 3)
    try {
      global.sseManager?.sendToUser?.(String(userId), 'balance_update', {
        depositBalance:  updatedUser.depositBalance  || 0,
        winningsBalance: updatedUser.winningsBalance || 0,
        reserveBalance:  updatedUser.reserveBalance  || 0,
        totalBalance:    (updatedUser.depositBalance || 0) + (updatedUser.winningsBalance || 0),
      });
    } catch (_) { /* SSE failure never blocks the bet response */ }

    // ── Create bet record ────────────────────────────────────────────────────
    // Already written, inside the stake's transaction, when Postgres owns the
    // lifecycle — and mirrored to Mongo before placeBet returned, so every read
    // path below (and the client's next fetch) finds it.
    const betDoc = betsOnPostgres ? [await betAuthority.getBetDoc(pgBet._id)] : await Bet.create([{
      userId,
      cycleId,
      amount,
      side,
      fromDepositBalance:  fromDeposit,
      fromWinningsBalance: fromWinnings,
      fromReserveBalance:  fromReserve,   // Section 6.2: stored for exact refund
      status:    'PENDING',
      isPhantom: false,
      timestamp: new Date()
    }]);
    const bet = betDoc[0];

    // ── Commit the bet against the cycle ─────────────────────────────────────
    // Two shapes, chosen by FLAGS.DERIVED_CYCLE_POOLS.
    //
    // STORED (default): one atomic `findOneAndUpdate` both increments the pool
    // and proves the cycle was still open (FIX-8a) — the increment IS the
    // TOCTOU guard. Correct, but it makes every concurrent bet queue on this
    // one document, which is the scaling ceiling in LATENCY.md.
    //
    // DERIVED: the pool is recomputed from the bets, so there is nothing to
    // increment — and any write to the Cycle document would reintroduce exactly
    // the contention this removes, including a no-op `$set`. The guard is
    // therefore a READ (reads do not contend), which reopens the TOCTOU window
    // the write had closed. It is closed again on the far side: the bet is
    // already inserted, so we re-read the status and, if the cycle closed
    // underneath us, take the same compensating path below.
    //
    // The compensation is safe against a settlement that ran in that window
    // because the delete is conditional on the bet still being PENDING — if
    // settlement already relabelled it WON/LOST, our delete matches nothing and
    // we must not refund. See the conditional `claimed` delete below.
    const useDerivedPools = await derivedPoolsEnabled();

    let cycleStillOpen;
    if (useDerivedPools) {
      cycleStillOpen = await Cycle.findOne({ cycleId, status: { $in: ['OPEN', 'MERGED'] } }).lean();
    } else {
      const poolUpdate = side === 'DELHI'
        ? { $inc: { realDelhi: amount, totalDelhi: amount } }
        : { $inc: { realBombay: amount, totalBombay: amount } };

      // FIX-8a: atomic conditional update closes TOCTOU window
      cycleStillOpen = await Cycle.findOneAndUpdate(
        { cycleId, status: { $in: ['OPEN', 'MERGED'] } },
        poolUpdate,
        { new: true }
      );
    }
    if (!cycleStillOpen) {
      // Cycle closed between the pre-check and the commit — restore the stake
      // through the same authority that took it, so the compensating CREDIT
      // rows and the balance move stay together (CRIT-03).
      //
      // Claim the bet BEFORE refunding, and only refund if the claim succeeded.
      // Settlement selects on `status: 'PENDING'`, so it can legitimately have
      // picked this row up in the window we are compensating for. If it did,
      // it has already paid or consumed the stake — deleting and refunding on
      // top of that pays the user twice. Conditioning the delete on PENDING
      // makes the two paths race for the same row and lets exactly one win.
      //
      // This ordering also fixes the same latent double-refund on the default
      // stored-pool path, where the delete was unconditional.
      //
      // The claim has THREE outcomes, and collapsing the last two loses money.
      // A `.catch(() => null)` here would make a thrown query indistinguishable
      // from "no document matched", sending a transient database error down the
      // settlement-owns-it branch — which deliberately does not refund. The
      // stake would stay locked against a bet nobody settles, and the user would
      // be told it settled, so they would not even report it. Reconciliation
      // cannot recover it either: both stores agree the debit happened.
      let claimed;
      try {
        claimed = await Bet.findOneAndDelete({ _id: bet._id, status: 'PENDING' });
      } catch (claimErr) {
        // Ownership genuinely unknown. Refunding risks paying twice; not
        // refunding risks locking the stake. Do neither silently — page the
        // operator with the identifiers needed to resolve it by hand, and tell
        // the user the truth rather than a comforting guess.
        console.error(`🚨 Bet ${bet._id} compensation unresolved:`, claimErr.message);
        sendAlert('bet-compensation-unresolved',
          'Could not determine bet ownership while refunding a closed-cycle bet', {
            betId: String(bet._id), userId: String(userId), cycleId, amount,
            error: claimErr.message,
          }).catch(() => { /* alerting must never mask the original failure */ });
        return res.status(500).json({
          success: false,
          message: 'Betting closed and we could not confirm your bet. Support has been notified and your balance will be reconciled — please do not retry.',
        });
      }

      if (claimed) {
        await unlockBetStake(userId, {
          amount, txId: `refund_bet_${bet._id}`, refId: bet._id.toString(),
          slices: stakeSlices.map((s) => ({
            ...s,
            reason: `Bet refund — cycle closed during placement (${s.field.replace('Balance', '')} portion)`,
          })),
        }).catch(() => { /* restore failure is alerted by reconciliation, never blocks the response */ });
        return res.status(400).json({
          success: false,
          message: 'Betting window just closed. Your balance has been fully restored.'
        });
      }

      // Settlement won the race and owns this bet now. Do not touch the money.
      return res.status(400).json({
        success: false,
        message: 'Betting window just closed while your bet was being placed. It was included in the cycle that just settled — check My Bets for the result.'
      });
    }

    // ── Transaction log ──────────────────────────────────────────────────────
    await Transaction.create([{
      userId,
      type: 'BET_PLACED',
      amount,
      balanceType: fromDeposit > 0 && fromWinnings > 0 ? 'BOTH'
                 : fromDeposit > 0 ? 'DEPOSIT' : 'WINNINGS',
      depositBalanceBefore:  availableDeposit,
      depositBalanceAfter:   availableDeposit  - fromDeposit,
      winningsBalanceBefore: availableWinnings,
      winningsBalanceAfter:  availableWinnings - fromWinnings,
      lockedBalanceBefore:   user.lockedBalance  || 0,
      lockedBalanceAfter:    (user.lockedBalance || 0) + amount,
      referenceId: bet._id.toString(),
      description: `Bet ₹${amount} on ${side} (₹${fromDeposit} deposit + ₹${fromWinnings} winnings)`,
      status: 'SUCCESS'
    }]);

    // ── Pool figures for the broadcast ───────────────────────────────────────
    // STORED: `cycleStillOpen` is the post-increment document — already exact.
    //
    // DERIVED: it is a read taken BEFORE this bet existed, so its pools trail by
    // this stake. `refreshRealPools` recomputes and republishes them, but it is
    // memoised (CYCLE_POOL_REFRESH_MS, default 1s) precisely so that a burst of
    // bets does not turn into a burst of writes to the Cycle document — which
    // is the contention this whole change removes. Most calls therefore return
    // a cached answer and write nothing.
    //
    // The consequence is honest and bounded: a broadcast can trail the very
    // latest bets by up to one refresh interval. That is acceptable here and
    // nowhere else — the live pool is a throttled display value, already
    // rebroadcast on a timer rather than per bet. The two places where the
    // number becomes money (winner determination, netProfit) call
    // `refreshRealPools(..., { exact: true })` instead and never read a memo.
    let updatedCycle = cycleStillOpen; // FIX-8b: reuse result from FIX-8a
    if (useDerivedPools) {
      const pools = await refreshRealPools(cycleId).catch(() => null);
      const realD = pools ? pools.realDelhi : (cycleStillOpen.realDelhi || 0);
      const realB = pools ? pools.realBombay : (cycleStillOpen.realBombay || 0);
      const phantomD = cycleStillOpen.phantomDelhi || 0;
      const phantomB = cycleStillOpen.phantomBombay || 0;
      updatedCycle = {
        realDelhi: realD,
        realBombay: realB,
        phantomDelhi: phantomD,
        phantomBombay: phantomB,
        totalDelhi: realD + phantomD,
        totalBombay: realB + phantomB,
      };
    }

    if (global.io || global.sseManager) {
      
      // Must use both channels: SSE for anonymous/public stream clients,
      
      const publicBetPayload = {
        cycleId,
        side,
        cycleType:      cycle.type,
        newTotalDelhi:  updatedCycle.totalDelhi,
        newTotalBombay: updatedCycle.totalBombay,
      };
      if (global.sseManager) {
        global.sseManager.broadcast('bet_placed', publicBetPayload);
      }
      
      global.io?.emit('bet_placed', publicBetPayload);

      
      global.io?.to('admin-room').emit('admin_bet_placed', {
        cycleId,
        side,
        amount,
        cycleType:        cycle.type,
        newRealDelhi:     updatedCycle.realDelhi,
        newRealBombay:    updatedCycle.realBombay,
        newPhantomDelhi:  updatedCycle.phantomDelhi,
        newPhantomBombay: updatedCycle.phantomBombay,
        newTotalDelhi:    updatedCycle.totalDelhi,
        newTotalBombay:   updatedCycle.totalBombay,
      });
    }

    res.json({
      success: true,
      message: 'Bet placed successfully',
      bet: {
        id:       bet._id,
        cycleId,
        side,
        amount,
        status:   'PENDING',   // BettingCard filters userBets by status === 'PENDING' for "You: ₹X" badge
        type,
        placedAt: bet.timestamp
      },
      balance: {
        deposit:  updatedUser.depositBalance,
        winnings: updatedUser.winningsBalance,
        reserve:  updatedUser.reserveBalance  || 0,
        locked:   updatedUser.lockedBalance,
        total:    updatedUser.depositBalance + updatedUser.winningsBalance,
      }
    });

  } catch (error) {
    console.error('❌ Place bet error:', error);
    res.status(500).json({ success: false, message: 'Failed to place bet' });
  }
});
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/bet/phantom
// Places a phantom (ghost) bet. Only for users with phantomAccess assigned by admin.
// Phantom bets:
//   - Do NOT deduct from user balance (they are synthetic)
//   - Are flagged isPhantom: true
//   - Only affect phantomDelhi / phantomBombay pool counters
//   - Always LOSE at settlement (GameEngine skips isPhantom:true rows)
//   - Are only visible to admin room via admin_bet_placed event
//   - Pool totals shown to regular users include phantom (combined) but hide the split
// ─────────────────────────────────────────────────────────────────────────────
router.post('/phantom', authenticate, async (req, res) => {
  try {
    const { cycleId, side, amount } = req.body;
    const userId = req.user._id;

    const User    = mongoose.model('User');
    const Cycle   = mongoose.model('Cycle');
    const Bet     = mongoose.model('Bet');

    // ── Auth: only phantom agents may call this ────────────────────────────
    const agent = await User.findById(userId).select('phantomAccess').lean();
    if (!agent || !agent.phantomAccess || agent.phantomAccess === 'NONE') {
      return res.status(403).json({ success: false, message: 'Phantom access not granted' });
    }

    // ── Cycle access check ─────────────────────────────────────────────────
    const cycle = await Cycle.findOne({ cycleId });
    if (!cycle) return res.status(404).json({ success: false, message: 'Cycle not found' });

    // Verify agent has access to this cycle type
    const access = agent.phantomAccess;
    if (access !== 'BOTH' && access !== cycle.type) {
      return res.status(403).json({
        success: false,
        message: `Your phantom access is for ${access} cycles only`
      });
    }

    if (!['OPEN', 'MERGED'].includes(cycle.status)) {
      return res.status(400).json({ success: false, message: `Betting closed. Cycle status: ${cycle.status}` });
    }

    if (cycle.phantomBetsClosed) {
      return res.status(400).json({ success: false, message: 'Phantom betting is closed for this cycle' });
    }

    if (!amount || amount < 1) {
      return res.status(400).json({ success: false, message: 'Invalid amount' });
    }

    if (!MARKET_SIDES.includes(side)) {
      return res.status(400).json({ success: false, message: 'Invalid side' });
    }

    // ── Create phantom bet record — no balance deduction ───────────────────
    const betDoc = await Bet.create([{
      userId,
      cycleId,
      amount,
      side,
      fromDepositBalance:  0,  // phantom: no real money
      fromWinningsBalance: 0,
      status:    'PENDING',
      isPhantom: true,
      phantomManagerId: userId,
      timestamp: new Date()
    }]);
    const bet = betDoc[0];

    // ── Update phantom pool counters only ─────────────────────────────────
    // Phantom pools stay STORED under both flag settings. They are not a sum of
    // phantom Bet rows — `cycleGenerator.equalizePhantomPools` overwrites them
    // with max(delhi, bombay) — so no aggregation can reproduce them. They also
    // never needed deriving: these come from a handful of admin agents, not
    // from thousands of users, so they were never the contention source.
    const phantomPoolUpdate = side === 'DELHI'
      ? { $inc: { phantomDelhi: amount, totalDelhi: amount } }
      : { $inc: { phantomBombay: amount, totalBombay: amount } };
    const updatedCycle = await Cycle.findOneAndUpdate({ cycleId }, phantomPoolUpdate, { new: true });

    
    if (global.io || global.sseManager) {
      
      const publicPhantomPayload = {
        cycleId,
        side,
        cycleType:      cycle.type,
        newTotalDelhi:  updatedCycle.totalDelhi,
        newTotalBombay: updatedCycle.totalBombay,
      };
      if (global.sseManager) {
        global.sseManager.broadcast('bet_placed', publicPhantomPayload);
      }
      
      global.io?.emit('bet_placed', publicPhantomPayload);

      
      global.io?.to('admin-room').emit('admin_bet_placed', {
        cycleId,
        side,
        amount,
        isPhantom:        true,
        cycleType:        cycle.type,
        newRealDelhi:     updatedCycle.realDelhi,
        newRealBombay:    updatedCycle.realBombay,
        newPhantomDelhi:  updatedCycle.phantomDelhi,
        newPhantomBombay: updatedCycle.phantomBombay,
        newTotalDelhi:    updatedCycle.totalDelhi,
        newTotalBombay:   updatedCycle.totalBombay,
      });
    }

    res.json({
      success: true,
      message: 'Phantom bet placed',
      bet: { id: bet._id, cycleId, side, amount, isPhantom: true }
    });

  } catch (error) {
    console.error('❌ Phantom bet error:', error);
    res.status(500).json({ success: false, message: 'Failed to place phantom bet' });
  }
});

export default router;
