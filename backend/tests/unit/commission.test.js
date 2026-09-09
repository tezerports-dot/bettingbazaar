// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * The pure half of the merchant commission engine: what one variety earns on
 * newly matched volume, which variety a key names, and which rate a variety
 * resolves to.
 *
 * The impure half — that the money actually moves, once — is proven against a
 * real database in database/tests/merchantCommissionPg.test.js. A suite that
 * mocked the issuance boundary and asserted on its arguments once reported
 * settlement working while the real function threw on every call.
 */
import { describe, it, expect } from 'vitest';
import {
  computeCommissionMinor, varietyKey, rateFor,
} from '../../domains/merchant/merchantCommission.service.js';

const rate = (over = {}) => ({
  currency: 'INR', paymentMode: 'P2P_UPI', denominationPaise: null,
  buyPercent: 1, sellPercent: 2, ...over,
});

describe('computeCommissionMinor', () => {
  it('pays the two legs added, on newly matched volume only', () => {
    const r = computeCommissionMinor({
      matchedMinor: 1_500_000, lastPaidMatchedMinor: 1_000_000,
      buyPercent: 2, sellPercent: 3, minMatchedVolumeMinor: 0,
    });
    expect(r.newMatchedMinor).toBe(500_000);
    // 5% of the NEW 500,000 — not of the 1,500,000 cumulative.
    expect(r.commissionMinor).toBe(25_000);
  });

  it('adds the legs rather than taking the larger or their product', () => {
    const { commissionMinor } = computeCommissionMinor({
      matchedMinor: 1_000_000, lastPaidMatchedMinor: 0,
      buyPercent: 4, sellPercent: 6, minMatchedVolumeMinor: 0,
    });
    expect(commissionMinor).toBe(100_000); // 10% — not 6% (larger), not 0.24% (product)
  });

  it('pays nothing below the minimum matched volume', () => {
    const r = computeCommissionMinor({
      matchedMinor: 1_005_000, lastPaidMatchedMinor: 1_000_000,
      buyPercent: 5, sellPercent: 0, minMatchedVolumeMinor: 10_000,
    });
    expect(r.newMatchedMinor).toBe(5_000);
    expect(r.commissionMinor).toBe(0);
  });

  it('pays nothing when the mark already covers the matched volume', () => {
    const r = computeCommissionMinor({
      matchedMinor: 1_000_000, lastPaidMatchedMinor: 1_000_000,
      buyPercent: 5, sellPercent: 5, minMatchedVolumeMinor: 0,
    });
    expect(r.commissionMinor).toBe(0);
  });

  /**
   * A mark ABOVE the matched volume is not an error to clamp away — it means a
   * repair or a replay paid ahead of what the orders now show. The engine must
   * pay nothing rather than a negative amount, which would be a debit dressed
   * as a commission.
   */
  it('never returns a negative commission when the mark is ahead', () => {
    const r = computeCommissionMinor({
      matchedMinor: 900_000, lastPaidMatchedMinor: 1_000_000,
      buyPercent: 5, sellPercent: 5, minMatchedVolumeMinor: 0,
    });
    expect(r.newMatchedMinor).toBe(0);
    expect(r.commissionMinor).toBe(0);
  });

  it('floors, so rounding can never over-draw the pool', () => {
    const { commissionMinor } = computeCommissionMinor({
      matchedMinor: 3_333, lastPaidMatchedMinor: 0,
      buyPercent: 1, sellPercent: 2, minMatchedVolumeMinor: 0,
    });
    expect(commissionMinor).toBe(99); // 99.99 floored
  });

  it('refuses a non-integer volume rather than paying a fraction of a paise', () => {
    expect(() => computeCommissionMinor({
      matchedMinor: 10.5, lastPaidMatchedMinor: 0,
      buyPercent: 5, sellPercent: 0, minMatchedVolumeMinor: 0,
    })).toThrow();
  });
});

describe('varietyKey', () => {
  it('names all three axes', () => {
    expect(varietyKey({ currency: 'INR', paymentMode: 'CASH_ATM', denominationPaise: 50_000 }))
      .toBe('INR:CASH_ATM:50000');
  });

  it('spells an absent denomination one way only', () => {
    // Two spellings of the same variety would be two high-water marks, and the
    // volume under the abandoned one would be paid a second time.
    const fromNull = varietyKey({ currency: 'INR', paymentMode: 'P2P_UPI', denominationPaise: null });
    const fromUndefined = varietyKey({ currency: 'INR', paymentMode: 'P2P_UPI' });
    expect(fromNull).toBe('INR:P2P_UPI:none');
    expect(fromUndefined).toBe(fromNull);
  });

  it('distinguishes the same denomination on different rails', () => {
    expect(varietyKey({ currency: 'INR', paymentMode: 'CASH_ATM', denominationPaise: 5_000_000 }))
      .not.toBe(varietyKey({ currency: 'USDT', paymentMode: 'CASH_ATM', denominationPaise: 5_000_000 }));
  });
});

describe('rateFor', () => {
  const policy = {
    rates: [
      rate({ currency: 'INR', paymentMode: 'P2P_UPI', denominationPaise: null, buyPercent: 1, sellPercent: 1 }),
      rate({ currency: 'INR', paymentMode: 'CASH_ATM', denominationPaise: 50_000, buyPercent: 2, sellPercent: 2 }),
      rate({ currency: 'USDT', paymentMode: 'P2P_UPI', denominationPaise: 5_000_000, buyPercent: 3, sellPercent: 3 }),
    ],
  };

  it('matches on all three axes', () => {
    expect(rateFor(policy, { currency: 'INR', paymentMode: 'CASH_ATM', denominationPaise: 50_000 }).buyPercent).toBe(2);
    expect(rateFor(policy, { currency: 'USDT', paymentMode: 'P2P_UPI', denominationPaise: 5_000_000 }).buyPercent).toBe(3);
  });

  /**
   * The absence of a nearest-match rule is the point: paying the ₹500 rate for
   * ₹10,000 of work would be a rate an admin never set, applied to money, and
   * invisible in every panel.
   */
  it('returns null for a denomination the policy does not price', () => {
    expect(rateFor(policy, { currency: 'INR', paymentMode: 'CASH_ATM', denominationPaise: 1_000_000 })).toBeNull();
  });

  it('returns null for an unpriced rail rather than falling back to another', () => {
    expect(rateFor(policy, { currency: 'USDT', paymentMode: 'CASH_ATM', denominationPaise: 5_000_000 })).toBeNull();
  });

  it('does not match a denominated rate against a range variety', () => {
    expect(rateFor(policy, { currency: 'USDT', paymentMode: 'P2P_UPI', denominationPaise: null })).toBeNull();
  });

  it('matches the range rate only when the variety has no denomination', () => {
    expect(rateFor(policy, { currency: 'INR', paymentMode: 'P2P_UPI', denominationPaise: null }).buyPercent).toBe(1);
    expect(rateFor(policy, { currency: 'INR', paymentMode: 'P2P_UPI', denominationPaise: 50_000 })).toBeNull();
  });

  it('is null against a policy with no rates at all', () => {
    expect(rateFor({ rates: [] }, { currency: 'INR', paymentMode: 'P2P_UPI', denominationPaise: null })).toBeNull();
    expect(rateFor(null, { currency: 'INR', paymentMode: 'P2P_UPI', denominationPaise: null })).toBeNull();
  });
});
