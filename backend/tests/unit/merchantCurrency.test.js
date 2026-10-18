// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// Unit tests for the merchant settlement-rail vocabulary: a merchant is INR-only
// or USDT-only, and USDT is paid on one chain, to the platform.
import { describe, it, expect } from 'vitest';
import {
  MERCHANT_CURRENCY,
  MERCHANT_CURRENCIES,
  SETTABLE_MERCHANT_CURRENCIES,
  USDT_CHAINS,
  USDT_CHAIN_SPEC,
  isUsdtChain,
  merchantTypeOf,
  isUsdtMerchant,
  isInrMerchant,
} from '../../domains/merchant/merchantCurrency.js';

describe('MERCHANT_CURRENCIES', () => {
  it('names exactly the two supported rails', () => {
    expect(MERCHANT_CURRENCIES).toEqual(['INR', 'USDT']);
  });

  it('is frozen so no caller can extend the rail list at runtime', () => {
    expect(Object.isFrozen(MERCHANT_CURRENCIES)).toBe(true);
    expect(Object.isFrozen(MERCHANT_CURRENCY)).toBe(true);
  });
});

describe('merchantTypeOf', () => {
  it('reads the single rail from acceptedCurrencies', () => {
    expect(merchantTypeOf({ acceptedCurrencies: ['USDT'] })).toBe('USDT');
    expect(merchantTypeOf({ acceptedCurrencies: ['INR'] })).toBe('INR');
  });

  it('falls back to INR for legacy documents with no rail set', () => {
    // schema default: acceptedCurrencies = ['INR']
    expect(merchantTypeOf({})).toBe('INR');
    expect(merchantTypeOf(null)).toBe('INR');
    expect(merchantTypeOf({ acceptedCurrencies: [] })).toBe('INR');
  });

  it('ignores an unrecognised rail rather than propagating it', () => {
    expect(merchantTypeOf({ acceptedCurrencies: ['EUR'] })).toBe('INR');
  });

  it('backs the isUsdtMerchant / isInrMerchant guards', () => {
    const usdt = { acceptedCurrencies: ['USDT'] };
    const inr = { acceptedCurrencies: ['INR'] };
    expect(isUsdtMerchant(usdt)).toBe(true);
    expect(isInrMerchant(usdt)).toBe(false);
    expect(isUsdtMerchant(inr)).toBe(false);
    expect(isInrMerchant(inr)).toBe(true);
  });
});

describe('the USDT chain', () => {
  it('is BNB Smart Chain alone: USDT buys are paid to the platform there (owner, 2026-10-18)', () => {
    expect(USDT_CHAINS).toEqual(['BEP20']);
    expect(isUsdtChain('BEP20')).toBe(true);
    expect(isUsdtChain('TRC20')).toBe(false);
    expect(USDT_CHAIN_SPEC.BEP20.label).toMatch(/BNB Smart Chain/);
  });

  it('lets an admin put a merchant on INR only', () => {
    expect(SETTABLE_MERCHANT_CURRENCIES).toEqual(['INR']);
  });
});
