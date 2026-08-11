// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Merchant inventory eligibility reads the AUTHORITATIVE balance, not the mirror.
 *
 * The first increment of moving money-domain READS onto Postgres
 * (docs/MONEY_READS_MIGRATION.md). Writes have been routed for a while; reads
 * were left on the Mongo document, which the reverse mirror keeps current but
 * which is stale by up to a reconcile pass.
 *
 * For most reads that is cosmetic. For these three it is not: they decide
 * whether an order may be handed to a merchant, and the registry says so in as
 * many words — "a stale read can only misroute an order, never move money
 * wrongly". Misrouting an order is the failure, and it is the one worth closing
 * first.
 *
 * ── Why converting a read is safe to do incrementally ───────────────────────
 * Same distinction the Orders work turned on. `getMerchantTokenBalance` asks
 * the resolver and returns the MONGO value while Mongo owns the path, so a
 * converted site behaves identically today and correctly after a flip. Reads
 * are monotonic in a way writes are not: a half-converted read surface is
 * strictly more correct than an unconverted one, because every converted site
 * agrees with whichever store is authoritative.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const authoritative = vi.hoisted(() => ({ value: false }));
const pgBalance = vi.hoisted(() => ({ value: 0, calls: [] }));

vi.mock('../../postgres/moneyAuthority.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isPostgresAuthoritative: () => authoritative.value };
});

vi.mock('../../postgres/merchantWalletPg.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getMerchantBalances: async (id) => {
      pgBalance.calls.push(String(id));
      // `spendable()` reads `.available` — the pocket Merchant.tokenBalance
      // means. Not the total: reporting reserved or owed-out tokens as spendable
      // would tell a merchant they can spend money already committed.
      return { available: pgBalance.value, reserved: 0, settlement: 0 };
    },
  };
});

const mongoDoc = vi.hoisted(() => ({ tokenBalance: 0 }));
vi.mock('mongoose', () => ({
  default: {
    model: () => ({
      findById: () => ({ lean: async () => ({ _id: 'm1', ...mongoDoc }) }),
      findOne: async () => ({ _id: 'm1', ...mongoDoc }),
    }),
  },
}));

const { getMerchantTokenBalance } = await import('../../postgres/merchantWalletPgAuthority.js');

beforeEach(() => {
  authoritative.value = false;
  pgBalance.value = 0;
  pgBalance.calls.length = 0;
  mongoDoc.tokenBalance = 0;
});

describe('the eligibility read follows authority', () => {
  it('does not touch Postgres while MongoDB owns the merchant wallet', async () => {
    await getMerchantTokenBalance('m1');
    expect(pgBalance.calls).toEqual([]);
  });

  it('reads Postgres once the path is flipped', async () => {
    authoritative.value = true;
    pgBalance.value = 250_00;                       // ₹250 in paise

    expect(await getMerchantTokenBalance('m1')).toBe(250);
    expect(pgBalance.calls).toEqual(['m1']);
  });

  it('returns rupees, so the comparison against order.tokenAmount is unit-correct', async () => {
    // The gates compare against `order.tokenAmount`, which is rupees on the
    // Mongo document. A reader returning paise would make every merchant look
    // 100x richer and every gate pass — the exact shape of failure that is
    // invisible until inventory runs out.
    authoritative.value = true;
    pgBalance.value = 1_00;                          // ₹1

    const balance = await getMerchantTokenBalance('m1');
    expect(balance).toBe(1);
    expect(balance).not.toBe(100);
  });

  it('reports zero for a merchant Postgres has never seen, rather than throwing', async () => {
    // An unmirrored merchant must fail the gate, not the request. Zero is the
    // safe answer: it refuses the assignment and the operator tops up.
    authoritative.value = true;
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
