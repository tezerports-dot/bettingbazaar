// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * How the admin console renders money and counts.
 *
 * These are pure functions an operator reads all day — a wrong currency
 * grouping or a miscounted Cr/L abbreviation is a number they reconcile
 * against and act on. The formatters are Indian-locale specific on purpose
 * (₹, lakh/crore grouping), so the tests assert that specificity rather than
 * a generic thousands separator.
 */
import { describe, it, expect } from 'vitest';
import { formatters } from './formatters';

describe('formatters.currency', () => {
  it('renders rupees with Indian grouping', () => {
    // 12,34,567 — not 1,234,567. The grouping is the whole point of en-IN.
    expect(formatters.currency(1234567)).toBe('₹12,34,567');
  });

  it('treats null, undefined and NaN as ₹0 rather than "₹NaN"', () => {
    // A dashboard tile that shows ₹NaN is worse than one that shows ₹0: it
    // reads as a broken page, and it appears exactly when a figure failed to
    // load.
    expect(formatters.currency(null)).toBe('₹0');
    expect(formatters.currency(undefined)).toBe('₹0');
    expect(formatters.currency(Number('nope'))).toBe('₹0');
  });

  it('keeps at most two decimals and drops trailing zeros', () => {
    expect(formatters.currency(100)).toBe('₹100');
    expect(formatters.currency(99.5)).toBe('₹99.5');
    expect(formatters.currency(99.999)).toBe('₹100');
  });

  it('renders zero as ₹0, not as blank', () => {
    expect(formatters.currency(0)).toBe('₹0');
  });
});

describe('formatters.shortNumber — the dashboard abbreviation', () => {
  it('uses the Indian scale: K, L (lakh), Cr (crore)', () => {
    expect(formatters.shortNumber(999)).toBe('999');
    expect(formatters.shortNumber(1500)).toBe('1.50K');
    expect(formatters.shortNumber(250000)).toBe('2.50L');
    expect(formatters.shortNumber(35000000)).toBe('3.50Cr');
  });

  it('turns over to the next unit exactly at its threshold', () => {
    expect(formatters.shortNumber(1000)).toBe('1.00K');
    expect(formatters.shortNumber(100000)).toBe('1.00L');
    expect(formatters.shortNumber(10000000)).toBe('1.00Cr');
    // Below the lakh threshold it stays in K (99,400 -> 99.40K). Note toFixed
    // rounds, so 99,999 would read 100.00K — expected, not a turnover.
    expect(formatters.shortNumber(99400)).toBe('99.40K');
  });
});

describe('formatters.number — the exact count', () => {
  it('groups the Indian way and never abbreviates', () => {
    // Distinct from shortNumber on purpose: a queue length or member count is
    // reconciled against something and needs the digits.
    expect(formatters.number(100000)).toBe('1,00,000');
    expect(formatters.number(0)).toBe('0');
  });

  it('falls back to 0 on a non-finite value rather than "NaN"', () => {
    expect(formatters.number(null)).toBe('0');
    expect(formatters.number(Number('x'))).toBe('0');
    expect(formatters.number(Infinity)).toBe('0');
  });
});

describe('formatters.phone', () => {
  it('formats a 10-digit number as +91 with a split', () => {
    expect(formatters.phone('9876543210')).toBe('+91 98765-43210');
  });

  it('passes anything that is not ten digits through unchanged', () => {
    // Better to show the raw value than to mangle an already-formatted or
    // partial number.
    expect(formatters.phone('+91 98765-43210')).toBe('+91 98765-43210');
    expect(formatters.phone('123')).toBe('123');
  });
});

describe('formatters.percentage', () => {
  it('always shows two decimals', () => {
    expect(formatters.percentage(12.5)).toBe('12.50%');
    expect(formatters.percentage(0)).toBe('0.00%');
  });
});
