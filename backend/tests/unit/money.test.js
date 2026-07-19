// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the Integer Money Engine (capability #9): integer enforcement,
// overflow protection, and value-conserving arithmetic.
import { describe, it, expect } from 'vitest';
import {
  MAX_SAFE_PAISE, assertSafePaise, rupeesToPaise, paiseToRupees,
  addPaise, subPaise, mulPaise, percentOfPaise, formatRupees,
} from '../../shared/money.js';

describe('rupeesToPaise / paiseToRupees', () => {
  it('converts without float dust', () => {
    expect(rupeesToPaise(99.99)).toBe(9999);
    expect(rupeesToPaise(0.1)).toBe(10);
    expect(rupeesToPaise(0.07)).toBe(7);      // classic 0.1+0.2 float trap avoided at the boundary
    expect(rupeesToPaise(10)).toBe(1000);
  });
  it('round-trips display values', () => {
    expect(paiseToRupees(9999)).toBe(99.99);
    expect(formatRupees(9999)).toBe('99.99');
    expect(formatRupees(5)).toBe('0.05');
  });
  it('rejects non-finite rupees', () => {
    expect(() => rupeesToPaise(Infinity)).toThrow();
    expect(() => rupeesToPaise(NaN)).toThrow();
    expect(() => rupeesToPaise('10')).toThrow();
  });
});

describe('assertSafePaise (invariants)', () => {
  it('accepts safe integers', () => {
    expect(assertSafePaise(0)).toBe(0);
    expect(assertSafePaise(-500)).toBe(-500);
    expect(assertSafePaise(MAX_SAFE_PAISE)).toBe(MAX_SAFE_PAISE);
  });
  it('rejects fractional paise', () => {
    expect(() => assertSafePaise(10.5)).toThrow(/integer/);
  });
  it('rejects NaN / Infinity / non-number', () => {
    expect(() => assertSafePaise(NaN)).toThrow();
    expect(() => assertSafePaise(Infinity)).toThrow();
    expect(() => assertSafePaise('5')).toThrow();
  });
  it('rejects values beyond MAX_SAFE_PAISE (overflow protection)', () => {
    expect(() => assertSafePaise(MAX_SAFE_PAISE + 1)).toThrow(/overflow|exceeds/i);
  });
});

describe('arithmetic conserves value and guards overflow', () => {
  it('addPaise sums and checks each step', () => {
    expect(addPaise(100, 200, 300)).toBe(600);
    expect(addPaise()).toBe(0);
  });
  it('subPaise', () => {
    expect(subPaise(1000, 300)).toBe(700);
    expect(subPaise(300, 1000)).toBe(-700);
  });
  it('add then sub is identity (conservation)', () => {
    const bal = 50000, debit = 12345;
    expect(addPaise(subPaise(bal, debit), debit)).toBe(bal);
  });
  it('mulPaise requires an integer factor', () => {
    expect(mulPaise(1000, 2)).toBe(2000);
    expect(() => mulPaise(1000, 1.5)).toThrow();
  });
  it('overflow throws instead of wrapping', () => {
    expect(() => addPaise(MAX_SAFE_PAISE, 1)).toThrow(/overflow|exceeds/i);
    expect(() => mulPaise(MAX_SAFE_PAISE, 2)).toThrow(/overflow|exceeds/i);
  });
});

describe('percentOfPaise floors (never rounds up against the user)', () => {
  it('floors a 1% fee', () => {
    expect(percentOfPaise(1000, 1)).toBe(10);        // ₹10 → 10 paise
    expect(percentOfPaise(1999, 1)).toBe(19);        // 19.99 → floor 19, not 20
    expect(percentOfPaise(1000, 1.5)).toBe(15);
  });
  it('net + fee never exceeds gross', () => {
    const gross = 987654;
    const fee = percentOfPaise(gross, 1);
    const net = subPaise(gross, fee);
    expect(addPaise(net, fee)).toBe(gross); // exact conservation
  });
});
