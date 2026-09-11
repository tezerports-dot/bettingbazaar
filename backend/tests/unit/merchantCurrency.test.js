// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// Unit tests for the merchant settlement-rail vocabulary: a merchant is INR-only
// or USDT-only, and a USDT merchant's payout address must be a real TRC-20 one.
import { describe, it, expect } from 'vitest';
import {
  MERCHANT_CURRENCY,
  MERCHANT_CURRENCIES,
  isUsdtAddress,
  isUsdtTxHash,
  usdtAddressFor,
  usdtChainsHeldBy,
  merchantTypeOf,
  isUsdtMerchant,
  isInrMerchant,
} from '../../domains/merchant/merchantCurrency.js';

// Real-shape TRC-20 addresses: 34 base58 chars beginning with 'T'.
const TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRC20_ALT = 'TXk9pF2mR8vQ7dN3cL5bX8fH2jK4mP9qRt';
// A BEP-20 address: the ordinary EVM 20-byte hex form, mixed case (EIP-55).
const BEP20 = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0';

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

describe('isUsdtAddress', () => {
  // The two chains, and the point of having two: an address valid on one is
  // meaningless on the other, and sending across that boundary loses the money.
  it('accepts a well-formed address on its OWN chain', () => {
    expect(isUsdtAddress('TRC20', TRC20)).toBe(true);
    expect(isUsdtAddress('TRC20', TRC20_ALT)).toBe(true);
    expect(isUsdtAddress('TRC20', `  ${TRC20}  `)).toBe(true); // trimmed before checking
    expect(isUsdtAddress('BEP20', BEP20)).toBe(true);
    expect(isUsdtAddress('BEP20', `  ${BEP20}  `)).toBe(true);
  });

  it('REFUSES an address from the other chain — the whole reason for two fields', () => {
    // The most likely wrong paste, in both directions. A BEP-20 address stored
    // as Tron would be shown to a player who then sends on Tron to an address
    // that does not exist there.
    expect(isUsdtAddress('TRC20', BEP20)).toBe(false);
    expect(isUsdtAddress('BEP20', TRC20)).toBe(false);
  });

  it('rejects wrong lengths and a missing prefix', () => {
    expect(isUsdtAddress('TRC20', TRC20.slice(0, 33))).toBe(false);
    expect(isUsdtAddress('TRC20', `${TRC20}X`)).toBe(false);
    expect(isUsdtAddress('TRC20', `A${TRC20.slice(1)}`)).toBe(false);
    expect(isUsdtAddress('BEP20', BEP20.slice(0, 41))).toBe(false);
    expect(isUsdtAddress('BEP20', `${BEP20}a`)).toBe(false);
    expect(isUsdtAddress('BEP20', BEP20.slice(2))).toBe(false);
  });

  it('rejects the base58-ambiguous characters 0, O, I and l on Tron', () => {
    for (const bad of ['0', 'O', 'I', 'l']) {
      expect(isUsdtAddress('TRC20', `T${bad}${TRC20.slice(2)}`)).toBe(false);
    }
  });

  it('rejects empty, non-string and unknown-chain input instead of throwing', () => {
    expect(isUsdtAddress('TRC20', '')).toBe(false);
    expect(isUsdtAddress('TRC20', undefined)).toBe(false);
    expect(isUsdtAddress('TRC20', null)).toBe(false);
    expect(isUsdtAddress('TRC20', 12345)).toBe(false);
    expect(isUsdtAddress('SOLANA', TRC20)).toBe(false);
    expect(isUsdtAddress(undefined, TRC20)).toBe(false);
  });

  it('is case-sensitive on Tron and case-INSENSITIVE on BNB', () => {
    // Base58 is case-sensitive: `usdt_wallet_address` used to be stored
    // uppercased, which silently corrupted every address on it.
    expect(isUsdtAddress('TRC20', TRC20.toUpperCase())).toBe(false);
    // EIP-55 mixed case is a CHECKSUM, not part of the address. Refusing a
    // lower-case one would reject the form most wallets copy.
    expect(isUsdtAddress('BEP20', BEP20.toLowerCase())).toBe(true);
    expect(isUsdtAddress('BEP20', BEP20.toUpperCase().replace('0X', '0x'))).toBe(true);
  });
});

describe('isUsdtTxHash', () => {
  it('accepts each chain’s own hash shape', () => {
    expect(isUsdtTxHash('TRC20', 'a'.repeat(64))).toBe(true);
    expect(isUsdtTxHash('BEP20', `0x${'a'.repeat(64)}`)).toBe(true);
  });

  it('REFUSES the other chain’s shape', () => {
    // A player who pastes a Tron hash into a BEP-20 order has submitted proof
    // of a payment on a network the merchant is not watching.
    expect(isUsdtTxHash('TRC20', `0x${'a'.repeat(64)}`)).toBe(false);
    expect(isUsdtTxHash('BEP20', 'a'.repeat(64))).toBe(false);
  });

  it('rejects wrong lengths, non-hex and unknown chains', () => {
    expect(isUsdtTxHash('TRC20', 'a'.repeat(63))).toBe(false);
    expect(isUsdtTxHash('TRC20', 'z'.repeat(64))).toBe(false);
    expect(isUsdtTxHash('SOLANA', 'a'.repeat(64))).toBe(false);
    expect(isUsdtTxHash('TRC20', null)).toBe(false);
  });
});

describe('usdtAddressFor / usdtChainsHeldBy', () => {
  const both  = { usdtAddressTrc20: TRC20, usdtAddressBep20: BEP20 };
  const tron  = { usdtAddressTrc20: TRC20, usdtAddressBep20: null };
  const none  = { usdtAddressTrc20: null,  usdtAddressBep20: '   ' };

  it('returns the address for the chain asked for, and only that one', () => {
    expect(usdtAddressFor(both, 'TRC20')).toBe(TRC20);
    expect(usdtAddressFor(both, 'BEP20')).toBe(BEP20);
    // The whole point: a merchant holding only Tron has nothing to receive a
    // BEP-20 payment with, and says so rather than returning the wrong one.
    expect(usdtAddressFor(tron, 'BEP20')).toBeNull();
    expect(usdtAddressFor(tron, 'SOLANA')).toBeNull();
    expect(usdtAddressFor(null, 'TRC20')).toBeNull();
  });

  it('treats a blank address as no address, not as an empty one', () => {
    // A blank string would pass a truthiness check somewhere downstream and be
    // rendered as a payment destination.
    expect(usdtAddressFor(none, 'BEP20')).toBeNull();
    expect(usdtChainsHeldBy(none)).toEqual([]);
  });

  it('lists every chain a merchant can actually be paid on', () => {
    expect(usdtChainsHeldBy(both)).toEqual(['TRC20', 'BEP20']);
    expect(usdtChainsHeldBy(tron)).toEqual(['TRC20']);
  });
});
