// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Integration test: the Revenue & Settlement reconciler against a REAL
// (in-memory) MongoDB. Proves the two invariants that matter most for a
// money system: (1) the ledger derived from completed source records
// conserves to zero across all accounts, and (2) reconciliation is
// idempotent — re-running never double-posts. Runs in CI (mongod reachable).
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import '../../models/index.js';
import {
  reconcileCompletedOrders, reconcileSettledCycles, getTrialBalance,
} from '../../domains/revenue/revenueSettlement.service.js';

const PaymentOrder = () => mongoose.model('PaymentOrder');
const Cycle        = () => mongoose.model('Cycle');
const Ledger       = () => mongoose.model('AccountingEvent');

// NOTE: no local beforeEach cleanup here. The global setup (tests/setup.js)
// wipes every collection via the RAW driver between tests — a model-level
// AccountingEvent.deleteMany() would (correctly) be rejected by the ledger's
// append-only middleware and fail every test in this file.

async function seedCompletedDeposit(overrides = {}) {
  return PaymentOrder().create({
    orderId: 'DEP_' + Math.random().toString(16).slice(2),
    userId: new mongoose.Types.ObjectId(),
    type: 'DEPOSIT', status: 'COMPLETED',
    tokenAmount: 1000, fiatAmount: 1000, rateUsed: 1,
    depositAllocation: 900, reserveAllocation: 100,
    completedAt: new Date(),
    ...overrides,
  });
}

describe('ledger reconciliation (real DB)', () => {
  it('derives a balanced entry for a completed deposit and conserves to zero', async () => {
    await seedCompletedDeposit();
    const res = await reconcileCompletedOrders();
    expect(res.filter(r => r.recorded).length).toBe(1);

    const trial = await getTrialBalance();
    expect(trial.integrityOk).toBe(true); // every posting across the ledger sums to 0
    expect(trial.accounts.EXTERNAL_FIAT.reportedMinor).toBe(100000);      // ₹1000 in
    expect(trial.accounts.USER_FUNDS.reportedMinor).toBe(90000);          // 900 tokens liability
    expect(trial.accounts.PLATFORM_RESERVE.reportedMinor).toBe(10000);    // 100 reserve
  });

  it('is idempotent — a second pass records nothing and does not double-post', async () => {
    await seedCompletedDeposit();
    await reconcileCompletedOrders();
    const second = await reconcileCompletedOrders();
    expect(second.filter(r => r.recorded).length).toBe(0);

    const count = await Ledger().countDocuments({});
    expect(count).toBe(1); // exactly one entry, not two
    const trial = await getTrialBalance();
    expect(trial.integrityOk).toBe(true);
  });

  it('records a settled cycle net profit into platform revenue', async () => {
    await Cycle().create({
      cycleId: 'CYC_' + Math.random().toString(16).slice(2),
      type: '30_MIN', startTime: Date.now() - 3600000, endTime: Date.now() - 1800000,
      status: 'COMPLETED',
      isSettled: 'COMPLETED', winner: 'DELHI',
      realDelhi: 500, realBombay: 500, totalPaidOut: 800, netProfit: 200,
      settledAt: new Date(),
    });
    const res = await reconcileSettledCycles();
    expect(res.filter(r => r.recorded).length).toBe(1);

    const trial = await getTrialBalance();
    expect(trial.integrityOk).toBe(true);
    expect(trial.accounts.PLATFORM_REVENUE.reportedMinor).toBe(20000); // ₹200 profit
  });

  it('the ledger is append-only — direct mutation throws', async () => {
    await seedCompletedDeposit();
    await reconcileCompletedOrders();
    const entry = await Ledger().findOne({});
    await expect(
      Ledger().updateOne({ _id: entry._id }, { $set: { description: 'tampered' } })
    ).rejects.toThrow();
  });
});
