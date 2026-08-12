// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Integration test (real Mongo): the DERIVED cycle pool equals the STORED one.
 *
 * `FLAGS.DERIVED_CYCLE_POOLS` replaces the per-bet `$inc` on the Cycle document
 * (the contention ceiling in docs/governance/LATENCY.md) with a projection
 * summed from the Bet rows themselves (`cyclePool.service.js`). Before that flag
 * can be flipped on a money path, the derived pool has to be proven to produce
 * the SAME numbers the stored increments would — because the two figures the
 * pool turns into money are pure functions of it:
 *
 *     winner    = the MINORITY of (realDelhi, realBombay)      // completeCycle
 *     netProfit = (realDelhi + realBombay) − totalPaidOut      // processPayouts
 *
 * So if `SUM(Bet.amount)` equals what `$inc` accumulated, the winner and the
 * netProfit are identical under both modes. This suite proves that equality
 * against a real database — the unit test (tests/unit/cyclePool.test.js) mocks
 * the aggregation, so the no-lost-updates and majority-read properties only
 * exist here and in loadtest/bet-contention.js.
 *
 * NOT COVERED HERE, and deliberately: the fail-closed branch in
 * cycleGenerator.completeCycle (`if (derived && !exactPools) return;`, which
 * refuses to settle when the exact refresh fails). Driving completeCycle end to
 * end needs a cycle in a completable state plus the game engine; it is verified
 * by inspection today and wants an end-to-end settlement test run against
 * staging, where a refresh failure can actually be injected and observed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { Cycle, Bet } from '../../models/index.js';
import {
  computeRealPools, refreshRealPools, _resetPoolMemo,
} from '../../domains/markets/cyclePool.service.js';
import { FLAGS, override } from '../../services/featureFlags.service.js';

let n = 0;
async function freshCycle(pools = {}) {
  const cycleId = `dp_${Date.now()}_${n++}`;
  await Cycle.create({
    cycleId, type: '30_MIN',
    startTime: Date.now() - 60_000, endTime: Date.now() + 300_000,
    status: 'OPEN',
    realDelhi: 0, realBombay: 0, phantomDelhi: 0, phantomBombay: 0,
    totalDelhi: 0, totalBombay: 0, ...pools,
  });
  return cycleId;
}

/** Place a real bet the way bet.routes does in DERIVED mode: insert only. */
function placeReal(cycleId, side, amount, status = 'PENDING') {
  return Bet.create({
    // userId is required (ObjectId); the pool aggregation groups by side and
    // sums amount, so a distinct throwaway id per bet is all this needs.
    cycleId, userId: new mongoose.Types.ObjectId(), side, amount, status,
    isPhantom: false, timestamp: new Date(),
  });
}

/** What the stored `$inc` path would have accumulated: the plain sum. */
function storedSum(bets, side) {
  return bets.filter((b) => b.side === side && b.status !== 'REFUNDED')
    .reduce((t, b) => t + b.amount, 0);
}

beforeEach(() => { _resetPoolMemo(); override(FLAGS.DERIVED_CYCLE_POOLS, true); });
afterEach(() => { override(FLAGS.DERIVED_CYCLE_POOLS, false); _resetPoolMemo(); });

describe('derived cycle pools match the stored increments (real Mongo)', () => {
  it('sums independent bet inserts to exactly what $inc would have produced', async () => {
    const cycleId = await freshCycle();
    const bets = [
      ['DELHI', 100], ['DELHI', 250], ['BOMBAY', 400],
      ['DELHI', 50], ['BOMBAY', 600], ['BOMBAY', 25],
    ];
    const created = [];
    for (const [side, amt] of bets) created.push(await placeReal(cycleId, side, amt));

    const pools = await computeRealPools(cycleId, { exact: true });

    // Delhi 100+250+50 = 400 ; Bombay 400+600+25 = 1025
    expect(pools.realDelhi).toBe(storedSum(created, 'DELHI'));
    expect(pools.realBombay).toBe(storedSum(created, 'BOMBAY'));
    expect(pools.realDelhi).toBe(400);
    expect(pools.realBombay).toBe(1025);

    // The winner is a pure function of these — Delhi is the minority, so Delhi
    // wins under BOTH modes because both see the same 400 vs 1025.
    const winner = pools.realDelhi < pools.realBombay ? 'DELHI' : 'BOMBAY';
    expect(winner).toBe('DELHI');
  });

  it('counts every non-refunded status and excludes REFUNDED', async () => {
    // The pool is the money STAKED, so PENDING (open), WON and LOST (settlement
    // relabelled them) all count; only REFUNDED — stake returned — leaves it.
    // Filtering to PENDING would collapse the pool to zero the instant
    // settlement runs, which is exactly when netProfit reads it.
    const cycleId = await freshCycle();
    await placeReal(cycleId, 'DELHI', 100, 'PENDING');
    await placeReal(cycleId, 'DELHI', 200, 'WON');
    await placeReal(cycleId, 'DELHI', 300, 'LOST');
    await placeReal(cycleId, 'DELHI', 999, 'REFUNDED');   // ← excluded

    const pools = await computeRealPools(cycleId, { exact: true });
    expect(pools.realDelhi).toBe(600);   // 100 + 200 + 300, never the 999
  });

  it('writes the pools onto the cycle and recomputes total = real + current phantom', async () => {
    // The equalizer may have set phantom independently; refreshRealPools must
    // fold in the phantom PRESENT AT WRITE TIME, never a value it read earlier.
    const cycleId = await freshCycle({ phantomDelhi: 5000, phantomBombay: 5000 });
    await placeReal(cycleId, 'DELHI', 700);
    await placeReal(cycleId, 'BOMBAY', 300);

    const pools = await refreshRealPools(cycleId, { exact: true });
    expect(pools).toEqual({ realDelhi: 700, realBombay: 300 });

    const doc = await Cycle.findOne({ cycleId }).lean();
    expect(doc.realDelhi).toBe(700);
    expect(doc.realBombay).toBe(300);
    // Phantom untouched; totals = real + phantom.
    expect(doc.phantomDelhi).toBe(5000);
    expect(doc.totalDelhi).toBe(5700);
    expect(doc.totalBombay).toBe(5300);
  });

  it('is a no-op with the flag OFF — the stored fields are left exactly as they are', async () => {
    override(FLAGS.DERIVED_CYCLE_POOLS, false);
    // A cycle whose stored pools were maintained the OLD way ($inc). Deriving
    // must not touch them, so a deployment can flip the flag off and be back on
    // the stored path with no rewrite.
    const cycleId = await freshCycle({ realDelhi: 1234, totalDelhi: 1234 });
    await placeReal(cycleId, 'DELHI', 500);   // a bet the derived path would sum

    expect(await refreshRealPools(cycleId, { exact: true })).toBeNull();

    const doc = await Cycle.findOne({ cycleId }).lean();
    expect(doc.realDelhi).toBe(1234);   // unchanged — not recomputed to 500
    expect(doc.totalDelhi).toBe(1234);
  });

  it('majority read at settlement sees a bet committed a moment earlier', async () => {
    // The exact path reads with readConcern: majority so a bet another process
    // just committed is counted. On a single-node RS this is trivially true;
    // the assertion is here so the exact path is exercised end to end.
    const cycleId = await freshCycle();
    await placeReal(cycleId, 'BOMBAY', 4200);
    const pools = await refreshRealPools(cycleId, { exact: true, force: true });
    expect(pools.realBombay).toBe(4200);
  });
});
