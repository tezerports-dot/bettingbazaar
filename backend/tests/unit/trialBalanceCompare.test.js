// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// compareTrialBalances is the check that decides whether a Postgres cutover may
// proceed, and whether a fallback to MongoDB is safe (DATA_ROLLBACK_PLAN Phase B
// step 3: "the Mongo trial balance equals the PG trial balance"). It is pure, so
// it is tested here rather than behind a database.
import { describe, it, expect } from 'vitest';
import { compareTrialBalances } from '../../postgres/reconcile.js';

const tb = (accounts, { conserves = true } = {}) => ({
  accounts: Object.entries(accounts).map(([account, total_paise]) => ({
    account, total_paise: String(total_paise),
  })),
  grandTotalPaise: String(Object.values(accounts).reduce((s, v) => s + BigInt(v), 0n)),
  conservesToZero: conserves,
});

describe('compareTrialBalances', () => {
  it('agrees when both ledgers hold identical per-account totals', () => {
    const a = tb({ USER_FUNDS: -50000, PLATFORM_REVENUE: 50000 });
    expect(compareTrialBalances(a, tb({ USER_FUNDS: -50000, PLATFORM_REVENUE: 50000 })).agree).toBe(true);
  });

  it('agrees on two empty ledgers', () => {
    expect(compareTrialBalances(tb({}), tb({})).agree).toBe(true);
  });

  it('catches a per-account disagreement even when BOTH ledgers conserve to zero', () => {
    // The case a "does everything sum to zero?" check cannot see: both sides
    // balance, but they disagree about which account holds the money.
    const mongo = tb({ USER_FUNDS: -50000, PLATFORM_REVENUE: 50000 });
    const pg    = tb({ USER_FUNDS: -50000, PAYOUT_FEES: 50000 });
    const result = compareTrialBalances(mongo, pg);

    expect(result.agree).toBe(false);
    expect(result.differences).toEqual([
      { account: 'PAYOUT_FEES', mongoPaise: '0', pgPaise: '50000' },
      { account: 'PLATFORM_REVENUE', mongoPaise: '50000', pgPaise: '0' },
    ]);
  });

  it('reports an account present in only one store', () => {
    const result = compareTrialBalances(
      tb({ USER_FUNDS: -100 }),
      tb({ USER_FUNDS: -100, MERCHANT_FUNDS: 0 }),
    );
    // A zero-valued account on one side only is still equal in value.
    expect(result.differences).toEqual([]);
    expect(result.agree).toBe(true);
  });

  it('refuses to agree when a ledger does not conserve to zero, even if both sides match', () => {
    // Identical totals on both sides, but the books do not balance — that is a
    // broken ledger, not a healthy cutover gate.
    const broken = tb({ USER_FUNDS: -50000 }, { conserves: false });
    const result = compareTrialBalances(broken, tb({ USER_FUNDS: -50000 }, { conserves: false }));
    expect(result.differences).toEqual([]);
    expect(result.agree).toBe(false);
  });

  it('compares exactly at values beyond double precision', () => {
    // Paise totals are summed as BigInt end to end; a platform that has moved
    // enough money to exceed 2^53 paise must still reconcile exactly.
    const huge = '9007199254740993';      // 2^53 + 1
    const off  = '9007199254740994';
    expect(compareTrialBalances(
      tb({ USER_FUNDS: huge }), tb({ USER_FUNDS: huge }),
    ).differences).toEqual([]);

    expect(compareTrialBalances(
      tb({ USER_FUNDS: huge }), tb({ USER_FUNDS: off }),
    ).differences).toEqual([
      { account: 'USER_FUNDS', mongoPaise: huge, pgPaise: off },
    ]);
  });

  it('sorts differences by account so two runs produce comparable output', () => {
    const result = compareTrialBalances(
      tb({ ZED: 1, ALPHA: 2 }),
      tb({ ZED: 9, ALPHA: 9 }),
    );
    expect(result.differences.map((d) => d.account)).toEqual(['ALPHA', 'ZED']);
  });
});
