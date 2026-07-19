// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Integration test (real DB): F-2 — settlement under concurrency and re-runs.
//
// The cycle "lock" (isSettled PENDING→PROCESSING) deliberately re-admits
// PROCESSING cycles so the recovery task can resume interrupted payouts —
// which means TWO settlement passes over the same cycle is a supported,
// expected scenario (engine tick + recovery task, or two nodes). Money
// safety therefore rests entirely on per-operation idempotency:
//   - the winnings credit  (txId win_<betId>)
//   - the stake unlock     (txId unlock_win_<betId> / unlock_lost_<betId>)
//   - the bet stamp        (status guard)
// These tests prove no double-credit, no double-unlock, and that cycle
// totals stay correct when a run resumes after a partial crash.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import GameEngine from '../../domains/markets/gameEngine.js';
import { User, Cycle, Bet } from '../../models/index.js';
import { creditWinnings, releaseLockedStake } from '../../domains/wallet/walletAuthority.service.js';

const WalletLedger = () => mongoose.model('WalletLedger');

async function seedWinnerLoser() {
  const winner = await User.create({
    username: 'cwinner', mobile: '9200000001',
    depositBalance: 0, winningsBalance: 0,
    lockedBalance: 50, lockedDepositAmount: 50,
  });
  const loser = await User.create({
    username: 'closer', mobile: '9200000002',
    depositBalance: 0, winningsBalance: 0,
    lockedBalance: 50, lockedDepositAmount: 50,
  });
  const cycle = await Cycle.create({
    cycleId: 'conc_cycle_' + Math.random().toString(16).slice(2),
    type: '30_MIN',
    startTime: Date.now() - 3600000, endTime: Date.now() - 1800000,
    status: 'RESULT_DECLARED', winner: 'DELHI', isSettled: 'PENDING',
    realDelhi: 50, realBombay: 50,
  });
  const winBet = await Bet.create({
    userId: winner._id, cycleId: cycle.cycleId, amount: 50, side: 'DELHI',
    fromDepositBalance: 50, status: 'PENDING',
  });
  await Bet.create({
    userId: loser._id, cycleId: cycle.cycleId, amount: 50, side: 'BOMBAY',
    fromDepositBalance: 50, status: 'PENDING',
  });
  return { winner, loser, cycle, winBet };
}

describe('F-2: settlement concurrency & recovery safety', () => {
  let engine;
  beforeEach(() => { engine = new GameEngine(null); });
  afterEach(() => { engine.stop(); });

  it('two concurrent settlement passes credit and unlock exactly once', async () => {
    const { winner, loser, cycle } = await seedWinnerLoser();

    const engine2 = new GameEngine(null);
    try {
      await Promise.all([
        engine.processPayoutsOptimized(cycle),
        engine2.processPayoutsOptimized(cycle),
      ]);
    } finally {
      engine2.stop();
    }

    const w = await User.findById(winner._id).lean();
    expect(w.winningsBalance).toBe(99);        // net 2x−1% ONCE, not twice
    expect(w.lockedBalance).toBe(0);           // unlocked ONCE — not negative
    expect(w.lockedDepositAmount).toBe(0);

    const l = await User.findById(loser._id).lean();
    expect(l.lockedBalance).toBe(0);           // loss unlock once — not negative
    expect(l.lockedDepositAmount).toBe(0);

    // Exactly one ledger entry per money movement.
    expect(await WalletLedger().countDocuments({ userId: winner._id, type: 'CREDIT', field: 'winningsBalance' })).toBe(1);
    expect(await WalletLedger().countDocuments({ userId: winner._id, field: 'lockedBalance' })).toBe(1);
    expect(await WalletLedger().countDocuments({ userId: loser._id, field: 'lockedBalance' })).toBe(1);

    const c = await Cycle.findById(cycle._id).lean();
    expect(c.isSettled).toBe('COMPLETED');
    expect(c.totalPaidOut).toBe(99);
    expect(c.totalPlatformFees).toBe(1);
    expect(c.netProfit).toBeCloseTo(1, 9);     // 100 pool − 99 paid
  });

  it('a full re-run after completion changes nothing (idempotent recovery)', async () => {
    const { winner, cycle } = await seedWinnerLoser();

    await engine.processPayoutsOptimized(cycle);
    // Simulate a stuck-PROCESSING state the recovery task would resume.
    await Cycle.updateOne({ _id: cycle._id }, { $set: { isSettled: 'PROCESSING' } });
    const again = await Cycle.findById(cycle._id);
    await engine.processPayoutsOptimized(again);

    const w = await User.findById(winner._id).lean();
    expect(w.winningsBalance).toBe(99);
    expect(w.lockedBalance).toBe(0);

    const c = await Cycle.findById(cycle._id).lean();
    expect(c.isSettled).toBe('COMPLETED');
    expect(c.totalPaidOut).toBe(99);           // totals not double-counted
    expect(c.totalPlatformFees).toBe(1);
  });

  it('resuming after a partial crash yields correct cycle totals (derived from DB)', async () => {
    // Two winners; simulate "run died after fully paying winner A":
    // A is credited, unlocked, and stamped WON; B is still PENDING.
    const a = await User.create({
      username: 'partialA', mobile: '9200000003',
      winningsBalance: 0, lockedBalance: 50, lockedDepositAmount: 50,
    });
    const b = await User.create({
      username: 'partialB', mobile: '9200000004',
      winningsBalance: 0, lockedBalance: 50, lockedDepositAmount: 50,
    });
    const cycle = await Cycle.create({
      cycleId: 'partial_cycle_1', type: '30_MIN',
      startTime: Date.now() - 3600000, endTime: Date.now() - 1800000,
      status: 'RESULT_DECLARED', winner: 'DELHI', isSettled: 'PROCESSING',
      realDelhi: 100, realBombay: 0,
    });
    const betA = await Bet.create({
      userId: a._id, cycleId: cycle.cycleId, amount: 50, side: 'DELHI',
      fromDepositBalance: 50, status: 'PENDING',
    });
    await Bet.create({
      userId: b._id, cycleId: cycle.cycleId, amount: 50, side: 'DELHI',
      fromDepositBalance: 50, status: 'PENDING',
    });

    // Replay exactly what the first (crashed) run did for A, with the same
    // deterministic txIds the engine uses — so the resume must no-op them.
    await creditWinnings(String(a._id), 99, 'Cycle win payout (2x minus 1% platform fee)', String(betA._id), `win_${betA._id}`);
    await releaseLockedStake(String(a._id), {
      amount: 50, fromDeposit: 50, fromWinnings: 0,
      refId: String(betA._id), txId: `unlock_win_${betA._id}`,
      reason: 'Won bet stake unlock — cycle settlement',
    });
    await Bet.updateOne({ _id: betA._id }, { $set: { status: 'WON', payout: 99, platformFee: 1 } });

    // Resume settlement (recovery path processes PROCESSING cycles).
    await engine.processPayoutsOptimized(await Cycle.findById(cycle._id));

    const aFresh = await User.findById(a._id).lean();
    const bFresh = await User.findById(b._id).lean();
    expect(aFresh.winningsBalance).toBe(99);   // not re-credited
    expect(aFresh.lockedBalance).toBe(0);      // not re-unlocked
    expect(bFresh.winningsBalance).toBe(99);   // B paid by the resume
    expect(bFresh.lockedBalance).toBe(0);

    // Totals must cover BOTH winners even though the resume only paid B.
    const c = await Cycle.findById(cycle._id).lean();
    expect(c.isSettled).toBe('COMPLETED');
    expect(c.totalPaidOut).toBe(198);
    expect(c.totalPlatformFees).toBe(2);
    expect(c.netProfit).toBeCloseTo(-98, 9);   // 100 pool − 198 paid
  });
});
