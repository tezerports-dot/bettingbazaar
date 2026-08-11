// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * reconcileCasinoRounds against a REAL PostgreSQL, with the Mongo side stubbed.
 *
 * Domain 9's cross-store check. The comparison is per ROUND on the three
 * running totals rather than per transaction, because it is the totals the
 * refund bound is enforced against — a transaction-count check would pass while
 * a round had given back more than it took.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

/** The Mongo side as a table this test controls. */
let gameTransactions = [];
vi.mock('mongoose', () => ({
  default: {
    model: (name) => {
      if (name !== 'GameTransaction') throw new Error(`unexpected model(${name})`);
      return {
        find: ({ roundId: { $in: ids } }) => ({
          select: () => ({ lean: async () => gameTransactions.filter((t) => ids.includes(t.roundId)) }),
        }),
        updateOne: async () => ({ acknowledged: true }),
      };
    },
  },
}));

import { pgConfigured, pgQuery, applySchema, closePg } from '../../postgres/pgClient.js';
import { reconcileCasinoRounds } from '../../postgres/reconcile.js';

if (process.env.CI && !pgConfigured()) {
  throw new Error('casinoReconcile.test.js: DATABASE_URL is unset in CI — this suite must not skip silently.');
}
const describePg = pgConfigured() ? describe : describe.skip;

/** A round in Postgres with the given totals, in rupees. */
async function pgRound(roundId, { debited = 0, credited = 0, refunded = 0 } = {}) {
  await pgQuery(
    `INSERT INTO casino_rounds (round_id, user_id, provider_key, game_id, debited_paise, credited_paise, refunded_paise)
     VALUES ($1,'u1','acme','slots',$2,$3,$4)`,
    [roundId, debited * 100, credited * 100, refunded * 100],
  );
}

describePg('reconcileCasinoRounds (real PostgreSQL, stubbed Mongo)', () => {
  beforeAll(async () => {
    process.env.RECONCILE_SETTLING_WINDOW_MS = '0';
    await applySchema();
  });
  afterAll(async () => {
    delete process.env.RECONCILE_SETTLING_WINDOW_MS;
    await closePg();
  });
  beforeEach(async () => {
    gameTransactions = [];
    await pgQuery('TRUNCATE casino_transactions, casino_rounds RESTART IDENTITY CASCADE');
  });

  it('reports clean when both stores agree on all three totals', async () => {
    await pgRound('cr1', { debited: 100, credited: 250, refunded: 0 });
    gameTransactions = [
      { roundId: 'cr1', txId: 't1', type: 'BET', amount: 100 },
      { roundId: 'cr1', txId: 't2', type: 'WIN', amount: 250 },
    ];
    expect(await reconcileCasinoRounds()).toMatchObject({
      table: 'casino_rounds', disagreeing: 0, overRefunded: 0, checked: 1,
    });
  });

  it('REPORTS a disagreement rather than calling it clean', async () => {
    await pgRound('cr2', { debited: 100, credited: 0, refunded: 0 });
    gameTransactions = [
      { roundId: 'cr2', txId: 't1', type: 'BET', amount: 100 },
      { roundId: 'cr2', txId: 't2', type: 'WIN', amount: 500 },   // Postgres never saw this
    ];
    const report = await reconcileCasinoRounds();
    expect(report.disagreeing).toBe(1);
    expect(report.sample[0]).toMatchObject({
      roundId: 'cr2', mongo: { credited: 500 }, pg: { credited: 0 },
    });
  });

  it('flags a Mongo round that gave back MORE than it took', async () => {
    // The exposure the domain was built around. Postgres cannot reach this
    // state — refunded_paise <= debited_paise is a CHECK CONSTRAINT — so it can
    // only ever be reported from the Mongo side, which is exactly why the check
    // asks rather than assuming the constraint covers both stores.
    await pgRound('cr3', { debited: 100, credited: 0, refunded: 100 });
    gameTransactions = [
      { roundId: 'cr3', txId: 't1', type: 'BET', amount: 100 },
      { roundId: 'cr3', txId: 't2', type: 'ROLLBACK', amount: 100 },
      { roundId: 'cr3', txId: 't3', type: 'ROLLBACK', amount: 60 },  // Mongo let this through
    ];
    const report = await reconcileCasinoRounds();
    expect(report.overRefunded).toBe(1);
    expect(report.sample[0]).toMatchObject({ mongoOverRefunded: true, mongo: { refunded: 160 } });
  });

  it('a repair NEVER clears an over-refund', async () => {
    // Money already gone is not a record to rewrite. If a repair could zero
    // this counter, the pass that found real losses would report success.
    await pgRound('cr4', { debited: 100, credited: 0, refunded: 100 });
    gameTransactions = [
      { roundId: 'cr4', txId: 't1', type: 'BET', amount: 100 },
      { roundId: 'cr4', txId: 't2', type: 'ROLLBACK', amount: 150 },
    ];
    const report = await reconcileCasinoRounds({ repairMongo: true });
    expect(report.overRefunded).toBe(1);
  });

  it('does not count a Postgres round Mongo has never heard of', async () => {
    // That is a missing document, which the reverse table check owns.
    await pgRound('cr5', { debited: 50 });
    expect(await reconcileCasinoRounds()).toMatchObject({ disagreeing: 0, overRefunded: 0 });
  });

  it('refuses opposite repair directions in one pass', async () => {
    await expect(reconcileCasinoRounds({ backfill: true, repairMongo: true }))
      .rejects.toThrow(/opposite directions/);
  });

  it('the database refuses an over-refunded round outright', async () => {
    // The constraint, asserted directly. This is what makes the bound a
    // property of the DATA rather than of whichever code path happened to run.
    await pgRound('cr6', { debited: 100 });
    await expect(pgQuery(`UPDATE casino_rounds SET refunded_paise = 15000 WHERE round_id = 'cr6'`))
      .rejects.toThrow(/casino_rounds_refund_bound/);
  });
});
