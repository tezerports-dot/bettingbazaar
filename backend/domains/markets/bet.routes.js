// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)


import express from 'express';
import { db } from '#db';
import { getBalances } from '../wallet/walletAuthority.service.js';
import { authenticatePlayer } from '../identity/auth.middleware.js';
import { betLimiter } from '../../middleware/security.js';
import { requireIdempotencyKey, IdempotencyKeyError } from '../../middleware/idempotencyKey.js';
// Shared trading vocabulary (Phase 011) — one source for sides/statuses.
import { MARKET_SIDES } from '../trading/tradingModels.js';
// The cycle's board: its stake bounds and phase offsets (the `boards` row).
import { boardOf } from './cycleTypes.js';
// Coalesces per-bet pool changes into one snapshot/sec/cycle instead of a
// per-bet fan-out to every connected client (cycleSnapshotPublisher.js).
import { cycleSnapshotPublisher } from './cycleSnapshotPublisher.js';
import { poolsHidden } from './cyclePublicView.js';
import { emitToStaff } from '../notification/staffEventAreas.js';
import { respondError } from '../../shared/httpError.js';
import { placePlayerBet, announcePlacedBet } from './playerBet.service.js';
import {
  AUTO_LADDER_STEPS_MAX, AUTO_FACTOR_MIN_X100, AUTO_FACTOR_MAX_X100, AUTO_STOP_TEXT, normalisePlan,
} from './autoBets.js';
import { betMultipleOf } from '../risk/betStep.js';
import { getSystemConfig } from '#db/repositories/config.js';
import { AUTO_BET_STEPS_MAX, AUTO_BET_MIN_RUPEES, AUTO_BET_MAX_RUPEES } from './phantomBets.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// idempotentBetResponse — the success body for a bet that ALREADY exists, i.e. a
// redelivered POST /place. It carries the original bet and the user's CURRENT
// balances, so a client that retried (its own 500/network retry, a double-tap, a
// proxy replay) gets the same "placed" answer it would have gotten the first
// time — and never a second bet, a second debit, a doubled pool or a duplicate
// Transaction row. Balances are read live because what the client needs is "what
// is my balance now", not the balance captured at first placement.
// ─────────────────────────────────────────────────────────────────────────────
async function idempotentBetResponse(bet, userId, type) {
  let balance = null;
  try {
    const b = await getBalances(userId);
    balance = {
      deposit:  b.depositBalance,
      winnings: b.winningsBalance,
      reserve:  b.reserveBalance || 0,
      locked:   b.lockedBalance,
      total:    (b.depositBalance || 0) + (b.winningsBalance || 0),
    };
  } catch { /* the balance echo is a convenience; its absence never fails a replay */ }
  return {
    success: true,
    message: 'Bet already placed',
    idempotent: true,
    bet: {
      id:       bet._id,
      cycleId:  bet.cycleId,
      side:     bet.side,
      amount:   bet.amount,
      status:   bet.status || 'PENDING',
      type,
      placedAt: bet.timestamp,
    },
    balance,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/bet/place
// Places a real bet. Deducts from winnings first, then deposits.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/place', authenticatePlayer, betLimiter, async (req, res) => {
  // NOTE: No session opened here — the critical balance step is a single atomic
  // findOneAndUpdate (see FIX B). Remaining writes (Bet, Cycle pool, Transaction)
  // are idempotent/append-only and do not need a multi-document transaction.

  try {
    const { cycleId, side, amount: rawAmount, type } = req.body;
    const amount = Number(rawAmount);
    const userId = req.user.userId;

    // ── Server-enforced idempotency (M-2) ────────────────────────────────────
    // The bet's identity comes from the caller's Idempotency-Key, REQUIRED here.
    // The server cannot invent one: a fresh id per delivery is not idempotency,
    // it is a second bet — and this is the endpoint where a retry (the client's
    // own 500/network retry, a double-tap, a proxy replay) must never place two.
    // `bet_<userId>_<key>` is the stake movement's txId and, via a stable derived
    // ObjectId, the Bet row's _id on BOTH stores, so the gate is the unique index
    // rather than a convention. See middleware/idempotencyKey.js.
    let clientKey;
    try {
      clientKey = requireIdempotencyKey(req);
    } catch (keyErr) {
      if (keyErr instanceof IdempotencyKeyError) {
        return res.status(keyErr.status || 400).json({ success: false, message: keyErr.message });
      }
      throw keyErr;
    }
    const betTxBase  = `bet_${userId}_${clientKey}`;

    // Every check, the stake and the bet: the one admission a tapped bet and
    // an auto bet share (playerBet.service.js). A replay of this key places
    // nothing and answers with the bet it placed.
    const placed = await placePlayerBet({ userId, cycleId, side, amount, betId: betTxBase });
    if (placed.kind === 'refused') return res.status(placed.status).json(placed.body);
    if (placed.kind === 'replay') return res.json(await idempotentBetResponse(placed.bet, userId, type));
    const { bet, cycle } = placed;
    const updatedUser = placed.balances;
    await announcePlacedBet({ userId, cycleId, cycle, side, amount, balances: updatedUser });
    res.json({
      success: true,
      message: 'Bet placed successfully',
      bet: {
        id:       bet._id,
        cycleId,
        side,
        amount,
        status:   'PENDING',   // BettingCard filters userBets by status === 'PENDING' for "You: ₹X" badge
        type:     cycle.type,
        placedAt: bet.timestamp
      },
      balance: {
        deposit:  updatedUser.depositBalance,
        winnings: updatedUser.winningsBalance,
        reserve:  updatedUser.reserveBalance  || 0,
        locked:   updatedUser.lockedBalance,
        general:  updatedUser.promoBalance || 0,
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
// ─────────────────────────────────────────────────────────────────────────────
// Auto phantom bets (owner, 2026-10-15): a phantom agent's plan per board and
// side, a list of sizes bet one a second until the equalizer (phantomBets.js).
//
// GET /api/bet/phantom/auto  — { plans, limits }
// PUT /api/bet/phantom/auto  — { boardKey, audience, side, amounts: [rupees…], enabled }
// A plan is per board, audience (VIP / GENERAL) and side.
// ─────────────────────────────────────────────────────────────────────────────
const AUTO_LIMITS = { maxSteps: AUTO_BET_STEPS_MAX, minRupees: AUTO_BET_MIN_RUPEES, maxRupees: AUTO_BET_MAX_RUPEES };

async function phantomAgent(req, res) {
  const agent = await db.users.getUser(req.user.userId);
  if (!agent || !agent.phantomAccess || agent.phantomAccess === 'NONE') {
    res.status(403).json({ success: false, code: 'PHANTOM_ACCESS_REQUIRED', message: 'Phantom access not granted' });
    return null;
  }
  return agent;
}

router.get('/phantom/auto', authenticatePlayer, async (req, res) => {
  try {
    if (!(await phantomAgent(req, res))) return;
    return res.json({ success: true, plans: await db.phantomAutoPlans.listFor(req.user.userId), limits: AUTO_LIMITS });
  } catch (error) {
    return respondError(res, error, 'GET /api/bet/phantom/auto', { message: 'Could not load your auto bets' });
  }
});

router.put('/phantom/auto', authenticatePlayer, async (req, res) => {
  try {
    const agent = await phantomAgent(req, res);
    if (!agent) return;
    const { boardKey, audience, side, amounts, enabled } = req.body || {};
    if (!MARKET_SIDES.includes(side)) {
      return res.status(400).json({ success: false, code: 'AUTO_BETS_INVALID', message: 'Pick Delhi or Bombay.' });
    }
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, code: 'AUTO_BETS_INVALID', message: 'Say whether the plan is on or off.' });
    }
    const board = typeof boardKey === 'string' ? await boardOf(boardKey) : null;
    if (!board) return res.status(400).json({ success: false, code: 'AUTO_BETS_INVALID', message: 'That board does not exist.' });
    if (agent.phantomAccess !== 'BOTH' && agent.phantomAccess !== board.key) {
      return res.status(403).json({ success: false, code: 'PHANTOM_ACCESS_REQUIRED', message: `Your phantom access is for ${agent.phantomAccess} cycles only` });
    }
    const plan = await db.phantomAutoPlans.savePlan({ userId: req.user.userId, boardKey: board.key, audience, side, amounts, enabled });
    return res.json({ success: true, plan });
  } catch (error) {
    return respondError(res, error, 'PUT /api/bet/phantom/auto', { message: 'Could not save your auto bets' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Player auto bets (owner, 2026-10-22): a ladder on one board, profile and
// side, one bet a round, placed by the cycle generator through the same
// admission as POST /place (autoBets.js, playerBet.service.js).
//
// GET  /api/bet/auto                — { plans, limits }: running ones, then the latest stopped
// POST /api/bet/auto                — start { boardKey, audience, side, start, factor, steps, budget, stopLoss?, takeProfit? }
// POST /api/bet/auto/:planId/stop   — stop it now
// ─────────────────────────────────────────────────────────────────────────────
const AUTO_PLAYER_LIMITS = { maxSteps: AUTO_LADDER_STEPS_MAX, minFactor: AUTO_FACTOR_MIN_X100 / 100, maxFactor: AUTO_FACTOR_MAX_X100 / 100 };

/** A plan as the player app reads it: rupees, and the stop reason in words. */
const autoPlanView = (p) => ({
  planId: p.planId, boardKey: p.boardKey, audience: p.audience, side: p.side,
  factor: p.factor, stakes: p.stakes, budget: p.budgetPaise / 100,
  stopLoss: p.stopLossPaise / 100, takeProfit: p.takeProfitPaise / 100,
  startedAt: p.startedAt, stoppedAt: p.stoppedAt, running: p.running,
  stopReason: p.stopReason, stopText: p.stopReason ? AUTO_STOP_TEXT[p.stopReason] : null,
  played: p.played, won: p.won, pending: p.pending,
  net: p.netPaise / 100, staked: p.stakedPaise / 100,
  step: p.step, nextStake: p.nextStakePaise / 100, lastBetAt: p.lastBetAt,
});

router.get('/auto', authenticatePlayer, async (req, res) => {
  try {
    const plans = await db.playerAutoBets.plansOf(req.user.userId);
    return res.json({ success: true, plans: plans.map(autoPlanView), limits: AUTO_PLAYER_LIMITS });
  } catch (error) {
    return respondError(res, error, 'GET /api/bet/auto', { message: 'Could not load your auto bets' });
  }
});

router.post('/auto', authenticatePlayer, async (req, res) => {
  try {
    const userId = req.user.userId;
    const body = req.body || {};
    const board = typeof body.boardKey === 'string' ? await boardOf(body.boardKey) : null;
    if (!board) return res.status(400).json({ success: false, code: 'AUTO_BETS_INVALID', message: 'That board does not exist.' });
    if (!board.enabled) {
      return res.status(409).json({ success: false, code: 'BOARD_SWITCHED_OFF', message: 'This board is switched off. Pick another board.' });
    }
    // The plan bets the profile being played, as a tapped bet does.
    const profile = await db.promo.playProfileOf(userId);
    if (body.audience !== profile) {
      return res.status(409).json({
        success: false, code: 'WRONG_PROFILE_FOR_CYCLE',
        message: profile === 'GENERAL'
          ? 'You are playing with your General balance. Switch to VIP ID to start VIP auto bets.'
          : 'You are playing with your VIP balance. Switch to General to start General auto bets.',
      });
    }
    if (!(await db.boardRules.acceptsCurrent(userId))) {
      return res.status(409).json({ success: false, code: 'BOARD_RULES_NOT_ACCEPTED', message: 'Please read and accept the board rules before you bet.' });
    }
    const plan = normalisePlan(body, board, betMultipleOf(await getSystemConfig()));
    const started = await db.playerAutoBets.startPlan({ userId, boardKey: board.key, audience: profile, ...plan });
    if (!started.ok) {
      return res.status(409).json({ success: false, code: 'AUTO_BETS_RUNNING', message: 'Auto bets are already running on this board. Stop them first.' });
    }
    return res.json({ success: true, plan: autoPlanView(started.plan) });
  } catch (error) {
    return respondError(res, error, 'POST /api/bet/auto', { message: 'Could not start your auto bets' });
  }
});

router.post('/auto/:planId/stop', authenticatePlayer, async (req, res) => {
  try {
    const userId = req.user.userId;
    await db.playerAutoBets.stopPlan({ planId: req.params.planId, userId, reason: 'PLAYER' });
    const plan = await db.playerAutoBets.planOf(req.params.planId);
    // Another player's plan is not found, as no plan is.
    if (!plan || plan.userId !== String(userId)) {
      return res.status(404).json({ success: false, code: 'AUTO_PLAN_NOT_FOUND', message: 'That auto-bets plan was not found.' });
    }
    return res.json({ success: true, plan: autoPlanView(plan) });
  } catch (error) {
    return respondError(res, error, 'POST /api/bet/auto/:planId/stop', { message: 'Could not stop your auto bets' });
  }
});

router.post('/phantom', authenticatePlayer, async (req, res) => {
  try {
    const { cycleId, side } = req.body;
    const amount = Number(req.body.amount);
    const userId = req.user.userId;

    // ── Auth: only phantom agents may call this ────────────────────────────
    const agent = await db.users.getUser(userId);
    if (!agent || !agent.phantomAccess || agent.phantomAccess === 'NONE') {
      return res.status(403).json({ success: false, message: 'Phantom access not granted' });
    }

    const cycle = await db.markets.getCycle(cycleId);
    if (!cycle) return res.status(404).json({ success: false, message: 'Cycle not found' });

    // Verify the agent has access to this cycle type.
    const access = agent.phantomAccess;
    if (access !== 'BOTH' && access !== cycle.type) {
      return res.status(403).json({
        success: false,
        message: `Your phantom access is for ${access} cycles only`,
      });
    }

    // A number, at least ₹1. A non-number (or a numeric STRING) used to reach
    // `rupeesToPaise`, throw a bare TypeError and answer 500 (§32 S35).
    if (!Number.isFinite(amount) || amount < 1) {
      return res.status(400).json({ success: false, message: 'Enter an amount of at least ₹1.' });
    }
    if (!MARKET_SIDES.includes(side)) {
      return res.status(400).json({ success: false, message: 'Invalid side' });
    }

    // ── The bet row and the phantom pool, in ONE transaction ────────────────
    // They were two writes with the status checks in front of them, so a cycle
    // closing in between left a phantom bet the pools did not include —
    // invisible in the total a player sees, and still there at settlement. The
    // status and the phantom-closed flag are now re-checked under the cycle's
    // row lock, so an admin closing phantom betting cannot be raced by an
    // agent's last bet.
    const placed = await db.markets.placePhantomBet({
      betId: `phantom_${cycleId}_${userId}_${Date.now()}`,
      userId, cycleId, side, amountRupees: amount, cycleType: cycle.type,
    });

    if (!placed.ok) {
      const message = {
        CYCLE_NOT_FOUND: 'Cycle not found',
        CYCLE_CLOSED: `Betting closed. Cycle status: ${placed.status}`,
        PHANTOM_CLOSED: 'Phantom betting is closed for this cycle',
      }[placed.reason] || 'That phantom bet was refused.';
      return res.status(placed.reason === 'CYCLE_NOT_FOUND' ? 404 : 400)
        .json({ success: false, message });
    }
    if (placed.idempotent) {
      return res.json({ success: true, message: 'Phantom bet already recorded' });
    }

    const updatedCycle = placed.cycle;

    // ── The pools the broadcast carries ───────────────────────────────────
    // Phantom pools stay STORED: `equalizePhantomPools` OVERWRITES them with
    // max(delhi, bombay) rather than adding, so no sum over rows reproduces
    // them, and they come from a handful of admin agents rather than the
    // contention path. The REAL pools are summed from the bets — a phantom bet
    // moves neither, but the public number is the total, so both are needed.
    const realNow = await db.markets.realPools(cycleId).catch(() => ({ realDelhi: 0, realBombay: 0 }));
    const totalDelhi = realNow.realDelhi + (updatedCycle.phantomDelhi || 0);
    const totalBombay = realNow.realBombay + (updatedCycle.phantomBombay || 0);

    {
      // PUBLIC pool update — coalesced (same path as a real bet). A phantom bet
      // only moves the phantom pool, but the PUBLIC number is the total, so the
      // publisher carries the updated total exactly as it does for a real bet.
      cycleSnapshotPublisher.recordBet(cycleId, {
        cycleType:  cycle.type,
        totalDelhi,
        totalBombay,
        poolsHidden: poolsHidden(updatedCycle),
      });

      // ADMINS see the phantom breakdown per bet on admin-room only.
      emitToStaff(global.io, 'admin_bet_placed', {
        cycleId,
        side,
        amount,
        isPhantom:        true,
        cycleType:        cycle.type,
        newRealDelhi:     realNow.realDelhi,
        newRealBombay:    realNow.realBombay,
        newPhantomDelhi:  updatedCycle.phantomDelhi,
        newPhantomBombay: updatedCycle.phantomBombay,
        newTotalDelhi:    totalDelhi,
        newTotalBombay:   totalBombay,
      });
    }

    res.json({
      success: true,
      message: 'Phantom bet placed',
      bet: { cycleId, side, amount, isPhantom: true }
    });

  } catch (error) {
    console.error('❌ Phantom bet error:', error);
    res.status(500).json({ success: false, message: 'Failed to place phantom bet' });
  }
});

export default router;
