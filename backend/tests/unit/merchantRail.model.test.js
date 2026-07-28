// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Schema-level guarantees for the merchant settlement rail. These run against
// Mongoose's in-memory validation — no database connection is needed.
import { describe, it, expect } from 'vitest';
import { Merchant } from '../../domains/merchant/merchant.model.js';

const TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const build = (fields) => new Merchant({ name: 'Test merchant', ...fields });

describe('Merchant.acceptedCurrencies — exactly one rail', () => {
  it('defaults to the INR rail', () => {
    const merchant = build({});
    expect(merchant.acceptedCurrencies).toEqual(['INR']);
    expect(merchant.merchantType).toBe('INR');
  });

  it('accepts a single INR or USDT rail', () => {
    expect(build({ acceptedCurrencies: ['INR'] }).validateSync()?.errors?.acceptedCurrencies).toBeUndefined();
    expect(build({ acceptedCurrencies: ['USDT'], usdtWalletAddress: TRC20 }).validateSync()).toBeUndefined();
  });

  it('rejects a merchant on both rails at once', () => {
    const error = build({ acceptedCurrencies: ['INR', 'USDT'] }).validateSync();
    expect(error?.errors?.acceptedCurrencies).toBeDefined();
  });

  it('rejects a merchant on no rail at all', () => {
    const error = build({ acceptedCurrencies: [] }).validateSync();
    expect(error?.errors?.acceptedCurrencies).toBeDefined();
  });

  it('exposes the rail as the read-only merchantType virtual', () => {
    expect(build({ acceptedCurrencies: ['USDT'], usdtWalletAddress: TRC20 }).merchantType).toBe('USDT');
  });

  it('includes merchantType when serialised for a panel', () => {
    const merchant = build({ acceptedCurrencies: ['USDT'], usdtWalletAddress: TRC20 });
    expect(merchant.toObject().merchantType).toBe('USDT');
    expect(JSON.parse(JSON.stringify(merchant)).merchantType).toBe('USDT');
  });
});

describe('Merchant.usdtWalletAddress — TRC-20 only', () => {
  it('accepts a well-formed TRC-20 address', () => {
    expect(build({ acceptedCurrencies: ['USDT'], usdtWalletAddress: TRC20 }).validateSync()).toBeUndefined();
  });

  it('rejects an ERC-20 address', () => {
    const error = build({ usdtWalletAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0' }).validateSync();
    expect(error?.errors?.usdtWalletAddress).toBeDefined();
  });

  it('leaves the address unset without complaining — it is configured later', () => {
    expect(build({ acceptedCurrencies: ['USDT'] }).validateSync()).toBeUndefined();
  });

  it('stores the address verbatim — casing is significant in base58', () => {
    // Regression guard: the field once carried `uppercase: true`, which
    // corrupted every address written through it.
    expect(build({ usdtWalletAddress: TRC20 }).usdtWalletAddress).toBe(TRC20);
  });
});
