// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
import { describe, it, expect, beforeEach } from 'vitest';
import GameEngine from '../gameEngine.js';
import { User, Cycle, Bet, Transaction } from '../models/index.js';
import mongoose from 'mongoose';

describe('Game Engine Settlement', () => {
  let engine;
  
  beforeEach(() => {
    engine = new GameEngine(null); 
  });

  it('should process winning bets and update balances correctly', async () => {
    // 1. Setup User
    const user = await User.create({
      username: 'Winner',
      mobile: '1234567890',
      walletBalance: 100
    });

    // 2. Setup Cycle
    const cycle = await Cycle.create({
      cycleId: 'test_cycle_1',
      type: '30_MIN',
      startTime: Date.now() - 3600000,
      endTime: Date.now() - 1800000,
      status: 'RESULT_DECLARED',
      winner: 'DELHI',
      isSettled: 'PENDING'
    });

    // 3. Setup winning bet
    await Bet.create({
      userId: user._id,
      cycleId: cycle.cycleId,
      amount: 50,
      side: 'DELHI',
      status: 'PENDING'
    });

    // 4. Run settlement
    await engine.processPayoutsOptimized(cycle);

    // 5. Verify results
    const updatedUser = await User.findById(user._id);
    // 100 initial + (50 * 2) payout = 200
    expect(updatedUser.walletBalance).toBe(200);

    const bet = await Bet.findOne({ userId: user._id });
    expect(bet.status).toBe('WON');

    const tx = await Transaction.findOne({ userId: user._id, type: 'BET_WIN' });
    expect(tx).not.toBeNull();
    expect(tx.amount).toBe(100);
  });
});
