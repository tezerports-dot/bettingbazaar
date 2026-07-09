// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the Revenue & Settlement ledger math (pure, no DB).
// These are the money-correctness invariants — the most important tests in
// the repo. If any of these fail, money is being created or destroyed.
import { describe, it, expect } from 'vitest';
import {
  validatePostings, buildDepositPostings, buildWithdrawalPostings,
  buildCyclePostings, buildBonusFundingPostings, buildBonusIssuePostings,
} from '../../domains/revenue/revenueSettlement.service.js';
import { toMinor, toRupees } from '../../domains/revenue/chartOfAccounts.js';

const sum = ps => ps.reduce((s, p) => s + p.amountMinor, 0);
const leg = (ps, a) => ps.find(p => p.account === a)?.amountMinor;

describe('minor-unit money math', () => {
  it('converts rupees to integer paise', () => expect(toMinor(100)).toBe(10000));
  it('kills float drift (0.1 + 0.2)', () => expect(toMinor(0.1) + toMinor(0.2)).toBe(30));
  it('round-trips', () => expect(toRupees(12345)).toBe(123.45));
  it('rejects non-integer minor input', () => expect(() => toRupees(1.5)).toThrow());
});

describe('double-entry invariant (every entry sums to zero)', () => {
  it('rejects single-leg entries', () =>
    expect(() => validatePostings([{ account: 'EXTERNAL_FIAT', amountMinor: 100 }])).toThrow());
  it('rejects unknown accounts', () =>
    expect(() => validatePostings([{ account: 'NOPE', amountMinor: 1 }, { account: 'USER_FUNDS', amountMinor: -1 }])).toThrow());
  it('rejects unbalanced postings', () =>
    expect(() => validatePostings([{ account: 'EXTERNAL_FIAT', amountMinor: 100 }, { account: 'USER_FUNDS', amountMinor: -99 }])).toThrow());
  it('rejects float amounts', () =>
    expect(() => validatePostings([{ account: 'EXTERNAL_FIAT', amountMinor: 100.5 }, { account: 'USER_FUNDS', amountMinor: -100.5 }])).toThrow());
  it('accepts a balanced two-leg entry', () =>
    expect(validatePostings([{ account: 'EXTERNAL_FIAT', amountMinor: 100 }, { account: 'USER_FUNDS', amountMinor: -100 }])).toBe(true));
});

describe('deposit postings', () => {
  it('1:1 deposit: fiat in, user + reserve liability, no residual', () => {
    const p = buildDepositPostings({ fiatAmount: 100, tokenAmount: 100, depositAllocation: 90, reserveAllocation: 10 });
    expect(sum(p)).toBe(0);
    expect(leg(p, 'EXTERNAL_FIAT')).toBe(10000);
    expect(leg(p, 'USER_FUNDS')).toBe(-9000);
    expect(leg(p, 'PLATFORM_RESERVE')).toBe(-1000);
    expect(leg(p, 'PLATFORM_REVENUE')).toBeUndefined();
  });
  it('historical 1.1-rate deposit: spread lands in revenue', () => {
    const p = buildDepositPostings({ fiatAmount: 110, tokenAmount: 100, depositAllocation: 90, reserveAllocation: 10 });
    expect(sum(p)).toBe(0);
    expect(leg(p, 'PLATFORM_REVENUE')).toBe(-1000);
  });
  it('legacy no-allocation deposit: full amount is user liability', () => {
    const p = buildDepositPostings({ fiatAmount: 100, tokenAmount: 100, depositAllocation: 0, reserveAllocation: 0 });
    expect(sum(p)).toBe(0);
    expect(leg(p, 'USER_FUNDS')).toBe(-10000);
  });
});

describe('withdrawal postings (incl. Phase-010 payout fee)', () => {
  it('1:1 withdrawal balances', () => {
    const p = buildWithdrawalPostings({ tokenAmount: 500, fiatAmount: 500 });
    expect(sum(p)).toBe(0);
    expect(leg(p, 'USER_FUNDS')).toBe(50000);
    expect(leg(p, 'EXTERNAL_FIAT')).toBe(-50000);
  });
  it('fee routes to PAYOUT_FEES, no spurious revenue leg', () => {
    const p = buildWithdrawalPostings({ tokenAmount: 1000, fiatAmount: 980, payoutFee: 20 });
    expect(sum(p)).toBe(0);
    expect(leg(p, 'PAYOUT_FEES')).toBe(-2000);
    expect(leg(p, 'PLATFORM_REVENUE')).toBeUndefined();
  });
  it('historical spread still to PLATFORM_REVENUE', () => {
    const p = buildWithdrawalPostings({ tokenAmount: 500, fiatAmount: 475 });
    expect(leg(p, 'PLATFORM_REVENUE')).toBe(-2500);
  });
  it('mixed fee + spread splits correctly', () => {
    const p = buildWithdrawalPostings({ tokenAmount: 1000, fiatAmount: 970, payoutFee: 20 });
    expect(sum(p)).toBe(0);
    expect(leg(p, 'PAYOUT_FEES')).toBe(-2000);
    expect(leg(p, 'PLATFORM_REVENUE')).toBe(-1000);
  });
});

describe('cycle settlement postings', () => {
  it('profit cycle credits revenue', () => {
    const p = buildCyclePostings({ netProfit: 1234.56 });
    expect(sum(p)).toBe(0);
    expect(leg(p, 'PLATFORM_REVENUE')).toBe(-123456);
  });
  it('loss cycle debits revenue (signs flip)', () => {
    const p = buildCyclePostings({ netProfit: -200 });
    expect(sum(p)).toBe(0);
    expect(leg(p, 'PLATFORM_REVENUE')).toBe(20000);
  });
  it('zero-net cycle still records a balanced marker', () => {
    const p = buildCyclePostings({ netProfit: 0 });
    expect(sum(p)).toBe(0);
    expect(p.length).toBe(2);
  });
});

describe('merchant bonus postings', () => {
  it('funding moves revenue -> pool only', () => {
    const p = buildBonusFundingPostings(50000);
    expect(sum(p)).toBe(0);
    expect(leg(p, 'PLATFORM_REVENUE')).toBe(50000);
    expect(leg(p, 'MERCHANT_BONUS_POOL')).toBe(-50000);
  });
  it('issuing moves pool -> merchant liability only', () => {
    const p = buildBonusIssuePostings(5000);
    expect(sum(p)).toBe(0);
    expect(leg(p, 'MERCHANT_BONUS_POOL')).toBe(5000);
    expect(leg(p, 'MERCHANT_FUNDS')).toBe(-5000);
  });
  it('rejects non-positive / fractional funding', () => {
    expect(() => buildBonusFundingPostings(-5)).toThrow();
    expect(() => buildBonusFundingPostings(10.5)).toThrow();
  });
});

describe('full-lifecycle conservation', () => {
  it('deposit -> cycle -> withdrawal -> bonus funding conserves to zero', () => {
    const all = [
      ...buildDepositPostings({ fiatAmount: 1000, tokenAmount: 1000, depositAllocation: 900, reserveAllocation: 100 }),
      ...buildCyclePostings({ netProfit: 300 }),
      ...buildWithdrawalPostings({ tokenAmount: 600, fiatAmount: 600 }),
      ...buildBonusFundingPostings(toMinor(100)),
    ];
    expect(sum(all)).toBe(0);
    const revenueNet = -all.filter(p => p.account === 'PLATFORM_REVENUE').reduce((s, p) => s + p.amountMinor, 0);
    expect(revenueNet).toBe(toMinor(200)); // +300 profit - 100 funded
  });
});
