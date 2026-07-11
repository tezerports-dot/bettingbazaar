// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Integration test (real DB): data retention (Phase X X-7). Proves the two
// properties that matter — old OPERATIONAL data is pruned, and financial /
// audit data is NEVER touched regardless of age.
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import '../../models/index.js';
import { runRetention, retentionCutoff } from '../../domains/operations/retention.service.js';

const Bet          = () => mongoose.model('Bet');
const Cycle        = () => mongoose.model('Cycle');
const Transaction  = () => mongoose.model('Transaction');
const WalletLedger = () => mongoose.model('WalletLedger');
const AccountingEvent = () => mongoose.model('AccountingEvent');

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

describe('data retention (X-7)', () => {
  it('cutoff never deletes anything younger than the 30-day safety floor', () => {
    // Even with a 0/absurd config, the cutoff is at least 30 days in the past.
    const c0 = retentionCutoff(0);
    const c1 = retentionCutoff(1);
    const floor = daysAgo(30);
    expect(c0.getTime()).toBeLessThanOrEqual(floor.getTime() + 1000);
    expect(c1.getTime()).toBeLessThanOrEqual(floor.getTime() + 1000);
  });

  it('prunes old settled bets & completed cycles but keeps recent + financial data', async () => {
    const userId = new mongoose.Types.ObjectId();

    // Old, settled → prunable.
    await Bet().create({ userId, cycleId: 'old1', amount: 50, side: 'DELHI', status: 'WON', settledAt: daysAgo(400) });
    await Bet().create({ userId, cycleId: 'old2', amount: 50, side: 'BOMBAY', status: 'LOST', settledAt: daysAgo(400) });
    await Cycle().create({ cycleId: 'oldC', type: '30_MIN', startTime: Date.now() - 4e10, endTime: Date.now() - 4e10,
      status: 'COMPLETED', isSettled: 'COMPLETED', settledAt: daysAgo(400) });

    // Recent settled → kept (within window).
    await Bet().create({ userId, cycleId: 'new1', amount: 50, side: 'DELHI', status: 'WON', settledAt: daysAgo(2) });
    // Old but still PENDING → never pruned (not settled).
    await Bet().create({ userId, cycleId: 'pend', amount: 50, side: 'DELHI', status: 'PENDING', timestamp: daysAgo(400) });

    // Financial/audit data, old — MUST survive.
    await Transaction().create({ userId, type: 'BET_WIN', amount: 100, status: 'SUCCESS', timestamp: daysAgo(400) });
    await WalletLedger().create({ userId, type: 'CREDIT', field: 'winningsBalance', amount: 100,
      balanceBefore: 0, balanceAfter: 100, reason: 'old win', txId: 'ret_test_' + Math.random() });
    await AccountingEvent().create({
      eventType: 'BET_CYCLE_SETTLED', idempotencyKey: 'ret_test_' + Math.random(),
      postings: [{ account: 'USER_FUNDS', amountMinor: 100 }, { account: 'PLATFORM_REVENUE', amountMinor: -100 }],
      refModel: 'Cycle', refId: 'oldC', description: 'old settled cycle', occurredAt: daysAgo(400),
    });

    const before = await AccountingEvent().countDocuments({});
    const res = await runRetention({ months: 6, dryRun: false });

    // Operational: the two old settled bets + old cycle pruned; pending + recent kept.
    expect(await Bet().countDocuments({ cycleId: { $in: ['old1', 'old2'] } })).toBe(0);
    expect(await Bet().countDocuments({ cycleId: 'new1' })).toBe(1); // recent kept
    expect(await Bet().countDocuments({ cycleId: 'pend' })).toBe(1); // pending never pruned
    expect(await Cycle().countDocuments({ cycleId: 'oldC' })).toBe(0);

    // Financial/audit: untouched.
    expect(await Transaction().countDocuments({ userId })).toBe(1);
    expect(await WalletLedger().countDocuments({ userId })).toBe(1);
    expect(await AccountingEvent().countDocuments({})).toBe(before);

    const betResult = res.results.find(r => r.model === 'Bet');
    expect(betResult.deleted).toBe(2);
  });

  it('dryRun counts but deletes nothing', async () => {
    const userId = new mongoose.Types.ObjectId();
    await Bet().create({ userId, cycleId: 'dry1', amount: 50, side: 'DELHI', status: 'WON', settledAt: daysAgo(400) });
    const res = await runRetention({ months: 6, dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(await Bet().countDocuments({ cycleId: 'dry1' })).toBe(1); // still there
    const betResult = res.results.find(r => r.model === 'Bet');
    expect(betResult.eligible).toBeGreaterThanOrEqual(1);
    expect(betResult.deleted).toBe(0);
  });
});
