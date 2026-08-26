// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the Risk Platform validators + reserve split (pure, no DB).
import { describe, it, expect } from 'vitest';
import {
  assertPositiveNumber, assertMultipleOf10, validateTokenPurchase,
  validateTokenSale, validateBetAmount, computeReserveSplit, computePayoutFeeMinor,
  computeBetFundingPlan, computeWinningsPayout,
} from '../../domains/risk/riskValidation.service.js';

describe('positive / numeric guards', () => {
  it('rejects strings, NaN, negative, zero', () => {
    expect(() => assertPositiveNumber('50')).toThrow();
    expect(() => assertPositiveNumber(NaN)).toThrow();
    expect(() => assertPositiveNumber(-10)).toThrow();
    expect(() => assertPositiveNumber(0)).toThrow();
  });
  it('accepts a positive number', () => expect(assertPositiveNumber(10)).toBe(true));
});

describe('multiples of 10', () => {
  it('rejects 15 and 10.5', () => {
    expect(() => assertMultipleOf10(15)).toThrow();
    expect(() => assertMultipleOf10(10.5)).toThrow();
  });
  it('accepts 500', () => expect(assertMultipleOf10(500)).toBe(true));
});

describe('purchase / sale / bet gates', () => {
  it('enforces multiples when on', () =>
    expect(() => validateTokenPurchase({ amount: 105, min: 100, max: 50000, enforceMultiples: true })).toThrow());
  it('allows non-multiples when off', () =>
    expect(validateTokenPurchase({ amount: 105, min: 100, max: 50000, enforceMultiples: false })).toBe(true));
  it('enforces min and max', () => {
    expect(() => validateTokenPurchase({ amount: 90, min: 100, max: 50000 })).toThrow();
    expect(() => validateTokenSale({ amount: 60000, min: 500, max: 50000 })).toThrow();
  });
  it('bet rejects 15 with multiples on, accepts 50', () => {
    expect(() => validateBetAmount({ amount: 15, min: 10, max: 100000, enforceMultiples: true })).toThrow();
    expect(validateBetAmount({ amount: 50, min: 10, max: 100000 })).toBe(true);
  });
});

describe('reserve split conserves the full amount (Spec 4.4)', () => {
  it('100 @ 10% -> 90/10', () => {
    const s = computeReserveSplit(100, 10);
    expect(s).toEqual({ depositAllocation: 90, reserveAllocation: 10 });
  });
  it('105 @ 10% -> 95/10, remainder to deposit, conserved', () => {
    const s = computeReserveSplit(105, 10);
    expect(s.reserveAllocation).toBe(10);
    expect(s.depositAllocation).toBe(95);
    expect(s.depositAllocation + s.reserveAllocation).toBe(105);
  });
  it('tiny amounts conserve', () => {
    const s = computeReserveSplit(7, 33);
    expect(s.depositAllocation + s.reserveAllocation).toBe(7);
  });
});

describe('payout fee (floored paise, never rounds up against the user)', () => {
  it('0% = 0', () => expect(computePayoutFeeMinor(1000, 0)).toBe(0));
  it('2% of 1000 = 2000 paise', () => expect(computePayoutFeeMinor(1000, 2)).toBe(2000));
  it('3% of 333 floors to 999 paise', () => expect(computePayoutFeeMinor(333, 3)).toBe(999));
  it('rejects >100%', () => expect(() => computePayoutFeeMinor(100, 101)).toThrow());
});

describe('bet funding plan (Phase A — paise-exact, admin-editable reserve %)', () => {
  const ample = { availableDeposit: 100000, availableWinnings: 100000, availableReserve: 100000 };

  it('₹10 @ 3% pulls 9.70 deposit / 0.30 reserve — arithmetic at an explicit percent', () => {
    const p = computeBetFundingPlan({ amount: 10, reservePercent: 3, ...ample });
    expect(p.fromReserve).toBe(0.3);
    expect(p.fromDeposit).toBe(9.7);
    expect(p.fromWinnings).toBe(0);
    expect(p.fromDepositMinor + p.fromWinningsMinor + p.fromReserveMinor).toBe(1000);
  });

  it('REGRESSION ₹50 @ 3%: old Math.round code deducted ₹51 for a ₹50 stake', () => {
    const p = computeBetFundingPlan({ amount: 50, reservePercent: 3, ...ample });
    expect(p.fromReserve).toBe(1.5);
    expect(p.fromDeposit).toBe(48.5);
    expect(p.fromDepositMinor + p.fromWinningsMinor + p.fromReserveMinor).toBe(5000);
  });

  it('₹100 @ 3% -> 97/3 whole tokens', () => {
    const p = computeBetFundingPlan({ amount: 100, reservePercent: 3, ...ample });
    expect(p.fromDeposit).toBe(97);
    expect(p.fromReserve).toBe(3);
  });

  it('reserve short → shortfall shifts to main (Spec 5.2C)', () => {
    const p = computeBetFundingPlan({
      amount: 10, reservePercent: 3,
      availableDeposit: 100, availableWinnings: 0, availableReserve: 0.1,
    });
    expect(p.fromReserve).toBe(0.1);   // drained
    expect(p.fromDeposit).toBe(9.9);   // 9.70 + 0.20 shortfall
    expect(p.fromDepositMinor + p.fromWinningsMinor + p.fromReserveMinor).toBe(1000);
  });

  it('deposit short → overflow to winnings', () => {
    const p = computeBetFundingPlan({
      amount: 100, reservePercent: 3,
      availableDeposit: 50, availableWinnings: 100, availableReserve: 10,
    });
    expect(p.fromReserve).toBe(3);
    expect(p.fromDeposit).toBe(50);    // drained
    expect(p.fromWinnings).toBe(47);
  });

  it('0% reserve = everything from main; 100% = everything from reserve', () => {
    const zero = computeBetFundingPlan({ amount: 10, reservePercent: 0, ...ample });
    expect(zero.fromReserve).toBe(0);
    expect(zero.fromDeposit).toBe(10);
    const full = computeBetFundingPlan({ amount: 10, reservePercent: 100, ...ample });
    expect(full.fromReserve).toBe(10);
    expect(full.fromDeposit).toBe(0);
  });

  it('fractional percent works at basis-point precision: 2.5% of ₹10 = 0.25', () => {
    const p = computeBetFundingPlan({ amount: 10, reservePercent: 2.5, ...ample });
    expect(p.fromReserve).toBe(0.25);
    expect(p.fromDeposit).toBe(9.75);
  });

  it('drained bucket returns the caller float verbatim so $gte guards cannot miss', () => {
    const drifted = 0.1 + 0.2; // 0.30000000000000004 — classic float drift
    const p = computeBetFundingPlan({
      amount: 10, reservePercent: 3,
      availableDeposit: 100, availableWinnings: 0, availableReserve: drifted,
    });
    expect(Object.is(p.fromReserve, drifted)).toBe(true); // bit-identical
  });

  it('conserves the exact stake across amounts × percents (property sweep)', () => {
    for (const amount of [10, 20, 30, 50, 70, 90, 110, 250, 570, 1000, 99990]) {
      for (const pct of [0, 1, 2.5, 3, 7, 10, 33.33, 50, 97, 100]) {
        const p = computeBetFundingPlan({ amount, reservePercent: pct, ...ample });
        expect(p.fromDepositMinor + p.fromWinningsMinor + p.fromReserveMinor).toBe(amount * 100);
        expect(p.fromDepositMinor).toBeGreaterThanOrEqual(0);
        expect(p.fromWinningsMinor).toBeGreaterThanOrEqual(0);
        expect(p.fromReserveMinor).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('throws INSUFFICIENT_BALANCE when the three buckets cannot cover the stake', () => {
    expect(() => computeBetFundingPlan({
      amount: 100, reservePercent: 3,
      availableDeposit: 40, availableWinnings: 40, availableReserve: 10,
    })).toThrow(/Insufficient/);
  });

  it('rejects bad percents', () => {
    expect(() => computeBetFundingPlan({ amount: 10, reservePercent: -1, ...ample })).toThrow();
    expect(() => computeBetFundingPlan({ amount: 10, reservePercent: 101, ...ample })).toThrow();
    expect(() => computeBetFundingPlan({ amount: 10, reservePercent: NaN, ...ample })).toThrow();
  });
});

describe('winnings payout with platform fee (Phase A — 2x minus fee, floored)', () => {
  it("owner's canonical example: bet 100 @ 1% → gross 200, fee 2, net 198", () => {
    const p = computeWinningsPayout({ amount: 100, feePercent: 1 });
    expect(p.gross).toBe(200);
    expect(p.fee).toBe(2);
    expect(p.net).toBe(198);
  });

  it('bet 10 @ 1% → gross 20, fee 0.20, net 19.80 (paise precision)', () => {
    const p = computeWinningsPayout({ amount: 10, feePercent: 1 });
    expect(p.gross).toBe(20);
    expect(p.fee).toBe(0.2);
    expect(p.net).toBe(19.8);
  });

  it('0% fee = flat 2x (pre-Phase-A behavior when admin sets 0)', () => {
    const p = computeWinningsPayout({ amount: 50, feePercent: 0 });
    expect(p.gross).toBe(100);
    expect(p.fee).toBe(0);
    expect(p.net).toBe(100);
  });

  it('fee floors in paise — never rounds up against the user', () => {
    // gross 2000 paise × 0.33% = 6.6 paise → floors to 6 (0.06), not 7
    const p = computeWinningsPayout({ amount: 10, feePercent: 0.33 });
    expect(p.feeMinor).toBe(6);
    expect(p.netMinor).toBe(1994);
  });

  it('net + fee equals gross exactly across amounts × percents (property sweep)', () => {
    for (const amount of [10, 30, 50, 70, 110, 250, 570, 1000, 99990]) {
      for (const pct of [0, 0.5, 1, 1.5, 2.5, 5, 10, 33.33, 100]) {
        const p = computeWinningsPayout({ amount, feePercent: pct });
        expect(p.netMinor + p.feeMinor).toBe(p.grossMinor);
        expect(p.grossMinor).toBe(amount * 100 * 2);
        expect(p.feeMinor).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('rejects bad fee percents and multipliers', () => {
    expect(() => computeWinningsPayout({ amount: 10, feePercent: -1 })).toThrow();
    expect(() => computeWinningsPayout({ amount: 10, feePercent: 101 })).toThrow();
    expect(() => computeWinningsPayout({ amount: 10, feePercent: NaN })).toThrow();
    expect(() => computeWinningsPayout({ amount: 10, feePercent: 1, multiplier: 0 })).toThrow();
    expect(() => computeWinningsPayout({ amount: 10, feePercent: 1, multiplier: 1.5 })).toThrow();
  });

  // Business Config Audit (2026-07-11): payoutMultiplier is admin-configurable.
  // These prove the arithmetic authority honors a non-default multiplier, so an
  // admin changing SystemConfig.payoutMultiplier actually changes what winners get.
  it('honors a configurable payout multiplier (3x, no fee)', () => {
    const p = computeWinningsPayout({ amount: 100, feePercent: 0, multiplier: 3 });
    expect(p.grossMinor).toBe(100 * 100 * 3); // 30000 paise
    expect(p.net).toBe(300);
    expect(p.feeMinor).toBe(0);
  });

  it('multiplier and fee compose; net + fee still equals gross exactly', () => {
    for (const multiplier of [1, 2, 3, 5, 10]) {
      for (const amount of [10, 250, 99990]) {
        for (const pct of [0, 1, 2.5, 33.33, 100]) {
          const p = computeWinningsPayout({ amount, feePercent: pct, multiplier });
          expect(p.grossMinor).toBe(amount * 100 * multiplier);
          expect(p.netMinor + p.feeMinor).toBe(p.grossMinor);
          expect(p.feeMinor).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});
