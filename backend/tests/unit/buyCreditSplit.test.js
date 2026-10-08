// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The one rule for splitting a completed BUY between the player's pockets, and
 * the two ways the three hand-rolled versions of it disagreed.
 *
 * The rule now lives beside the writer that applies it — `wallets.js`'s
 * `buyCreditSplit`, read from the order row the pool spend has LOCKED and
 * applied in that same transaction — because the split and the credit are one
 * fact. `database/tests/depositConservationPg.test.js` drives the real writers
 * and asserts the property that matters: what the pool parts with is what the
 * player receives. This pins the rule ITSELF, including the inputs that made
 * `??`, `||` and no-fallback give three different answers for one order.
 *
 * Paise, as the row stores them: `depositCreditSplit` worked in rupees and was
 * handed an order document read two different ways, which is how one order
 * could get two answers.
 */
import { describe, it, expect } from 'vitest';
import { buyCreditSplit } from '#db/repositories/wallets.js';

describe('buyCreditSplit', () => {
  it('uses the recorded split when it accounts for the whole amount', () => {
    expect(buyCreditSplit({ amountPaise: 100_000, depositAllocationPaise: 90_000, reserveAllocationPaise: 10_000 }))
      .toEqual({ depositPaise: 90_000, reservePaise: 10_000, split: true });
  });

  it('keeps a ZERO deposit share, because a 100% reserve policy is legal', () => {
    // depositPolicy.service.js validates only that the two percentages sum to
    // 100, so reserveAllocationPercent: 100 is configurable and makes the
    // deposit share exactly 0. The `||` reader treated that 0 as absent and
    // substituted the whole token amount — crediting it to deposit AND to
    // reserve, for double the tokens the pool parted with.
    expect(buyCreditSplit({ amountPaise: 100_000, depositAllocationPaise: 0, reserveAllocationPaise: 100_000 }))
      .toEqual({ depositPaise: 0, reservePaise: 100_000, split: true });
  });

  it('keeps a ZERO reserve share too', () => {
    expect(buyCreditSplit({ amountPaise: 100_000, depositAllocationPaise: 100_000, reserveAllocationPaise: 0 }))
      .toEqual({ depositPaise: 100_000, reservePaise: 0, split: true });
  });

  it('falls back to all-deposit for an order predating the split — columns read 0', () => {
    // Where the columns default, they read 0 — not absent. So `?? amount` never
    // fired here, and a site with no fallback credited nothing while the pool
    // was debited in full.
    expect(buyCreditSplit({ amountPaise: 100_000, depositAllocationPaise: 0, reserveAllocationPaise: 0 }))
      .toEqual({ depositPaise: 100_000, reservePaise: 0, split: false });
  });

  it('falls back to all-deposit when the columns are not selected at all', () => {
    // The same order through a SELECT that does not list them has no such
    // fields, so `??` DID fire. One order, two answers, decided by how it was
    // read — which is why the writer now reads the row it locked itself.
    expect(buyCreditSplit({ amountPaise: 100_000 }))
      .toEqual({ depositPaise: 100_000, reservePaise: 0, split: false });
  });

  it('refuses a PARTIAL split rather than crediting part of the deposit', () => {
    // Not a fallback case: an order whose recorded split does not add up is
    // corrupt, and quietly crediting 900 of 1,000 tokens would leave the
    // difference unaccounted for on the path whose whole job is that the books
    // close. All-deposit is the answer that still conserves — and the row
    // itself refuses the state (`order_states_allocation_closes`).
    expect(buyCreditSplit({ amountPaise: 100_000, depositAllocationPaise: 90_000, reserveAllocationPaise: 0 }))
      .toEqual({ depositPaise: 100_000, reservePaise: 0, split: false });
  });

  it('never returns a split that does not sum to the amount', () => {
    const cases = [
      { amountPaise: 100_000, depositAllocationPaise: 90_000, reserveAllocationPaise: 10_000 },
      { amountPaise: 100_000, depositAllocationPaise: 0, reserveAllocationPaise: 100_000 },
      { amountPaise: 100_000, depositAllocationPaise: 0, reserveAllocationPaise: 0 },
      { amountPaise: 100_000 },
      // A negative share and a non-numeric one: both are corrupt rather than
      // absent, and both must land on the answer that still conserves.
      { amountPaise: 100_000, depositAllocationPaise: -500, reserveAllocationPaise: 100_500 },
      { amountPaise: 100_000, depositAllocationPaise: 'ninety thousand', reserveAllocationPaise: 10_000 },
      // Paise are integers; a fractional share cannot be credited.
      { amountPaise: 100_000, depositAllocationPaise: 90_000.5, reserveAllocationPaise: 9_999.5 },
      { amountPaise: 700, depositAllocationPaise: 700, reserveAllocationPaise: 0 },
      { amountPaise: 0 },
    ];
    for (const c of cases) {
      const r = buyCreditSplit(c);
      expect(r.depositPaise + r.reservePaise, JSON.stringify(c)).toBe(Number(c.amountPaise) || 0);
      expect(r.depositPaise).toBeGreaterThanOrEqual(0);
      expect(r.reservePaise).toBeGreaterThanOrEqual(0);
    }
  });

  it('survives an order that carries no amount rather than throwing on a money path', () => {
    expect(buyCreditSplit({})).toEqual({ depositPaise: 0, reservePaise: 0, split: false });
  });
});
