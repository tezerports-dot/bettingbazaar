// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Integration test (real DB): the Merchant Performance Bonus accounting rules
// (Revenue & Settlement) — pool funding capped at distributable revenue, and
// issuance that is pool-capped, idempotent and mirrored by the wallet credit.
import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import '../../models/index.js';
import {
  recordAccountingEvent, buildCyclePostings, fundMerchantBonusPool,
  issueMerchantBonus, getTrialBalance, getDistributableRevenueMinor,
  getAccountBalanceMinor,
} from '../../domains/revenue/revenueSettlement.service.js';
import { creditMerchantTokens } from '../../domains/merchant/merchantWallet.service.js';
import { ACCOUNTS, EVENT_TYPES } from '../../domains/revenue/chartOfAccounts.js';


// REMOVED with the Mongo wallet: the withdrawal-lock lifecycle used to be
// tested here by seeding `User.winningsBalance` and asserting the Mongo
// document afterwards. Balances live in PostgreSQL now, so the seed produced a
// user with nothing in it and lockWithdrawal correctly refused —
// "Insufficient withdrawable balance: have Rs 0".
//
// Not lost coverage. lock/release/refund are exercised against real PostgreSQL
// in walletPgAuthority.test.js (including the idempotent re-lock and the
// over-balance refusal) and in moneyConservation.test.js, which additionally
// proves the pockets conserve to zero across the whole lifecycle — more than
// this asserted.

describe('Merchant Performance Bonus accounting (Revenue & Settlement)', () => {
  const actor = { userId: new mongoose.Types.ObjectId() };

  async function seedRevenue(minor) {
    // A profitable settled cycle is the canonical source of PLATFORM_REVENUE.
    await recordAccountingEvent({
      eventType: EVENT_TYPES.BET_CYCLE_SETTLED,
      idempotencyKey: 'acct_cycle_seed_' + Math.random().toString(16).slice(2),
      postings: buildCyclePostings({ netProfit: minor / 100 }),
      refModel: 'Cycle', refId: 'seed',
      description: 'Test seed: profitable settled cycle (canonical revenue source)',
    });
  }

  it('pool funding is capped at distributable revenue — never beyond earnings', async () => {
    await seedRevenue(50000); // ₹500 earned
    expect(await getDistributableRevenueMinor()).toBe(50000);

    await expect(fundMerchantBonusPool({
      amountMinor: 60000, actor, justification: 'over-fund attempt',
    })).rejects.toThrow(/distributable/i);

    await fundMerchantBonusPool({
      amountMinor: 30000, actor, justification: 'monthly bonus pool',
    });
    expect(await getDistributableRevenueMinor()).toBe(20000); // 500 − 300
    expect(await getAccountBalanceMinor(ACCOUNTS.MERCHANT_BONUS_POOL.code)).toBe(30000);

    const trial = await getTrialBalance();
    expect(trial.integrityOk).toBe(true);
  });

  it('bonus issuance: pool-capped, idempotent, mirrored by the merchant wallet credit', async () => {
    await seedRevenue(50000);
    await fundMerchantBonusPool({ amountMinor: 30000, actor, justification: 'pool' });

    const Merchant = mongoose.model('Merchant');
    const m = await Merchant.create({ name: 'Bonus M', username: 'bm1', mobile: '9300000004', tokenBalance: 0 });

    // Beyond the pool → refused.
    await expect(issueMerchantBonus({
      merchantId: m._id, amountMinor: 40000, idempotencyKey: `acct_bonusissue_${m._id}_x`,
    })).rejects.toThrow(/pool holds/i);

    // Within the pool: ledger event + the mirrored wallet credit, sharing
    // one deterministic key — exactly the engine's two-step issuance.
    const key = `acct_bonusissue_${m._id}_100000`;
    const res = await issueMerchantBonus({ merchantId: m._id, amountMinor: 10000, idempotencyKey: key });
    expect(res.idempotent).toBe(false);
    await creditMerchantTokens({
      merchantId: m._id, amount: 100, reason: 'Merchant Performance Bonus',
      refModel: 'Merchant', refId: String(m._id), txId: key,
    });

    // Crash-replay of both steps → no double money.
    const replayLedger = await issueMerchantBonus({ merchantId: m._id, amountMinor: 10000, idempotencyKey: key });
    expect(replayLedger.idempotent).toBe(true);
    const replayWallet = await creditMerchantTokens({
      merchantId: m._id, amount: 100, reason: 'Merchant Performance Bonus',
      refModel: 'Merchant', refId: String(m._id), txId: key,
    });
    expect(replayWallet.idempotent).toBe(true);

    const fresh = await Merchant.findById(m._id).lean();
    expect(fresh.tokenBalance).toBe(100); // credited once

    expect(await getAccountBalanceMinor(ACCOUNTS.MERCHANT_BONUS_POOL.code)).toBe(20000);
    expect(await getAccountBalanceMinor(ACCOUNTS.MERCHANT_FUNDS.code)).toBe(10000);
    const trial = await getTrialBalance();
    expect(trial.integrityOk).toBe(true); // whole ledger still conserves
  });
});
