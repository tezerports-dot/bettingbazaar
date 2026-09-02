// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Merchant inventory eligibility reads the WALLET, and nothing else.
 *
 * These gates decide whether an order may be handed to a merchant. Deciding one
 * from a stored copy of the balance is how an order came to be routed to a
 * merchant with no tokens to serve it: accepted, unfundable, and the player
 * left waiting.
 *
 * The unit correctness below is not incidental. The gates compare against
 * `order.tokenAmount`, which is in RUPEES, and the wallet stores PAISE. A
 * reader that returned paise would make every merchant look a hundred times
 * richer and every gate pass — a failure invisible until inventory runs out.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const pgBalance = vi.hoisted(() => ({ value: 0, calls: [] }));

vi.mock('../../postgres/merchantWalletPg.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getMerchantBalances: async (id) => {
      pgBalance.calls.push(String(id));
      // The committed pockets carry REAL amounts, so a reader that summed the
      // wallet instead of taking `.available` is observable here rather than
      // agreeing by coincidence. Reserved and settlement tokens are promised
      // to orders already in flight; offering them to a new one is how a
      // merchant is assigned work it cannot fund.
      return { available: pgBalance.value, reserved: 7_00, settlement: 3_00 };
    },
  };
});

// The merchant record is stubbed so that a read of `tokenBalance` from it would
// return an OBVIOUSLY WRONG number. Nothing under test may consult it; if
// something starts to, the assertions below go red rather than silently
// agreeing with the wallet by coincidence.
vi.mock('mongoose', () => ({
  default: {
    model: () => ({
      findById: () => ({ lean: async () => ({ _id: 'm1', tokenBalance: 999_999 }) }),
      findOne: async () => ({ _id: 'm1', tokenBalance: 999_999 }),
    }),
  },
}));

const { getMerchantTokenBalance } = await import('../../postgres/merchantWalletPgAuthority.js');

beforeEach(() => {
  pgBalance.value = 0;
  pgBalance.calls.length = 0;
});

describe('the eligibility read comes from the wallet', () => {
  it('always reads the wallet — there is no other source to fall back to', async () => {
    pgBalance.value = 250_00;                       // ₹250 in paise

    expect(await getMerchantTokenBalance('m1')).toBe(250);
    expect(pgBalance.calls).toEqual(['m1']);
  });

  it('never falls back to the merchant record', async () => {
    // The stub above would report 999,999 if anything read it. A gate that
    // consulted the record instead would admit an order no merchant can fund.
    pgBalance.value = 5_00;                          // ₹5
    expect(await getMerchantTokenBalance('m1')).toBe(5);
    expect(await getMerchantTokenBalance('m1')).not.toBe(999_999);
  });

  it('returns rupees, so the comparison against order.tokenAmount is unit-correct', async () => {
    pgBalance.value = 1_00;                          // ₹1

    const balance = await getMerchantTokenBalance('m1');
    expect(balance).toBe(1);
    expect(balance).not.toBe(100);
  });

  it('reports the SPENDABLE pocket, not the wallet total', async () => {
    // available ₹5, reserved ₹7, settlement ₹3. A reader summing the wallet
    // would answer 15 and admit an order funded by money already promised.
    pgBalance.value = 5_00;
    expect(await getMerchantTokenBalance('m1')).toBe(5);
    expect(await getMerchantTokenBalance('m1')).not.toBe(15);
  });

  it('reports zero for a merchant with no wallet row, rather than throwing', async () => {
    // Zero is the safe answer for THIS reader: it refuses the gate and the
    // operator tops up. Note the deliberate difference from
    // `getAvailablePaiseFor`, which OMITS such a merchant instead — assignment
    // needs to tell "never seen" from "empty", because an unknown merchant
    // should not be offered an order at all. Both refuse; they refuse for
    // different reasons and the caller cares which.
    pgBalance.value = 0;
    expect(await getMerchantTokenBalance('unknown')).toBe(0);
  });
});

describe('the assignment routes no longer read the mirror', () => {
  const source = readFileSync(
    new URL('../../domains/merchant/merchant.assignment.routes.js', import.meta.url), 'utf8',
  );

  it('has no direct tokenBalance comparison left in an eligibility gate', () => {
    // The three gates read `merchant.tokenBalance < order.tokenAmount` off the
    // Mongo document. Asserted against the source because the alternative is an
    // integration test per route, and what matters is that no FOURTH gate gets
    // added the old way.
    expect(source).not.toMatch(/\w+\.tokenBalance\s*<\s*order\.tokenAmount/);
  });

  it('routes every gate through the authority reader', () => {
    expect(source).toMatch(/import \{ getMerchantTokenBalance \}/);
    // Three gates: manual assign, manual reassign, queue-manager assign.
    expect([...source.matchAll(/await getMerchantTokenBalance\(/g)]).toHaveLength(3);
  });

  it('still reports the balance it actually gated on', () => {
    // The refusal messages quote the number. Quoting the mirror while gating on
    // Postgres would make an operator chase a discrepancy that is not there.
    expect(source).toMatch(/merchantBalance: balance_pa/);
    expect(source).toMatch(/merchantBalance: balance_pr/);
  });
});
