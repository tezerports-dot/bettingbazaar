// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the merchant settlement-rail vocabulary: a merchant is INR-only
// or USDT-only, and a USDT merchant's payout address must be a real TRC-20 one.
import { describe, it, expect } from 'vitest';
import {
  MERCHANT_CURRENCY,
  MERCHANT_CURRENCIES,
  isTrc20Address,
  merchantTypeOf,
  isUsdtMerchant,
  isInrMerchant,
} from '../../domains/merchant/merchantCurrency.js';

// Real-shape TRC-20 addresses: 34 base58 chars beginning with 'T'.
const TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRC20_ALT = 'TXk9pF2mR8vQ7dN3cL5bX8fH2jK4mP9qRt';

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

describe('isTrc20Address', () => {
  it('accepts well-formed TRC-20 addresses', () => {
    expect(isTrc20Address(TRC20)).toBe(true);
    expect(isTrc20Address(TRC20_ALT)).toBe(true);
    expect(isTrc20Address(`  ${TRC20}  `)).toBe(true); // trimmed before checking
  });

  it('rejects an ERC-20 address — the most likely wrong paste', () => {
    expect(isTrc20Address('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0')).toBe(false);
  });

  it('rejects wrong lengths and a missing T prefix', () => {
    expect(isTrc20Address(TRC20.slice(0, 33))).toBe(false);
    expect(isTrc20Address(`${TRC20}X`)).toBe(false);
    expect(isTrc20Address(`A${TRC20.slice(1)}`)).toBe(false);
  });

  it('rejects the base58-ambiguous characters 0, O, I and l', () => {
    for (const bad of ['0', 'O', 'I', 'l']) {
      expect(isTrc20Address(`T${bad}${TRC20.slice(2)}`)).toBe(false);
    }
  });

  it('rejects empty and non-string input instead of throwing', () => {
    expect(isTrc20Address('')).toBe(false);
    expect(isTrc20Address(undefined)).toBe(false);
    expect(isTrc20Address(null)).toBe(false);
    expect(isTrc20Address(12345)).toBe(false);
  });

  it('is case-sensitive — uppercasing a valid address invalidates it', () => {
    // Regression guard: Merchant.usdtWalletAddress used to carry `uppercase: true`,
    // which silently corrupted every stored address (base58 is case-sensitive).
    expect(isTrc20Address(TRC20.toUpperCase())).toBe(false);
  });
});
