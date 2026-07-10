// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Integration test (real DB): cycle settlement through the actual GameEngine.
// Exercises the dual-balance system the way production does — a placed bet
// has already debited balances and locked the stake, settlement credits
// winnings via walletAuthority and releases the lock.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import GameEngine from '../../domains/markets/gameEngine.js';
import { User, Cycle, Bet, Transaction } from '../../models/index.js';

describe('Game Engine Settlement', () => {
  let engine;

  beforeEach(() => {
    engine = new GameEngine(null);
  });

  afterEach(() => {
    engine.stop(); // clear tick/recovery intervals so the worker can exit
  });

  it('pays a winner 2x into winningsBalance and releases the locked stake', async () => {
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

    const cycle = await Cycle.create({
      cycleId: 'test_cycle_1',
      type: '30_MIN',
      startTime: Date.now() - 3600000,
      endTime: Date.now() - 1800000,
      status: 'RESULT_DECLARED',
      winner: 'DELHI',
      isSettled: 'PENDING',
      realDelhi: 50,
      realBombay: 0,
    });

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
    expect(updatedUser.winningsBalance).toBe(100); // 2x payout
    expect(updatedUser.depositBalance).toBe(50);   // untouched by settlement
    expect(updatedUser.lockedBalance).toBe(0);     // stake lock released
    expect(updatedUser.lockedDepositAmount).toBe(0);

    const bet = await Bet.findOne({ userId: user._id });
    expect(bet.status).toBe('WON');
    expect(bet.payout).toBe(100);

    const tx = await Transaction.findOne({ userId: user._id, type: 'BET_WIN' });
    expect(tx).not.toBeNull();
    expect(tx.amount).toBe(100);

    const settledCycle = await Cycle.findById(cycle._id);
    expect(settledCycle.isSettled).toBe('COMPLETED');
    expect(settledCycle.totalPaidOut).toBe(100);
    expect(settledCycle.netProfit).toBe(-50); // realPool 50 − paid 100
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

    const cycle = await Cycle.create({
      cycleId: 'test_cycle_2',
      type: '30_MIN',
      startTime: Date.now() - 3600000,
      endTime: Date.now() - 1800000,
      status: 'RESULT_DECLARED',
      winner: 'BOMBAY',
      isSettled: 'PENDING',
      realDelhi: 50,
      realBombay: 0,
    });

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
