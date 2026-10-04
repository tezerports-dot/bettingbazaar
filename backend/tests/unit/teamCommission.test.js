// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The team commission's arithmetic (Step 2e), pure: 10% of each rise above
 * the mark, and the 16 / 84 split that must add up to the payment exactly.
 * The money itself is proven against a real database in teamCommissionPg.
 */
import { describe, it, expect } from 'vitest';
import {
  commissionFor, splitShares, COMMISSION_PERCENT, SUPERVISOR_SHARE_PERCENT,
} from '#db/repositories/teamCommission.js';

const total = (shares) => shares.reduce((s, x) => s + x.sharePaise, 0);
const ten = Array.from({ length: 10 }, (_, i) => `m-${i}`);

describe('team commission arithmetic', () => {
  it('is the owner\'s rule: 10% of each rise, 16% of each payment to the supervisor', () => {
    expect(COMMISSION_PERCENT).toBe(10);
    expect(SUPERVISOR_SHARE_PERCENT).toBe(16);
  });

  it('pays 10% of the rise above the mark, and nothing without a rise', () => {
    expect(commissionFor(5_000_000, 0)).toBe(500_000);
    expect(commissionFor(10_000_000, 5_000_000)).toBe(500_000);
    expect(commissionFor(5_000_000, 5_000_000)).toBe(0);
    // Volume that fell below the mark is never clawed back.
    expect(commissionFor(4_000_000, 5_000_000)).toBe(0);
  });

  it('rounds down to the paisa, the way the CHECK does', () => {
    expect(commissionFor(1_234_567, 0)).toBe(123_456);
    expect(commissionFor(9, 0)).toBe(0);
  });

  it('splits a payment 16 / 84 among ten members, exactly', () => {
    const shares = splitShares(500_000, 'sup', ten);
    expect(shares[0]).toEqual({ merchantId: 'sup', role: 'SUPERVISOR', sharePaise: 80_000 });
    expect(shares.slice(1).every((s) => s.role === 'MEMBER' && s.sharePaise === 42_000)).toBe(true);
    expect(total(shares)).toBe(500_000);
  });

  it('gives the paise that do not divide one each to the first members, so the record adds up', () => {
    // 1,004: the supervisor's 16% is 160; 844 among three is 281 each and 1 over.
    const shares = splitShares(1_004, 'sup', ['m-b', 'm-a', 'm-c']);
    expect(shares.map((s) => [s.merchantId, s.sharePaise])).toEqual([
      ['sup', 160], ['m-a', 282], ['m-b', 281], ['m-c', 281],
    ]);
    expect(total(shares)).toBe(1_004);
  });

  it('records it all to the supervisor when no approved member is left', () => {
    expect(splitShares(5_000, 'sup', [])).toEqual([{ merchantId: 'sup', role: 'SUPERVISOR', sharePaise: 5_000 }]);
  });

  it('never records the supervisor twice, even if listed as a member', () => {
    const shares = splitShares(1_000, 'sup', ['sup', 'm-1']);
    expect(shares.map((s) => s.merchantId)).toEqual(['sup', 'm-1']);
    expect(total(shares)).toBe(1_000);
  });
});
