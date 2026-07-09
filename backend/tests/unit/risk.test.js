// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the Risk Platform validators + reserve split (pure, no DB).
import { describe, it, expect } from 'vitest';
import {
  assertPositiveNumber, assertMultipleOf10, validateTokenPurchase,
  validateTokenSale, validateBetAmount, computeReserveSplit, computePayoutFeeMinor,
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
