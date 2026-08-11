// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * gameEngine's half of bet-settlement routing: the LOSING side, the winner
 * aggregation, and the single authority decision the whole pass runs on.
 *
 * ── The three things that blocked this, all asserted here ───────────────────
 * (a) The winner aggregation projected the funding split under names that were
 *     not the Bet document's (`fromDeposit`, `fromWinnings`) and omitted
 *     `fromReserveBalance` entirely. `slicesFromBet` reads the document's real
 *     names, so it saw `undefined` for every bet, and `betPg.settle` requires
 *     the slices to sum EXACTLY to the stake — so a reserve-funded bet threw
 *     rather than settling.
 * (b) `betStamps` carried three scalars and no document, so the winning side
 *     had nothing to derive slices from.
 * (c) The `Transaction` log — decided in settlementService, tested there.
 *
 * ── And the property that makes it safe to ship ─────────────────────────────
 * ONE decision per pass. The losing side and the winning side must settle in
 * the same store; a cycle split across both is the failure no reconciliation
 * can tell apart from the two stores genuinely disagreeing. So the engine reads
 * the resolver once and PASSES it down, and that is asserted rather than
 * assumed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const pgAuth = vi.hoisted(() => ({
  onPostgres: false,
  settled: [],
  resultFor: null,
}));
vi.mock('../../postgres/betPgAuthority.js', () => ({
  onPostgres: () => pgAuth.onPostgres,
  settleBetOnPostgres: async (args) => {
    pgAuth.settled.push(args);
    return pgAuth.resultFor ? pgAuth.resultFor(args) : { handled: true, ok: true };
  },
}));

const svc = vi.hoisted(() => ({ unlocked: [], batches: [], refusedFor: null }));
vi.mock('../../domains/settlement/settlementService.js', () => ({
  unlockLostBet: async (...a) => { svc.unlocked.push(a); },
  executeSettlementBatch: async (userOps, txOps, routing) => {
    svc.batches.push({ userOps, txOps, routing });
    return { refused: svc.refusedFor ? svc.refusedFor(userOps) : [] };
  },
}));

const db = vi.hoisted(() => ({
  losingBets: [],
  winGroups: [],
  updateMany: [],
  wonTotals: [{ paid: 0, fees: 0, winners: [] }],
  aggregateCalls: [],
}));

vi.mock('../../models/index.js', () => ({
  Cycle: {
    findOneAndUpdate: async () => ({ toObject: () => ({ cycleId: 'c1', winner: 'DELHI' }) }),
    updateOne: async () => ({}),
    find: async () => [],
    findOne: async () => null,
  },
  Bet: {
    find: async () => db.losingBets,
    updateMany: async (filter, update) => { db.updateMany.push({ filter, update }); return {}; },
    aggregate: (pipeline) => {
      db.aggregateCalls.push(pipeline);
      // The winner pass uses .cursor(); the totals pass awaits the pipeline.
      const groups = db.winGroups;
      const result = Promise.resolve(db.wonTotals);
      result.cursor = () => ({
        async *[Symbol.asyncIterator]() { for (const g of groups) yield g; },
      });
      return result;
    },
  },
  User: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));

const alerts = vi.hoisted(() => ({ sent: [] }));
vi.mock('../../services/alerting.service.js', () => ({
  sendAlert: (...a) => { alerts.sent.push(a); },
}));

vi.mock('mongoose', () => ({ default: {} }));
vi.mock('../../services/cache.service.js', () => ({ CacheService: { del: async () => {} } }));
vi.mock('../../domains/wallet/walletAuthority.service.js', () => ({ creditWinnings: async () => {} }));
vi.mock('../../domains/notification/realtimeEmitters.js', () => ({ emitPayoutSuccessBatch: async () => {} }));
vi.mock('../../domains/risk/riskValidation.service.js', () => ({
  getRiskRules: async () => ({ winningsFeePercent: 1, payoutMultiplier: 2 }),
  computeWinningsPayout: ({ amount, feePercent, multiplier }) => {
    const grossMinor = Math.round(amount * 100) * multiplier;
    const feeMinor = Math.round((grossMinor * feePercent) / 100);
    return { netMinor: grossMinor - feeMinor, feeMinor, net: (grossMinor - feeMinor) / 100, fee: feeMinor / 100 };
  },
}));
vi.mock('../../services/metrics.service.js', () => ({ settlementRuns: { inc: () => {} } }));
vi.mock('../../domains/markets/cyclePool.service.js', () => ({
  refreshRealPools: async () => ({ realDelhi: 0, realBombay: 0 }),
  forgetCycle: () => {},
}));
vi.mock('../../postgres/dualWrite.js', () => ({ mirrorCycleSettlement: () => {} }));
vi.mock('../../postgres/settlementPgAuthority.js', () => ({
  beginSettlement: async () => ({ ok: true }),
  finishSettlement: async () => ({ ok: true }),
}));

const GameEngine = (await import('../../domains/markets/gameEngine.js')).default;

/** Drive one settlement pass without the constructor's timers. */
const settle = (cycle = { _id: 'x', cycleId: 'c1', winner: 'DELHI' }) =>
  GameEngine.prototype.processPayoutsOptimized.call({ io: null }, cycle);

const losing = (id, over = {}) => ({
  _id: id, userId: `u_${id}`, cycleId: 'c1', side: 'BOMBAY', amount: 100,
  fromDepositBalance: 100, fromWinningsBalance: 0, fromReserveBalance: 0, ...over,
});

beforeEach(() => {
  pgAuth.onPostgres = false;
  pgAuth.settled.length = 0;
  pgAuth.resultFor = null;
  svc.unlocked.length = 0;
  svc.batches.length = 0;
  svc.refusedFor = null;
  db.losingBets = [];
  db.winGroups = [];
  db.updateMany.length = 0;
  db.aggregateCalls.length = 0;
  db.wonTotals = [{ paid: 0, fees: 0, winners: [] }];
  alerts.sent.length = 0;
});

describe('the losing side while MongoDB is authoritative', () => {
  it('unlocks each stake and stamps the whole side in one bulk update', async () => {
    db.losingBets = [losing('b1'), losing('b2')];
    await settle();

    expect(svc.unlocked).toHaveLength(2);
    expect(pgAuth.settled).toHaveLength(0);
    // The losing-side stamp, plus the phantom stamp that always runs.
    const lostStamps = db.updateMany.filter((u) => u.filter.isPhantom === false);
    expect(lostStamps).toHaveLength(1);
    expect(lostStamps[0].update).toEqual({ $set: { status: 'LOST' } });
  });
});

describe('the losing side once PostgreSQL owns the path', () => {
  beforeEach(() => { pgAuth.onPostgres = true; });

  it('settles each bet through the authority and unlocks NOTHING separately', async () => {
    db.losingBets = [losing('b1'), losing('b2')];
    await settle();

    expect(pgAuth.settled.map((s) => s.bet._id)).toEqual(['b1', 'b2']);
    expect(pgAuth.settled.every((s) => s.outcome === 'LOST')).toBe(true);
    // betPg.loseBet consumes the locked stake inside the same transaction as
    // the status change; unlockLostBet would release it a second time.
    expect(svc.unlocked).toHaveLength(0);
  });

  it('does NOT run the bulk LOST stamp', async () => {
    db.losingBets = [losing('b1')];
    await settle();

    // The reverse mirror has already written each status. Re-stamping would
    // overwrite the bets Postgres refused — a reported failure made silent.
    expect(db.updateMany.filter((u) => u.filter.isPhantom === false)).toHaveLength(0);
  });

  it('still stamps PHANTOM bets in Mongo — they never reach Postgres at all', async () => {
    await settle();
    const phantom = db.updateMany.filter((u) => u.filter.isPhantom === true);
    expect(phantom).toHaveLength(1);
    expect(phantom[0].update).toEqual({ $set: { status: 'LOST' } });
  });

  it('reports refusals and leaves the stake accounted for by an alert', async () => {
    db.losingBets = [losing('b1'), losing('b2')];
    pgAuth.resultFor = (a) => (a.bet._id === 'b2'
      ? { handled: true, ok: false, reason: 'no_funding_slices' }
      : { handled: true, ok: true });

    await settle();

    const refusalAlert = alerts.sent.find((a) => /refused bet settlements/.test(a[1]));
    expect(refusalAlert).toBeDefined();
    expect(refusalAlert[2]).toMatchObject({ cycleId: 'c1', refused: 1 });
    expect(refusalAlert[2].sample[0]).toMatchObject({ betId: 'b2', reason: 'no_funding_slices' });
  });

  it('does not alert when every bet settled', async () => {
    db.losingBets = [losing('b1')];
    await settle();
    expect(alerts.sent.filter((a) => /refused bet settlements/.test(a[1]))).toHaveLength(0);
  });

  it('THROWS if the authority answers `handled: false` mid-cycle', async () => {
    db.losingBets = [losing('b1')];
    pgAuth.resultFor = () => ({ handled: false });
    await expect(settle()).rejects.toThrow(/authority changed mid-settlement/);
  });
});

describe('the winner aggregation carries what a settle actually needs', () => {
  const projected = () => {
    const group = db.aggregateCalls[0].find((s) => s.$group);
    return group.$group.bets.$push;
  };

  it('projects the funding split under the DOCUMENT\'s names, including reserve', async () => {
    await settle();
    // Blocker (a). Aliased names read back as `undefined` from slicesFromBet,
    // and a missing reserve slice makes the total disagree with the stake —
    // which betPg.settle refuses rather than guesses at.
    expect(projected()).toMatchObject({
      fromDepositBalance: '$fromDepositBalance',
      fromWinningsBalance: '$fromWinningsBalance',
      fromReserveBalance: '$fromReserveBalance',
    });
    expect(projected()).not.toHaveProperty('fromDeposit');
    expect(projected()).not.toHaveProperty('fromWinnings');
  });

  it('still computes the locked totals the Mongo release needs', async () => {
    db.winGroups = [{
      _id: 'u1', totalBetAmount: 100, betIds: ['b1'],
      bets: [{
        betId: 'b1', amount: 100,
        fromDepositBalance: 60, fromWinningsBalance: 40, fromReserveBalance: 0,
        timestamp: new Date(1),
      }],
    }];
    await settle();

    // Renaming the projection would silently zero these if the readers were not
    // renamed with it — the stake would then never leave the provenance counters.
    expect(svc.batches[0].userOps[0]).toMatchObject({
      totalLockedDeposit: 60, totalLockedWinnings: 40,
    });
  });

  it('attaches the bet DOCUMENT to each stamp', async () => {
    db.winGroups = [{
      _id: 'u1', totalBetAmount: 100, betIds: ['b1'],
      bets: [{
        betId: 'b1', amount: 100,
        fromDepositBalance: 0, fromWinningsBalance: 0, fromReserveBalance: 100,
        timestamp: new Date(1),
      }],
    }];
    await settle();

    // Blocker (b). The pieces the aggregation cannot know per bet — user, cycle,
    // side — are filled from the group key and the cycle.
    expect(svc.batches[0].userOps[0].betStamps[0].bet).toMatchObject({
      _id: 'b1', userId: 'u1', cycleId: 'c1', side: 'DELHI',
      amount: 100, fromReserveBalance: 100,
    });
  });
});

describe('one decision for the whole pass', () => {
  it('hands the winning side the SAME answer the losing side ran on', async () => {
    pgAuth.onPostgres = true;
    db.losingBets = [losing('b1')];
    db.winGroups = [{
      _id: 'u1', totalBetAmount: 100, betIds: ['b1'],
      bets: [{ betId: 'bw', amount: 100, fromDepositBalance: 100, fromWinningsBalance: 0, fromReserveBalance: 0, timestamp: new Date(1) }],
    }];
    await settle();

    expect(svc.batches[0].routing).toEqual({ onPg: true });
  });

  it('and the same again when Mongo owns it', async () => {
    pgAuth.onPostgres = false;
    db.winGroups = [{
      _id: 'u1', totalBetAmount: 100, betIds: ['b1'],
      bets: [{ betId: 'bw', amount: 100, fromDepositBalance: 100, fromWinningsBalance: 0, fromReserveBalance: 0, timestamp: new Date(1) }],
    }];
    await settle();

    expect(svc.batches[0].routing).toEqual({ onPg: false });
  });

  it('passes it on the MID-CURSOR flush too, not only on the final batch', async () => {
    // There are two call sites: the one that fires every BATCH_SIZE winners
    // inside the cursor loop, and the one that drains the remainder afterwards.
    // A single-winner test only ever reaches the second, so the first can lose
    // its routing argument and every assertion still passes — which is exactly
    // what happened: a mutation removing `{ onPg }` from the flush call SURVIVED
    // the suite until this test existed. A cycle big enough to flush would then
    // have settled its first 500 winners against the resolver's answer rather
    // than the pass's.
    pgAuth.onPostgres = true;
    db.winGroups = Array.from({ length: 501 }, (_, i) => ({
      _id: `u${i}`, totalBetAmount: 100, betIds: [`b${i}`],
      bets: [{
        betId: `b${i}`, amount: 100,
        fromDepositBalance: 100, fromWinningsBalance: 0, fromReserveBalance: 0,
        timestamp: new Date(1),
      }],
    }));

    await settle();

    expect(svc.batches.length).toBeGreaterThan(1);
    for (const b of svc.batches) expect(b.routing).toEqual({ onPg: true });
  });
});
