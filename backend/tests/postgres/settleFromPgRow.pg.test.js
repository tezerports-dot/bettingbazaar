// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Settling a bet the caller enumerated FROM POSTGRES.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * `settleBetOnPostgres` accepts two shapes. One carries a Mongo document; the
 * other carries `bet: null` plus the native key, the funding slices and the
 * owner taken straight off the `bets` row. The second is what a caller uses once
 * it enumerates from the store that owns the bets — the straggler sweep always
 * did, and the settlement pass now does it for EVERY bet.
 *
 * That shape was broken. `userId: String(bet.userId)` was unconditional, so
 * every `bet: null` call threw `Cannot read properties of null`. It survived
 * because the only two suites covering settlement MOCK `settleBetOnPostgres`
 * and assert on the arguments it was handed — so the mock answered where the
 * real function would have thrown, and the engine looked green while being
 * unable to settle a single bet.
 *
 * Nothing here is mocked. If the null-bet shape stops working, this fails.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { pgConfigured, pgQuery, applySchema } from '../../postgres/pgClient.js';
import { applyDeltaPaise, getBalancesPaise } from '../../postgres/walletPg.js';
import { placeBet, findPendingBetsForCycle, BET_STATUS } from '../../postgres/betPg.js';
import { settleBetOnPostgres } from '../../postgres/betPgAuthority.js';
import { givenCycle } from './_cycleFixture.js';

const describePg = pgConfigured() ? describe : describe.skip;

let seq = 0;
const uniq = () => `pgrow_${Date.now()}_${seq++}`;

describePg('settling from a Postgres row, with no Mongo document', () => {
  let cycleId;

  beforeAll(async () => {
    await applySchema();
    cycleId = uniq();
    await givenCycle(cycleId);
  });

  /** Fund a user and place one real bet; return the row as an enumerator sees it. */
  async function givenPendingBet(side = 'DELHI', stakePaise = 10_000) {
    const userId = uniq();
    const betId = `bet_${userId}`;
    await applyDeltaPaise({
      userId, field: 'depositBalance', deltaPaise: stakePaise,
      txId: `${userId}_fund`, type: 'CREDIT', reason: 'test funding',
    });
    const placed = await placeBet({
      betId, userId, cycleId, side, stakePaise,
      slices: [{ field: 'depositBalance', amountPaise: stakePaise }],
    });
    expect(placed.ok).toBe(true);
    const row = (await findPendingBetsForCycle(cycleId, { limit: 500 }))
      .find((r) => r.betId === betId);
    expect(row, 'the enumeration did not return the bet just placed').toBeDefined();
    return { userId, betId, row };
  }

  it('pays a winner identified only by the row — the shape that threw', async () => {
    const { userId, betId, row } = await givenPendingBet('DELHI');

    // Exactly how gameEngine calls it: no document, everything off the row.
    const r = await settleBetOnPostgres({
      bet: null, pgBetId: row.betId, pgSlices: row.slices, pgUserId: row.userId,
      outcome: 'WON', payoutRupees: 198, platformFeeRupees: 2,
      reason: 'Cycle win payout',
    });

    expect({ ok: r.ok, reason: r.reason }).toEqual({ ok: true, reason: undefined });
    const balances = await getBalancesPaise(userId);
    expect(balances.winningsBalance).toBe(19_800);
    expect(balances.lockedBalance).toBe(0);

    const { rows } = await pgQuery('SELECT status FROM bets WHERE bet_id = $1', [betId]);
    expect(rows[0].status).toBe(BET_STATUS.WON);
  });

  it('consumes a loser identified only by the row', async () => {
    const { userId, betId, row } = await givenPendingBet('BOMBAY');

    const r = await settleBetOnPostgres({
      bet: null, pgBetId: row.betId, pgSlices: row.slices, pgUserId: row.userId,
      outcome: 'LOST', reason: 'Lost bet unlock',
    });

    expect(r.ok).toBe(true);
    const balances = await getBalancesPaise(userId);
    // The stake is consumed, not returned, and nothing stays locked.
    expect({ winnings: balances.winningsBalance, locked: balances.lockedBalance, deposit: balances.depositBalance })
      .toEqual({ winnings: 0, locked: 0, deposit: 0 });

    const { rows } = await pgQuery('SELECT status FROM bets WHERE bet_id = $1', [betId]);
    expect(rows[0].status).toBe(BET_STATUS.LOST);
  });

  it('refuses rather than throws when no owner can be determined', async () => {
    // A caller that passes neither a document nor a row owner has given the
    // settle nothing to lock a wallet on. Refusing names the problem; throwing
    // aborts the whole cycle's pass on one malformed call.
    const { row } = await givenPendingBet('DELHI');
    const r = await settleBetOnPostgres({
      bet: null, pgBetId: row.betId, pgSlices: row.slices, pgUserId: null,
      outcome: 'WON', payoutRupees: 198,
    });
    expect({ handled: r.handled, ok: r.ok, reason: r.reason })
      .toEqual({ handled: true, ok: false, reason: 'no_owner' });
  });

  it('is idempotent — a re-run settles nothing further', async () => {
    // The recovery task re-admits a RUNNING cycle on purpose, so the same row
    // can reach this function twice.
    const { userId, row } = await givenPendingBet('DELHI');
    const args = {
      bet: null, pgBetId: row.betId, pgSlices: row.slices, pgUserId: row.userId,
      outcome: 'WON', payoutRupees: 198, platformFeeRupees: 2, reason: 'payout',
    };
    await settleBetOnPostgres(args);
    const after = await getBalancesPaise(userId);
    await settleBetOnPostgres(args);
    expect(await getBalancesPaise(userId)).toEqual(after);
  });
});
