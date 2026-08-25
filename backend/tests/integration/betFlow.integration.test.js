// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Integration test (real DB): the FULL bet money flow, end to end, through
// the real HTTP route — the Phase A acceptance test.
//
//   place bet (POST /api/bet/place — real route, real auth middleware)
//     → paise-exact funding split (deposit/winnings/reserve, admin %)
//     → engine settlement (2x minus the winnings platform fee)
//     → ledger reconciliation (fee lands in PLATFORM_REVENUE, conserves to 0)
//
// The balanced-cycle scenario is the sharpest possible assertion: two users
// stake ₹10 on opposite sides, so the platform's entire profit is EXACTLY
// the retained fee.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { signToken } from '../../domains/identity/paseto.util.js';
import mongoose from 'mongoose';
import { User, Cycle, Bet } from '../../models/index.js';
import betRoutes from '../../domains/markets/bet.routes.js';
import GameEngine from '../../domains/markets/gameEngine.js';
import {
  reconcileSettledCycles, getTrialBalance,
} from '../../domains/revenue/revenueSettlement.service.js';

const app = express();
app.use(express.json());
// Mirror the real mount: server.js does app.use('/api/bet', betRoutes)
app.use('/api/bet', betRoutes);

// Auth migrated to PASETO (AQ-2, 2026-07-13): sign a real v2.public token via the
// single token authority so the middleware's Ed25519 verify accepts it. A raw
// jsonwebtoken JWT is rejected as an invalid signature (401).
const authFor = (user) =>
  `Bearer ${signToken({ userId: user._id })}`;

describe('Phase A money flow: split → settle → ledger', () => {
  let engine;

  beforeEach(() => {
    engine = new GameEngine(null);
  });

  afterEach(() => {
    engine.stop();
  });

  it('runs a balanced ₹10-vs-₹10 cycle: winner nets 19.80, platform revenue = the 0.20 fee', async () => {
    // kycStatus APPROVED: /api/bet/place chains requireApprovedKyc after
    // authenticate — an unverified user is 403'd before the money path runs.
    const alice = await User.create({
      username: 'alice', mobile: '9100000001', kycStatus: 'APPROVED',
      depositBalance: 100, winningsBalance: 0, reserveBalance: 10,
    });
    const bob = await User.create({
      username: 'bob', mobile: '9100000002', kycStatus: 'APPROVED',
      depositBalance: 100, winningsBalance: 0, reserveBalance: 10,
    });

    const cycle = await Cycle.create({
      cycleId: 'flow_cycle_1', type: '30_MIN',
      startTime: Date.now() - 60000, endTime: Date.now() + 60000,
      status: 'OPEN',
    });

    // ── Place both bets through the REAL route ────────────────────────────
    const resA = await request(app).post('/api/bet/place')
      .set('Authorization', authFor(alice))
      .set('Idempotency-Key', 'flow-alice-bet-1')
      .send({ cycleId: cycle.cycleId, side: 'DELHI', amount: 10, type: '30_MIN' });
    expect(resA.status).toBe(200);
    expect(resA.body.success).toBe(true);

    const resB = await request(app).post('/api/bet/place')
      .set('Authorization', authFor(bob))
      .set('Idempotency-Key', 'flow-bob-bet-1')
      .send({ cycleId: cycle.cycleId, side: 'BOMBAY', amount: 10, type: '30_MIN' });
    expect(resB.status).toBe(200);

    // ── Split assertions: 9.70 deposit / 0.30 reserve (default 3%) ────────
    const aliceAfterBet = await User.findById(alice._id).lean();
    expect(aliceAfterBet.depositBalance).toBeCloseTo(90.3, 9);
    expect(aliceAfterBet.reserveBalance).toBeCloseTo(9.7, 9);
    expect(aliceAfterBet.winningsBalance).toBe(0);
    expect(aliceAfterBet.lockedBalance).toBe(10);
    // Conservation: nothing minted or lost by placing the bet.
    expect(
      aliceAfterBet.depositBalance + aliceAfterBet.reserveBalance + aliceAfterBet.lockedBalance
    ).toBeCloseTo(110, 9);

    const aliceBet = await Bet.findOne({ userId: alice._id }).lean();
    expect(aliceBet.fromDepositBalance).toBeCloseTo(9.7, 9);
    expect(aliceBet.fromReserveBalance).toBeCloseTo(0.3, 9);
    expect(aliceBet.fromWinningsBalance).toBe(0);

    // Pools reflect both stakes.
    const openCycle = await Cycle.findById(cycle._id).lean();
    expect(openCycle.realDelhi).toBe(10);
    expect(openCycle.realBombay).toBe(10);

    // ── Declare the result and settle through the REAL engine ─────────────
    const toSettle = await Cycle.findOneAndUpdate(
      { _id: cycle._id },
      { $set: { status: 'RESULT_DECLARED', winner: 'DELHI', isSettled: 'PENDING' } },
      { new: true }
    );
    await engine.processPayoutsOptimized(toSettle);

    // Winner: gross 20 − 1% fee (0.20) = 19.80 net to winningsBalance.
    const aliceSettled = await User.findById(alice._id).lean();
    expect(aliceSettled.winningsBalance).toBe(19.8);
    expect(aliceSettled.lockedBalance).toBe(0);
    expect(aliceSettled.depositBalance).toBeCloseTo(90.3, 9); // stake stays consumed

    const aliceBetSettled = await Bet.findOne({ userId: alice._id }).lean();
    expect(aliceBetSettled.status).toBe('WON');
    expect(aliceBetSettled.payout).toBe(19.8);
    expect(aliceBetSettled.platformFee).toBe(0.2);

    // Loser: stake gone, lock released, nothing credited.
    const bobSettled = await User.findById(bob._id).lean();
    expect(bobSettled.winningsBalance).toBe(0);
    expect(bobSettled.lockedBalance).toBe(0);
    const bobBet = await Bet.findOne({ userId: bob._id }).lean();
    expect(bobBet.status).toBe('LOST');

    // Cycle accounting: paid 19.80 of a ₹20 pool → profit IS the fee.
    const settledCycle = await Cycle.findById(cycle._id).lean();
    expect(settledCycle.isSettled).toBe('COMPLETED');
    expect(settledCycle.totalPaidOut).toBe(19.8);
    expect(settledCycle.totalPlatformFees).toBe(0.2);
    expect(settledCycle.winningsFeePercentUsed).toBe(1);
    expect(settledCycle.netProfit).toBeCloseTo(0.2, 9);

    // ── Ledger: the fee reaches PLATFORM_REVENUE and conserves to zero ────
    const recon = await reconcileSettledCycles();
    expect(recon.filter(r => r.recorded).length).toBe(1);

    const trial = await getTrialBalance();
    expect(trial.integrityOk).toBe(true);
    expect(trial.accounts.PLATFORM_REVENUE.reportedMinor).toBe(20); // ₹0.20 in paise
    expect(trial.accounts.USER_FUNDS.reportedMinor).toBe(-20);      // liability down by the fee
  });

  it('rejects a bet the three wallets cannot cover, and names the real ceiling', async () => {
    // deposit 4 + winnings 3 + reserve 2 = ₹9, and the stake is ₹10.
    //
    // The refusal used to say "Insufficient balance. Available: ₹9" — which was
    // still a lie, just a smaller one: at the 3% reserve share only ₹0.21 of a
    // ₹7.21 stake may come from the reserve, so ₹7.21 is the real ceiling and
    // ₹1.79 of the ₹2 reserve is unreachable until the player deposits more.
    // The message now says that, and this test pins it — a refusal that quotes
    // a number the engine would also refuse is the bug, not the wording.
    const user = await User.create({
      username: 'broke', mobile: '9100000003', kycStatus: 'APPROVED',
      depositBalance: 4, winningsBalance: 3, reserveBalance: 2, // total 9 < 10
    });
    const cycle = await Cycle.create({
      cycleId: 'flow_cycle_2', type: '30_MIN',
      startTime: Date.now() - 60000, endTime: Date.now() + 60000,
      status: 'OPEN',
    });

    const res = await request(app).post('/api/bet/place')
      .set('Authorization', authFor(user))
      .set('Idempotency-Key', `flow-single-${user._id}`)
      .send({ cycleId: cycle.cycleId, side: 'DELHI', amount: 10, type: '30_MIN' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('STAKE_EXCEEDS_FUNDABLE');
    // The quoted ceiling must be the one the engine actually honours.
    expect(res.body.balance.maxStake).toBe(7.21);
    expect(res.body.message).toContain('₹7.21');
    // …and it must explain where the rest of the money went, or the player is
    // left staring at a ₹9 balance wondering why ₹7.21 is the limit.
    expect(res.body.message).toContain('reserve');
    expect(res.body.balance.reserveLocked).toBe(1.79);

    const fresh = await User.findById(user._id).lean();
    expect(fresh.depositBalance).toBe(4);
    expect(fresh.winningsBalance).toBe(3);
    expect(fresh.reserveBalance).toBe(2);
    expect(fresh.lockedBalance || 0).toBe(0);
    expect(await Bet.countDocuments({ userId: user._id })).toBe(0);
  });

  it('falls back reserve→deposit and deposit→winnings when buckets run short', async () => {
    // reserve 0.10 (short of 0.30) and deposit 5 (short of the 9.90 adjusted
    // main) → winnings covers the overflow. Total 15.10 > 10 stake.
    const user = await User.create({
      username: 'fallback', mobile: '9100000004', kycStatus: 'APPROVED',
      depositBalance: 5, winningsBalance: 10, reserveBalance: 0.1,
    });
    const cycle = await Cycle.create({
      cycleId: 'flow_cycle_3', type: '30_MIN',
      startTime: Date.now() - 60000, endTime: Date.now() + 60000,
      status: 'OPEN',
    });

    const res = await request(app).post('/api/bet/place')
      .set('Authorization', authFor(user))
      .set('Idempotency-Key', `flow-single-${user._id}`)
      .send({ cycleId: cycle.cycleId, side: 'DELHI', amount: 10, type: '30_MIN' });
    expect(res.status).toBe(200);

    const bet = await Bet.findOne({ userId: user._id }).lean();
    expect(bet.fromReserveBalance).toBeCloseTo(0.1, 9);  // drained
    expect(bet.fromDepositBalance).toBeCloseTo(5, 9);    // drained
    expect(bet.fromWinningsBalance).toBeCloseTo(4.9, 9); // overflow remainder
    expect(
      bet.fromReserveBalance + bet.fromDepositBalance + bet.fromWinningsBalance
    ).toBeCloseTo(10, 9);

    const fresh = await User.findById(user._id).lean();
    expect(fresh.depositBalance).toBe(0);
    expect(fresh.reserveBalance).toBe(0);
    expect(fresh.winningsBalance).toBeCloseTo(5.1, 9);
    expect(fresh.lockedBalance).toBe(10);
  });
});
