// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The one rule for splitting a confirmed deposit, and the two ways the three
 * hand-rolled versions of it disagreed.
 *
 * `depositCreditConservation.test.js` drives the route and asserts the property
 * that matters — debited equals credited. This pins the rule itself, including
 * the inputs that made `??`, `||` and no-fallback give three different answers
 * for the same order.
 */
import { describe, it, expect } from 'vitest';
import { depositCreditSplit } from '../../domains/payment/depositCredit.js';

describe('depositCreditSplit', () => {
  it('uses the recorded split when it accounts for the whole amount', () => {
    expect(depositCreditSplit({ tokenAmount: 1000, depositAllocation: 900, reserveAllocation: 100 }))
      .toEqual({ depositCredit: 900, reserveCredit: 100, total: 1000, split: true });
  });

  it('keeps a ZERO deposit share, because a 100% reserve policy is legal', () => {
    // depositPolicy.service.js validates only that the two percentages sum to
    // 100, so reserveAllocationPercent: 100 is configurable and makes the
    // deposit share exactly 0. The `||` reader treated that 0 as absent and
    // substituted the whole token amount — crediting it to deposit AND to
    // reserve, for double the tokens the merchant parted with.
    expect(depositCreditSplit({ tokenAmount: 1000, depositAllocation: 0, reserveAllocation: 1000 }))
      .toEqual({ depositCredit: 0, reserveCredit: 1000, total: 1000, split: true });
  });

  it('keeps a ZERO reserve share too', () => {
    expect(depositCreditSplit({ tokenAmount: 1000, depositAllocation: 1000, reserveAllocation: 0 }))
      .toEqual({ depositCredit: 1000, reserveCredit: 0, total: 1000, split: true });
  });

  it('falls back to all-deposit for an order predating the split — read HYDRATED', () => {
    // A Mongoose document applies the schema default, so the fields read 0 —
    // not undefined. `?? tokenAmount` therefore never fired here, and a site
    // with no fallback credited nothing while the merchant was debited in full.
    expect(depositCreditSplit({ tokenAmount: 1000, depositAllocation: 0, reserveAllocation: 0 }))
      .toEqual({ depositCredit: 1000, reserveCredit: 0, total: 1000, split: false });
  });

  it('falls back to all-deposit for the same order read LEAN', () => {
    // The same document through `.lean()` has no such fields at all, so `??`
    // DID fire. One order, two answers, decided by how it was fetched.
    expect(depositCreditSplit({ tokenAmount: 1000 }))
      .toEqual({ depositCredit: 1000, reserveCredit: 0, total: 1000, split: false });
  });

  it('refuses a PARTIAL split rather than crediting part of the deposit', () => {
    // Not a fallback case: an order whose recorded split does not add up is
    // corrupt, and quietly crediting 900 of 1000 would leave the difference
    // unaccounted for on the path whose whole job is that the books close.
    // All-deposit is the answer that still conserves.
    expect(depositCreditSplit({ tokenAmount: 1000, depositAllocation: 900, reserveAllocation: 0 }))
      .toMatchObject({ depositCredit: 1000, reserveCredit: 0, split: false });
  });

  it('never returns a split that does not sum to the total', () => {
    const cases = [
      { tokenAmount: 1000, depositAllocation: 900, reserveAllocation: 100 },
      { tokenAmount: 1000, depositAllocation: 0, reserveAllocation: 1000 },
      { tokenAmount: 1000, depositAllocation: 0, reserveAllocation: 0 },
      { tokenAmount: 1000 },
      { tokenAmount: 1000, depositAllocation: -5, reserveAllocation: 1005 },
      { tokenAmount: 1000, depositAllocation: 'nine hundred', reserveAllocation: 100 },
      { tokenAmount: 7, depositAllocation: 7, reserveAllocation: 0 },
      { tokenAmount: 0 },
    ];
    for (const c of cases) {
      const r = depositCreditSplit(c);
      expect(r.depositCredit + r.reserveCredit).toBe(r.total);
      expect(r.total).toBe(Number(c.tokenAmount) || 0);
      expect(r.depositCredit).toBeGreaterThanOrEqual(0);
      expect(r.reserveCredit).toBeGreaterThanOrEqual(0);
    }
  });

  it('survives a missing order rather than throwing on a money path', () => {
    expect(depositCreditSplit(undefined)).toEqual({ depositCredit: 0, reserveCredit: 0, total: 0, split: false });
  });
});
