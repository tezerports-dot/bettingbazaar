// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)


import express from 'express';
import { randomUUID } from 'crypto'; // MED-01: for collision-safe ledger txId
import { creditWinnings } from '../wallet/walletAuthority.service.js'; // HIGH-03: atomicBet removed (never called; inline atomic pattern used instead)
import mongoose from 'mongoose';
import { authenticate } from '../identity/auth.middleware.js';
import { betLimiter } from '../../middleware/security.js';
// Risk Platform (Phase 010): the single validation authority for bets.
import { assessBet } from '../risk/riskValidation.service.js';

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
router.post('/place', betLimiter, authenticate, async (req, res) => {
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

    if (!['DELHI', 'BOMBAY'].includes(side)) {
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

    // ── 97/3 split (Section 5.1) ──────────────────────────────────────────
    // mainDeduction = 97% consumed from depositBalance first, then winningsBalance overflow
    // reserveDeduction = 3% from reserveBalance; shortfall shifts to mainDeduction (Section 5.2C)
    const mainDeduction    = Math.round(amount * 0.97);
    let   reserveDeduction = Math.round(amount * 0.03);

    // Section 5.2C: if reserveBalance insufficient, shift shortfall to main
    const reserveShortfall = Math.max(0, reserveDeduction - availableReserve);
    const fromReserve      = reserveDeduction - reserveShortfall;
    const adjustedMain     = mainDeduction + reserveShortfall;

    // Deduction priority: DEPOSIT first (betting-only balance), then WINNINGS as overflow.
    const fromDeposit  = Math.min(adjustedMain, availableDeposit);
    const fromWinnings = adjustedMain - fromDeposit;

    // ── Finding 4 / Section 5.3: Three-field atomic check + deduct ──────────
    // Old: two-field (deposit + winnings). New: three-field adding reserveBalance.
    // Single findOneAndUpdate: filter encodes all three balance requirements.
    // If another bet landed between read and write, filter fails → null → 400.
    const updatedUser = await User.findOneAndUpdate(
      {
        _id:             userId,
        depositBalance:  { $gte: fromDeposit  },
        winningsBalance: { $gte: fromWinnings },
        reserveBalance:  { $gte: fromReserve  },
      },
      {
        $inc: {
          depositBalance:       -fromDeposit,
          winningsBalance:      -fromWinnings,
          reserveBalance:       -fromReserve,
          lockedBalance:         amount,
          lockedDepositAmount:   fromDeposit,
          lockedWinningsAmount:  fromWinnings,
        }
      },
      { new: true }
    );

    if (!updatedUser) {
      // Concurrent request won the race — our pre-computed split is now stale.
      return res.status(400).json({
        success: false,
        message: 'Insufficient balance. Please try again.',
        balance: { deposit: availableDeposit, winnings: availableWinnings, reserve: availableReserve, total: totalAvailable }
      });
    }

    // ── WalletLedger audit entries (Section 5.4) ──────────────────────────
    try {
      const WalletLedger = mongoose.model('WalletLedger');
      const betTxBase = `bet_${userId}_${randomUUID()}`;
      const ledgerOps = [];
      if (fromDeposit > 0) {
        ledgerOps.push({
          userId, type: 'DEBIT', field: 'depositBalance',
          amount: fromDeposit,
          balanceBefore: availableDeposit,
          balanceAfter:  availableDeposit - fromDeposit,
          reason: `BET_PLACED deposit portion — ₹${amount} on ${side}`, refModel: 'Bet',
          txId: betTxBase + '_dep',
        });
      }
      if (fromWinnings > 0) {
        ledgerOps.push({
          userId, type: 'DEBIT', field: 'winningsBalance',
          amount: fromWinnings,
          balanceBefore: availableWinnings,
          balanceAfter:  availableWinnings - fromWinnings,
          reason: `BET_PLACED winnings portion — ₹${amount} on ${side}`, refModel: 'Bet',
          txId: betTxBase + '_win',
        });
      }
      if (fromReserve > 0) {
        ledgerOps.push({
          userId, type: 'DEBIT', field: 'reserveBalance',
          amount: fromReserve,
          balanceBefore: availableReserve,
          balanceAfter:  availableReserve - fromReserve,
          reason: `BET_PLACED reserve portion (3%) — ₹${amount} on ${side}`, refModel: 'Bet',
          txId: betTxBase + '_res',
        });
      }
      if (ledgerOps.length) await WalletLedger.insertMany(ledgerOps, { ordered: false }).catch(() => {});
      // SSE: push updated balance to user's personal channel (Finding 3)
      global.sseManager?.sendToUser?.(String(userId), 'balance_update', {
        depositBalance:  updatedUser.depositBalance  || 0,
        winningsBalance: updatedUser.winningsBalance || 0,
        reserveBalance:  updatedUser.reserveBalance  || 0,
        totalBalance:    (updatedUser.depositBalance || 0) + (updatedUser.winningsBalance || 0),
      });
    } catch (_) { /* Ledger/SSE failure never blocks the bet response */ }

    // ── Create bet record ────────────────────────────────────────────────────
    const betDoc = await Bet.create([{
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

    // ── Update cycle real pools ──────────────────────────────────────────────
    const poolUpdate = side === 'DELHI'
      ? { $inc: { realDelhi: amount, totalDelhi: amount } }
      : { $inc: { realBombay: amount, totalBombay: amount } };

    // FIX-8a: atomic conditional update closes TOCTOU window
    const cycleStillOpen = await Cycle.findOneAndUpdate(
      { cycleId, status: { $in: ['OPEN', 'MERGED'] } },
      poolUpdate,
      { new: true }
    );
    if (!cycleStillOpen) {
      // Cycle closed between pre-check and pool commit – atomically restore balance
      await User.findOneAndUpdate(
        { _id: userId },
        { $inc: {
            depositBalance:       fromDeposit,
            winningsBalance:      fromWinnings,
            reserveBalance:       fromReserve,
            lockedBalance:        -amount,
            lockedDepositAmount:  -fromDeposit,
            lockedWinningsAmount: -fromWinnings,
        }}
      );
      await Bet.findByIdAndDelete(bet._id).catch(() => {});
      // CRIT-03 FIX: write compensating CREDIT entries so WalletLedger stays balanced
      // (DEBIT entries were already written fire-and-forget above before Bet.create)
      try {
        const WalletLedger = mongoose.model('WalletLedger');
        const refundLedgerOps = [];
        if (fromDeposit > 0) refundLedgerOps.push({
          userId, type: 'CREDIT', field: 'depositBalance',
          amount: fromDeposit,
          balanceBefore: availableDeposit - fromDeposit,
          balanceAfter:  availableDeposit,
          reason: 'Bet refund — cycle closed during placement',
          refModel: 'Bet', refId: bet._id.toString(),
          txId: `refund_bet_${bet._id}_dep`,
        });
        if (fromWinnings > 0) refundLedgerOps.push({
          userId, type: 'CREDIT', field: 'winningsBalance',
          amount: fromWinnings,
          balanceBefore: availableWinnings - fromWinnings,
          balanceAfter:  availableWinnings,
          reason: 'Bet refund — cycle closed during placement (winnings portion)',
          refModel: 'Bet', refId: bet._id.toString(),
          txId: `refund_bet_${bet._id}_win`,
        });
        if (fromReserve > 0) refundLedgerOps.push({
          userId, type: 'CREDIT', field: 'reserveBalance',
          amount: fromReserve,
          balanceBefore: availableReserve - fromReserve,
          balanceAfter:  availableReserve,
          reason: 'Bet refund — cycle closed during placement (reserve portion)',
          refModel: 'Bet', refId: bet._id.toString(),
          txId: `refund_bet_${bet._id}_res`,
        });
        if (refundLedgerOps.length)
          await WalletLedger.insertMany(refundLedgerOps, { ordered: false }).catch(() => {});
      } catch (_) { /* ledger refund write failure never blocks the response */ }
      return res.status(400).json({
        success: false,
        message: 'Betting window just closed. Your balance has been fully restored.'
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

    
    const updatedCycle = cycleStillOpen; // FIX-8b: reuse result from FIX-8a

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

    if (!['DELHI', 'BOMBAY'].includes(side)) {
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
