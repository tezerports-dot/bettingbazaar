// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The order commission's arithmetic (owner, 2026-10-21), pure: a percent of
 * each completed order's tokens in basis points, the admin's two rates with
 * the schema defaults, and the 16 / 84 split that must add up to the payment
 * exactly. The money itself is proven against a real database in
 * teamCommissionPg.
 */
import { describe, it, expect } from 'vitest';
import {
  commissionFor, commissionRates, splitShares, SUPERVISOR_SHARE_PERCENT,
} from '#db/repositories/teamCommission.js';

const total = (shares) => shares.reduce((s, x) => s + x.sharePaise, 0);
const ten = Array.from({ length: 10 }, (_, i) => `m-${i}`);

describe('team commission arithmetic', () => {
  it('is the owner\'s rule: 5% of each deposit, 5% of each withdrawal, 16% of each payment to the supervisor', () => {
    expect(commissionRates({})).toEqual({ depositPercent: 5, withdrawalPercent: 5, bp: { DEPOSIT: 500, WITHDRAWAL: 500 } });
    expect(SUPERVISOR_SHARE_PERCENT).toBe(16);
  });

  it('reads the admin\'s rates, to two decimals, and 0 turns a direction off', () => {
    expect(commissionRates({ orderCommission: { depositPercent: 2.5, withdrawalPercent: 0 } }))
      .toEqual({ depositPercent: 2.5, withdrawalPercent: 0, bp: { DEPOSIT: 250, WITHDRAWAL: 0 } });
    // Out of the spec's range: the schema default, never the stray number.
    expect(commissionRates({ orderCommission: { depositPercent: 90 } }).bp.DEPOSIT).toBe(500);
  });

  it('pays the rate of the order\'s tokens, and nothing at 0', () => {
    expect(commissionFor(5_000_000, 500)).toBe(250_000);
    expect(commissionFor(5_000_000, 0)).toBe(0);
    expect(commissionFor(0, 500)).toBe(0);
  });

  it('rounds down to the paisa, the way the CHECK does', () => {
    expect(commissionFor(1_234_567, 500)).toBe(61_728);
    expect(commissionFor(50_000, 1)).toBe(5);
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
