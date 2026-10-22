// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * What an INR payment reference may look like once normalised (review
 * 2026-10-22): 12 to 22 letters and digits. A look-alike spelling of a spent
 * UTR (an invisible character, full-width digits) must fold into the same
 * reference, and anything that is not a bank UTR (a chain reference, a letter
 * from another alphabet) is refused before the registry is asked.
 */
import { describe, it, expect } from 'vitest';
import { referenceSpecFor } from '../../domains/payment/paymentReference.js';
import { normalizeUtr } from '../../../database/repositories/utr.js';

const inr = referenceSpecFor({ currency: 'INR' });
const ok = (raw) => inr.valid(normalizeUtr(raw));

describe('an INR payment reference', () => {
  it('accepts a bank UTR of 12 to 22 letters and digits, however it is spaced', () => {
    expect(ok('123456789012')).toBe(true);
    expect(ok(' 1234 5678 9012 ')).toBe(true);
    expect(ok('hdfcr52024102212345678')).toBe(true);
  });

  it('folds invisible characters and full-width digits into the same UTR', () => {
    expect(normalizeUtr('123456789012​')).toBe('123456789012');
    expect(normalizeUtr('１２３４５６７８９０１２')).toBe('123456789012');
  });

  it('refuses what is not a UTR', () => {
    expect(ok('12345678901')).toBe(false); // too short
    expect(ok('1'.repeat(23))).toBe(false); // too long
    expect(ok('0xabcdef0123456789:0')).toBe(false); // a chain reference
    expect(ok('12345678901З')).toBe(false); // a Cyrillic letter
    expect(ok('1234-5678-9012')).toBe(false); // punctuation
  });

  it('says what a UTR is when it refuses', () => {
    expect(inr.hint).toMatch(/12 to 22 letters and digits/);
  });
});
