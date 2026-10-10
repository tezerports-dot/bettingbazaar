// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The round result each player is told at declaration
 * (`markets/roundResult.service.announceRoundResults`), against a real
 * PostgreSQL (owner, 2026-10-10: one pop-up per player per cycle).
 *
 * One `round_result` per player however many bets they hold, summed; the
 * payout announced is the payout settlement then writes on the rows, fee
 * floored per bet; and the answer is the same before and after settlement.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { pgConfigured, pgQuery, applySchema, closePg } from '../client.js';
import { applyDeltaPaise } from '../repositories/wallets.core.js';
import { placeBet, winBets, loseBets, cycleStakesByPlayer } from '../repositories/bets.core.js';
import { ensureCycle, placePhantomBet } from '../repositories/markets.js';
import { getRiskRules, computeWinningsPayout } from '../../backend/domains/risk/riskValidation.service.js';
import { announceRoundResults } from '../../backend/domains/markets/roundResult.service.js';
import { TEST_FUNDING } from './_funding.js';

const describePg = pgConfigured() ? describe : describe.skip;
const RUN = `rr-${Date.now().toString(36)}`;
let seq = 0;
const next = (tag) => `${RUN}-${tag}${++seq}`;

async function player() {
  const u = next('u');
  await applyDeltaPaise({
    userId: u, field: 'depositBalance', deltaPaise: 100_000, txId: next('fund'), type: 'CREDIT',
    reason: 'test funding', counterparty: TEST_FUNDING,
  });
  return u;
}

async function bet(userId, cycleId, side, stakePaise) {
  const betId = next('b');
  const slices = [{ field: 'depositBalance', amountPaise: stakePaise }];
  const r = await placeBet({ betId, userId, cycleId, side, slices });
  expect(r.ok).toBe(true);
  return { betId, userId, slices, stakePaise, side };
}

/** Captures what `emitToPlayer` sends, per player. */
function captureStream() {
  const sent = [];
  global.sseManager = { sendToUser: (userId, event, data) => sent.push({ userId, event, data }) };
  return sent;
}

describePg('round result at declaration (one per player per cycle)', () => {
  const savedManager = global.sseManager;
  beforeAll(async () => { await applySchema(); });
  afterEach(() => { global.sseManager = savedManager; });
  afterAll(async () => { await closePg(); });

  it('sums each player once, fee floored per bet, and matches what settlement pays', async () => {
    const start = new Date(Date.UTC(2033, 0, 1) + Math.floor(Math.random() * 1e6) * 60_000);
    const { cycle } = await ensureCycle({
      cycleId: next('c'), cycleType: '1_MIN', audience: 'VIP',
      startTime: start, endTime: new Date(start.getTime() + 60_000),
    });
    const cycleId = cycle.cycleId;
    const a = await player();
    const b = await player();
    const bystander = await player();
    // 33.30 twice: per bet the fee floors to 0.66 each (net 131.88); summed
    // first it would floor once (net 131.87). The announcement must be per bet.
    const bets = [
      await bet(a, cycleId, 'DELHI', 3_330),
      await bet(a, cycleId, 'DELHI', 3_330),
      await bet(a, cycleId, 'BOMBAY', 5_000),
      await bet(b, cycleId, 'BOMBAY', 10_000),
    ];

    const sent = captureStream();
    expect(await announceRoundResults({ cycleId, winner: 'DELHI' })).toBe(2);
    const mine = sent.filter((s) => s.event === 'round_result' && s.data.cycleId === cycleId);
    expect(mine.map((s) => s.userId).sort()).toEqual([a, b].sort());
    expect(sent.some((s) => s.userId === bystander)).toBe(false);

    const { winningsFeePercent, payoutMultiplier } = await getRiskRules();
    const net = (p) => computeWinningsPayout({ amount: p / 100, feePercent: winningsFeePercent, multiplier: payoutMultiplier }).netMinor;
    const forA = mine.find((s) => s.userId === a).data;
    expect(forA).toEqual({ cycleId, winner: 'DELHI', stakedPaise: 11_660, payoutPaise: 2 * net(3_330) });
    expect(mine.find((s) => s.userId === b).data).toEqual({ cycleId, winner: 'DELHI', stakedPaise: 10_000, payoutPaise: 0 });

    // Settle the round the way the engine does; the rows must pay what was said.
    const how = { actor: 'test', reason: 'round result test' };
    const winners = bets.filter((x) => x.side === 'DELHI');
    const losers = bets.filter((x) => x.side !== 'DELHI');
    expect((await loseBets(losers.map(({ betId, userId, slices }) => ({ betId, userId, slices })), how)).ok).toBe(true);
    const won = await winBets(winners.map(({ betId, userId, slices, stakePaise }) => {
      const p = computeWinningsPayout({ amount: stakePaise / 100, feePercent: winningsFeePercent, multiplier: payoutMultiplier });
      return { betId, userId, slices, payoutPaise: p.netMinor, platformFeePaise: p.feeMinor };
    }), how);
    expect(won.ok).toBe(true);
    const { rows } = await pgQuery(
      `SELECT COALESCE(SUM(payout_paise), 0)::bigint AS paid FROM bets WHERE cycle_id = $1 AND user_id = $2`, [cycleId, a]);
    expect(Number(rows[0].paid)).toBe(forA.payoutPaise);

    // Settled or not, the same answer (a FORCE_RESULT re-announce, a late call).
    const again = captureStream();
    await announceRoundResults({ cycleId, winner: 'DELHI' });
    expect(again.find((s) => s.userId === a).data).toEqual(forA);
  });

  it('leaves out phantom bets, and tells nobody on a cycle without stakes or without a winner', async () => {
    const start = new Date(Date.UTC(2034, 0, 1) + Math.floor(Math.random() * 1e6) * 60_000);
    const { cycle } = await ensureCycle({
      cycleId: next('c'), cycleType: '1_MIN', audience: 'VIP',
      startTime: start, endTime: new Date(start.getTime() + 60_000),
    });
    const sent = captureStream();
    expect(await announceRoundResults({ cycleId: cycle.cycleId, winner: 'BOMBAY' })).toBe(0);
    const u = await player();
    await bet(u, cycle.cycleId, 'BOMBAY', 1_000);
    expect(await announceRoundResults({ cycleId: cycle.cycleId, winner: null })).toBe(0);
    expect(sent).toEqual([]);
    const ghost = next('ghost');
    await placePhantomBet({ betId: next('phantom'), userId: ghost, cycleId: cycle.cycleId, side: 'DELHI', amountRupees: 500 });
    const { rows } = await pgQuery(`SELECT count(*)::int AS n FROM bets WHERE cycle_id = $1 AND is_phantom`, [cycle.cycleId]);
    expect(rows[0].n).toBe(1);
    expect((await cycleStakesByPlayer(cycle.cycleId)).map((s) => s.userId)).toEqual([u]);
  });
});
