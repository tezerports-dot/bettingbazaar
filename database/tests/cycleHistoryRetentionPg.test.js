// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * cycleHistoryRetentionPg.test.js — rounds past the newest N of a board and
 * audience are summed into `cycle_history_rollups` and removed; the bets stay.
 * Each test runs on a board of its own, so no other suite's rounds are touched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomInt, randomUUID } from 'node:crypto';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import * as boards from '../repositories/boards.js';
import { placeBet, loseBet, getBet, closePhantomBets } from '../repositories/bets.core.js';
import { applyDeltaPaise } from '../repositories/wallets.core.js';
import { TEST_FUNDING } from './_funding.js';
import { placePhantomBet } from '../repositories/markets.js';
import { pruneCycleHistory, listRollups } from '../repositories/cycleHistoryRetention.js';

const describePg = pgConfigured() ? describe : describe.skip;
const PHASES = { mergeBeforeEndSec: 40, equalizerBeforeEndSec: 30, closeBeforeEndSec: 20, celebrateBeforeEndSec: 5 };
const created = [];

const newBoard = async () => {
  const b = await boards.createBoard({
    name: `Retention ${randomInt(0, 1e9)}`, kind: 'INTERVAL', durationMin: 5, phases: PHASES, minBet: 10, maxBet: 1000,
  });
  created.push(b.key);
  return b.key;
};

// 2026-01-10 06:00 IST, then one round every 5 minutes: all on one IST day.
const DAY0 = Date.parse('2026-01-10T00:30:00Z');
const at = (i) => new Date(DAY0 + i * 5 * 60_000);

/** A round as the generator leaves it once settled (or cancelled). */
async function round(board, i, { audience = 'VIP', winner = 'DELHI', status = 'COMPLETED', settled = true,
  paid = 0, profit = 0, fees = 0, house = 0 } = {}) {
  const id = `${board}-${audience}-${i}`;
  await pgQuery(
    `INSERT INTO cycles (cycle_id, cycle_type, audience, status, start_time, end_time, phantom_delhi_paise)
     VALUES ($1, $2, $3, 'OPEN', $4::timestamptz, $4::timestamptz + interval '5 minutes', $5)`,
    [id, board, audience, at(i), house],
  );
  return {
    id,
    finish: () => pgQuery(
      `UPDATE cycles SET status = $2, winner = $3, is_settled = $4,
              total_paid_out_paise = $5, net_profit_paise = $6, total_platform_fees_paise = $7
        WHERE cycle_id = $1`,
      [id, status, status === 'CANCELLED' ? null : winner, settled, paid, profit, fees],
    ),
  };
}

const cyclesOf = async (board) => (await pgQuery(
  'SELECT cycle_id FROM cycles WHERE cycle_type = $1 ORDER BY start_time', [board])).rows.map((r) => r.cycle_id);

describePg('round history retention', () => {
  beforeAll(async () => { await applySchema(); });
  afterAll(async () => {
    if (created.length) await pgQuery('UPDATE boards SET enabled = false WHERE board_key = ANY($1)', [created]).catch(() => {});
    await closePg();
  });

  it('keeps the newest N, sums the older rounds by day, and leaves their bets', async () => {
    const board = await newBoard();
    const user = `ret-${randomUUID()}`;
    await applyDeltaPaise({ userId: user, field: 'depositBalance', deltaPaise: 300_00, txId: `f-${user}`,
      type: 'CREDIT', reason: 'test', counterparty: TEST_FUNDING });

    const rounds = [];
    for (let i = 0; i < 5; i += 1) rounds.push(await round(board, i, {
      winner: i % 2 ? 'BOMBAY' : 'DELHI', paid: 10_00 * i, profit: 100 * i, fees: 10 * i, house: 50_00,
    }));
    // A real bet on the oldest round, lost, so it is no longer PENDING.
    const betId = `bet-${user}`;
    const placed = await placeBet({ betId, userId: user, cycleId: rounds[0].id, side: 'BOMBAY',
      slices: [{ field: 'depositBalance', amountPaise: 120_00 }] });
    expect(placed.ok).toBe(true);
    await loseBet({ betId, userId: user, slices: [{ field: 'depositBalance', amountPaise: 120_00 }] });
    // A house bet on it too: never counted as a real stake. Closed as the
    // settlement closes them (`closePhantomBets`).
    expect((await placePhantomBet({ betId: `ph-${user}`, userId: `agent-${user}`, cycleId: rounds[0].id,
      side: 'DELHI', amountRupees: 70, cycleType: board })).ok).toBe(true);
    await closePhantomBets(rounds[0].id);
    for (const r of rounds) await r.finish();

    const { pruned } = await pruneCycleHistory({ keep: 2, cycleType: board });

    expect(pruned).toBe(3);
    expect(await cyclesOf(board)).toEqual([rounds[3].id, rounds[4].id]);
    const [day] = await listRollups({ cycleType: board });
    expect(day).toMatchObject({
      cycleType: board, audience: 'VIP', day: '2026-01-10', rounds: 3, delhiWins: 2, bombayWins: 1, cancelled: 0,
      realStaked: 120, houseStaked: 220, paidOut: 30, netProfit: 3, fees: 0.3,
    });
    // The bet is the money record: it stays, with its round's id.
    expect((await getBet(betId))?.cycleId).toBe(rounds[0].id);

    // A second run has nothing left to do and adds nothing twice.
    expect((await pruneCycleHistory({ keep: 2, cycleType: board })).pruned).toBe(0);
    expect((await listRollups({ cycleType: board }))[0].rounds).toBe(3);

    // A newer round pushes one more out: it is ADDED to the same day's row.
    await (await round(board, 5, { winner: 'BOMBAY', paid: 5_00, profit: 7 })).finish();
    expect((await pruneCycleHistory({ keep: 2, cycleType: board })).pruned).toBe(1);
    expect((await listRollups({ cycleType: board }))[0]).toMatchObject({
      rounds: 4, delhiWins: 2, bombayWins: 2, realStaked: 120, houseStaked: 270, paidOut: 60, netProfit: 6,
    });
  });

  it('never removes a round that is not finished with', async () => {
    const board = await newBoard();
    const user = `ret-${randomUUID()}`;
    await applyDeltaPaise({ userId: user, field: 'depositBalance', deltaPaise: 50_00, txId: `f-${user}`,
      type: 'CREDIT', reason: 'test', counterparty: TEST_FUNDING });

    const unsettled = await round(board, 0);              // declared, not yet paid out
    const pendingBet = await round(board, 1);             // settled, but a bet still PENDING
    const cancelled = await round(board, 2, { status: 'CANCELLED', settled: false });
    await round(board, 3); await round(board, 4);
    await placeBet({ betId: `bet-${user}`, userId: user, cycleId: pendingBet.id, side: 'DELHI',
      slices: [{ field: 'depositBalance', amountPaise: 50_00 }] });
    await pgQuery(`UPDATE cycles SET status = 'RESULT_DECLARED', winner = 'DELHI' WHERE cycle_id = $1`, [unsettled.id]);
    await pendingBet.finish();
    await cancelled.finish();

    const { pruned } = await pruneCycleHistory({ keep: 2, cycleType: board });

    // Only the cancelled one goes; it counts as a round and as cancelled, never a win.
    expect(pruned).toBe(1);
    expect(await cyclesOf(board)).toEqual([unsettled.id, pendingBet.id, `${board}-VIP-3`, `${board}-VIP-4`]);
    expect((await listRollups({ cycleType: board }))[0]).toMatchObject({ rounds: 1, cancelled: 1, delhiWins: 0, bombayWins: 0 });
  });

  it('counts the window per audience, not across both', async () => {
    const board = await newBoard();
    for (let i = 0; i < 3; i += 1) {
      await (await round(board, i, { audience: 'VIP' })).finish();
      await (await round(board, i, { audience: 'GENERAL' })).finish();
    }

    expect((await pruneCycleHistory({ keep: 2, cycleType: board })).pruned).toBe(2);

    const left = (await pgQuery('SELECT audience, COUNT(*)::int AS n FROM cycles WHERE cycle_type = $1 GROUP BY audience ORDER BY audience', [board])).rows;
    expect(left).toEqual([{ audience: 'GENERAL', n: 2 }, { audience: 'VIP', n: 2 }]);
    const days = await listRollups({ cycleType: board });
    expect(days.map((d) => [d.audience, d.rounds]).sort()).toEqual([['GENERAL', 1], ['VIP', 1]]);
  });
});
