// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Integration test (real DB): cycle settlement through the actual GameEngine.
// Exercises the dual-balance system the way production does — a placed bet
// has already debited balances and locked the stake; settlement credits
// winnings via walletAuthority (NET of the Phase A winnings platform fee)
// and releases the lock. Fee percent is owned by
// SystemConfig.winningsFeePercent (schema default: 1).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import GameEngine from '../../domains/markets/gameEngine.js';
import { User, Cycle, Bet, Transaction } from '../../models/index.js';

const SystemConfig = () => mongoose.model('SystemConfig');

function makeCycle(overrides = {}) {
  return Cycle.create({
    cycleId: 'test_cycle_' + Math.random().toString(16).slice(2),
    type: '30_MIN',
    startTime: Date.now() - 3600000,
    endTime: Date.now() - 1800000,
    status: 'RESULT_DECLARED',
    winner: 'DELHI',
    isSettled: 'PENDING',
    realDelhi: 0,
    realBombay: 0,
    ...overrides,
  });
}

describe('Game Engine Settlement', () => {
  let engine;

  beforeEach(() => {
    engine = new GameEngine(null);
  });

  afterEach(() => {
    engine.stop(); // clear tick/recovery intervals so the worker can exit
  });

  it('pays a winner 2x minus the default 1% platform fee and releases the locked stake', async () => {
    // User placed a ₹50 bet funded from depositBalance: balance already
    // debited, stake locked — exactly the state bet.routes.js leaves behind.
    const user = await User.create({
      username: 'Winner',
      mobile: '1234567890',
      depositBalance: 50,       // 100 deposited − 50 staked
      winningsBalance: 0,
      lockedBalance: 50,
      lockedDepositAmount: 50,
    });

    const cycle = await makeCycle({ realDelhi: 50 });

    await Bet.create({
      userId: user._id,
      cycleId: cycle.cycleId,
      amount: 50,
      side: 'DELHI',
      fromDepositBalance: 50,
      status: 'PENDING',
    });

    await engine.processPayoutsOptimized(cycle);

    // gross 2x = 100; default fee 1% = 1.00; net = 99.00
    const updatedUser = await User.findById(user._id);
    expect(updatedUser.winningsBalance).toBe(99);
    expect(updatedUser.depositBalance).toBe(50);   // untouched by settlement
    expect(updatedUser.lockedBalance).toBe(0);     // stake lock released
    expect(updatedUser.lockedDepositAmount).toBe(0);

    const bet = await Bet.findOne({ userId: user._id });
    expect(bet.status).toBe('WON');
    expect(bet.payout).toBe(99);        // net stamped on the bet
    expect(bet.platformFee).toBe(1);    // retained fee stamped on the bet

    const tx = await Transaction.findOne({ userId: user._id, type: 'BET_WIN' });
    expect(tx).not.toBeNull();
    expect(tx.amount).toBe(99);

    const settledCycle = await Cycle.findById(cycle._id);
    expect(settledCycle.isSettled).toBe('COMPLETED');
    expect(settledCycle.totalPaidOut).toBe(99);
    expect(settledCycle.totalPlatformFees).toBe(1);
    expect(settledCycle.winningsFeePercentUsed).toBe(1);
    expect(settledCycle.netProfit).toBe(-49); // realPool 50 − paid 99 (fee retained)
  });

  it('applies the fee at paise precision: ₹10 bet → net 19.80, fee 0.20', async () => {
    const user = await User.create({
      username: 'SmallWinner',
      mobile: '1234567892',
      depositBalance: 0,
      winningsBalance: 0,
      lockedBalance: 10,
      lockedDepositAmount: 10,
    });

    const cycle = await makeCycle({ realDelhi: 10 });

    await Bet.create({
      userId: user._id,
      cycleId: cycle.cycleId,
      amount: 10,
      side: 'DELHI',
      fromDepositBalance: 10,
      status: 'PENDING',
    });

    await engine.processPayoutsOptimized(cycle);

    const updatedUser = await User.findById(user._id);
    expect(updatedUser.winningsBalance).toBe(19.8);

    const bet = await Bet.findOne({ userId: user._id });
    expect(bet.payout).toBe(19.8);
    expect(bet.platformFee).toBe(0.2);

    const settledCycle = await Cycle.findById(cycle._id);
    expect(settledCycle.totalPaidOut).toBe(19.8);
    expect(settledCycle.totalPlatformFees).toBe(0.2);
  });

  it('admin-editable: winningsFeePercent 0 restores the flat 2x payout', async () => {
    await SystemConfig().create({ key: 'main', winningsFeePercent: 0 });

    const user = await User.create({
      username: 'NoFeeWinner',
      mobile: '1234567893',
      depositBalance: 0,
      winningsBalance: 0,
      lockedBalance: 50,
      lockedDepositAmount: 50,
    });

    const cycle = await makeCycle({ realDelhi: 50 });

    await Bet.create({
      userId: user._id,
      cycleId: cycle.cycleId,
      amount: 50,
      side: 'DELHI',
      fromDepositBalance: 50,
      status: 'PENDING',
    });

    await engine.processPayoutsOptimized(cycle);

    const updatedUser = await User.findById(user._id);
    expect(updatedUser.winningsBalance).toBe(100); // flat 2x, no fee

    const bet = await Bet.findOne({ userId: user._id });
    expect(bet.payout).toBe(100);
    expect(bet.platformFee).toBe(0);

    const settledCycle = await Cycle.findById(cycle._id);
    expect(settledCycle.totalPlatformFees).toBe(0);
    expect(settledCycle.winningsFeePercentUsed).toBe(0);
  });

  it('admin-editable: payoutMultiplier 3 pays 3x the stake (Business Config Audit)', async () => {
    // Config change only — no code path is different. Proves gameEngine reads
    // SystemConfig.payoutMultiplier at settlement (was hardcoded 2).
    await SystemConfig().create({ key: 'main', payoutMultiplier: 3, winningsFeePercent: 0 });

    const user = await User.create({
      username: 'TripleWinner',
      mobile: '1234567894',
      depositBalance: 0,
      winningsBalance: 0,
      lockedBalance: 50,
      lockedDepositAmount: 50,
    });

    const cycle = await makeCycle({ realDelhi: 50 });

    await Bet.create({
      userId: user._id,
      cycleId: cycle.cycleId,
      amount: 50,
      side: 'DELHI',
      fromDepositBalance: 50,
      status: 'PENDING',
    });

    await engine.processPayoutsOptimized(cycle);

    const updatedUser = await User.findById(user._id);
    expect(updatedUser.winningsBalance).toBe(150); // 50 × 3, no fee

    const bet = await Bet.findOne({ userId: user._id });
    expect(bet.payout).toBe(150);
    expect(bet.platformFee).toBe(0);

    const settledCycle = await Cycle.findById(cycle._id);
    expect(settledCycle.totalPaidOut).toBe(150);
  });

  it('marks a loser LOST and releases their locked stake without crediting', async () => {
    const user = await User.create({
      username: 'Loser',
      mobile: '1234567891',
      depositBalance: 0,
      winningsBalance: 0,
      lockedBalance: 50,
      lockedDepositAmount: 50,
    });

    const cycle = await makeCycle({ winner: 'BOMBAY', realDelhi: 50 });

    await Bet.create({
      userId: user._id,
      cycleId: cycle.cycleId,
      amount: 50,
      side: 'DELHI',
      fromDepositBalance: 50,
      status: 'PENDING',
    });

    await engine.processPayoutsOptimized(cycle);

    const updatedUser = await User.findById(user._id);
    expect(updatedUser.winningsBalance).toBe(0);
    expect(updatedUser.depositBalance).toBe(0); // stake is gone — lost
    expect(updatedUser.lockedBalance).toBe(0);  // lock released

    const bet = await Bet.findOne({ userId: user._id });
    expect(bet.status).toBe('LOST');

    const settledCycle = await Cycle.findById(cycle._id);
    expect(settledCycle.isSettled).toBe('COMPLETED');
    expect(settledCycle.totalPaidOut).toBe(0);
    expect(settledCycle.netProfit).toBe(50); // house keeps the losing pool
  });
});
