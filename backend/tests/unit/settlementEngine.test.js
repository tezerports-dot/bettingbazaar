// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * gameEngine's settlement pass, with PostgreSQL as the only store.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 * betSettlementEngineRouting.test.js, all sixteen cases of it. Every one
 * described the two-store seam — "while MongoDB is authoritative", "does NOT
 * run the bulk LOST stamp", "hands the winning side the SAME answer the losing
 * side ran on". There is one store now, so there is no seam to split, no bulk
 * stamp to suppress, and no per-pass authority decision to carry. Keeping those
 * assertions would mean keeping code whose only job is to satisfy them.
 *
 * Note what is NOT mocked here: `models/index.js` and `mongoose`. The old file
 * had to stub `Cycle.findOneAndUpdate`, `Bet.find`, `Bet.aggregate`,
 * `Bet.updateMany` and `User.find` to get a pass to run. The engine reaches for
 * none of them now, and a mock reappearing in this file is the signal that
 * MongoDB has crept back into the money path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const pg = vi.hoisted(() => ({
  pending: [], settled: [], resultFor: null, totals: null, statusWrites: [],
}));
vi.mock('../../postgres/betPgAuthority.js', () => ({
  findPendingBetsForCycleOnPostgres: async () => pg.pending,
  settleBetOnPostgres: async (args) => {
    pg.settled.push(args);
    return pg.resultFor ? pg.resultFor(args) : { ok: true };
  },
  derivePayoutTotalsOnPostgres: async () => pg.totals,
}));

const run = vi.hoisted(() => ({ claim: null, finished: [] }));
vi.mock('../../postgres/settlementPgAuthority.js', () => ({
  beginSettlement: async () => run.claim,
  finishSettlement: async (a) => { run.finished.push(a); return { ok: true }; },
  readSettlement: async () => null,
}));
vi.mock('../../postgres/settlementPg.js', () => ({
  SETTLEMENT_STATUS: { RUNNING: 'RUNNING', COMPLETED: 'COMPLETED', VOIDED: 'VOIDED' },
}));
vi.mock('../../postgres/cyclePg.js', () => ({
  findCurrentCycle: async () => null,
  findCyclesAwaitingSettlement: async () => [],
  findResumableSettlements: async () => [],
  derivePoolsForCycle: async () => ({ realDelhiPaise: 20000, realBombayPaise: 0 }),
  setStatus: async (a) => { pg.statusWrites.push(a); return { ok: true }; },
  CYCLE_STATUS: { CLOSED: 'CLOSED', RESULT_DECLARED: 'RESULT_DECLARED', COMPLETED: 'COMPLETED' },
}));
vi.mock('../../postgres/walletPg.js', () => ({
  getBalancesPaise: async () => ({ winningsBalance: 0, depositBalance: 0, lockedBalance: 0 }),
}));

const alerts = vi.hoisted(() => ({ sent: [] }));
vi.mock('../../services/alerting.service.js', () => ({ sendAlert: (...a) => { alerts.sent.push(a); } }));
vi.mock('../../services/metrics.service.js', () => ({ settlementRuns: { inc: () => {} } }));
vi.mock('../../services/cache.service.js', () => ({ CacheService: { del: async () => {} } }));
vi.mock('../../domains/notification/realtimeEmitters.js', () => ({ emitPayoutSuccessBatch: async () => {} }));
vi.mock('../../domains/markets/cyclePool.service.js', () => ({ forgetCycle: () => {} }));
vi.mock('../../domains/risk/riskValidation.service.js', () => ({
  getRiskRules: async () => ({ winningsFeePercent: 1, payoutMultiplier: 2 }),
  // The REAL return shape, key for key. There is no `payout` key, and that is
  // the whole point: the engine used to read `p.payout` on this object in its
  // straggler sweep, so every bet that sweep settled as a winner was paid
  // `undefined ?? 0`. A faithful mock is what makes that assertable.
  computeWinningsPayout: ({ amount, feePercent, multiplier }) => {
    const grossMinor = Math.round(amount * 100) * multiplier;
    const feeMinor   = Math.floor((grossMinor * Math.round(feePercent * 100)) / 10000);
    const netMinor   = grossMinor - feeMinor;
    return {
      gross: grossMinor / 100, fee: feeMinor / 100, net: netMinor / 100,
      grossMinor, feeMinor, netMinor, feePercentApplied: feePercent,
    };
  },
}));

const GameEngine = (await import('../../domains/markets/gameEngine.js')).default;

/** Drive one settlement pass without the constructor's timers. */
const settle = (cycle = { cycleId: 'c1', winner: 'DELHI' }) =>
  GameEngine.prototype.processPayoutsOptimized.call({ io: null }, cycle);

/** A pending bet as `findPendingBetsForCycle` returns it. */
const bet = (betId, over = {}) => ({
  betId, userId: `u_${betId}`, side: 'DELHI', stakePaise: 10000,
  slices: [{ field: 'depositBalance', amountPaise: 10000 }], ...over,
});

const running = { ok: true, settlement: { status: 'RUNNING', winningSide: 'DELHI' } };

beforeEach(() => {
  pg.pending = []; pg.settled.length = 0; pg.resultFor = null;
  pg.totals = { paidRupees: 0, feeRupees: 0, winners: 0 };
  pg.statusWrites.length = 0;
  run.claim = running; run.finished.length = 0;
  alerts.sent.length = 0;
});

describe('paying the winning side', () => {
  it('pays the NET payout, not undefined', async () => {
    // ₹100 staked, 2x gross = ₹200, 1% fee = ₹2, so the player is owed ₹198.
    //
    // THE REGRESSION. `computeWinningsPayout` returns { gross, fee, net, … } and
    // has never had a `payout` key. The straggler sweep read `p?.payout ?? 0`
    // and handed ZERO down to a settle that stamps the bet WON and trusts the
    // number verbatim — so the bet was marked won, the fee was charged, and the
    // player was paid nothing. Making that sweep the only enumeration would
    // have made it every winner.
    pg.pending = [bet('b1')];
    await settle();

    expect(pg.settled).toHaveLength(1);
    expect(pg.settled[0]).toMatchObject({
      pgBetId: 'b1', outcome: 'WON', payoutRupees: 198, platformFeeRupees: 2,
    });
  });

  it('identifies the bet ENTIRELY from the row — id, owner and slices', async () => {
    // This mock answers where the real `settleBetOnPostgres` reads. It used to
    // take the owner off `bet.userId` unconditionally and threw
    // `Cannot read properties of null` for every `bet: null` caller — which is
    // every caller here. A mocked settle cannot catch that, so the unmocked
    // proof lives in settleFromPgRow.pg.test.js; what this pins is the
    // ARGUMENTS, so the engine cannot quietly stop supplying the owner.
    pg.pending = [bet('b1', { userId: 'u_owner' })];
    await settle();
    expect(pg.settled[0]).toMatchObject({
      bet: null,
      pgBetId:  'b1',
      pgUserId: 'u_owner',
      pgSlices: [{ field: 'depositBalance', amountPaise: 10000 }],
    });
  });

  it('settles a losing bet with no payout and no fee', async () => {
    pg.pending = [bet('b1', { side: 'BOMBAY' })];
    await settle();
    expect(pg.settled[0]).toMatchObject({
      pgBetId: 'b1', outcome: 'LOST', payoutRupees: 0, platformFeeRupees: 0,
    });
  });

  it('reads the bets ONCE, from Postgres, and settles each by its Postgres id', async () => {
    pg.pending = [bet('b1'), bet('b2', { side: 'BOMBAY' }), bet('b3')];
    await settle();
    // `bet: null` is the assertion that matters: the settle is driven by the
    // Postgres row, not by a Mongo document the engine had to go and fetch.
    expect(pg.settled.map((s) => [s.pgBetId, s.outcome, s.bet])).toEqual([
      ['b1', 'WON', null], ['b2', 'LOST', null], ['b3', 'WON', null],
    ]);
  });
});

describe('the claim is the lock', () => {
  it('refuses to run at all when the claim is refused', async () => {
    run.claim = { ok: false, reason: 'not_found' };
    await settle();
    expect(pg.settled).toHaveLength(0);
    expect(alerts.sent[0][0]).toBe('settlement-error');
  });

  it('does not re-settle a run that already COMPLETED', async () => {
    // The old Mongo lock filtered on `isSettled: PENDING|PROCESSING`, so a
    // finished cycle fell out. The run's status is the same guard, on the row
    // that actually owns the answer.
    pg.pending = [bet('b1')];
    run.claim = { ok: true, settlement: { status: 'COMPLETED', winningSide: 'DELHI' } };
    await settle();
    expect(pg.settled).toHaveLength(0);
    expect(run.finished).toHaveLength(0);
  });

  it('DOES continue a run that is merely RUNNING — a resume is not a refusal', async () => {
    // payoutRecoveryTask re-admits an interrupted payout on purpose. Backing off
    // here would strand exactly the cycles that need finishing, with player
    // stakes locked and nothing coming to release them.
    pg.pending = [bet('b1')];
    await settle();
    expect(pg.settled).toHaveLength(1);
  });

  it('settles against the side the RUN recorded, not the cycle\'s current winner', async () => {
    // An admin corrected the result after the first pass began. `winning_side`
    // is written once and never updated precisely so the resume cannot pay the
    // remaining bets on the other outcome — half the cycle settled one way and
    // half the other is not a state any reconciliation can unpick.
    pg.pending = [bet('b1', { side: 'DELHI' })];
    await settle({ cycleId: 'c1', winner: 'BOMBAY' });
    expect(pg.settled[0].outcome, 'the pass followed the corrected result').toBe('WON');
  });
});

describe('refusals', () => {
  it('reports them, and settles the rest of the cycle anyway', async () => {
    // A refused bet still has its stake locked. The pass continues because the
    // bets that did settle are settled and every transition is idempotent, so a
    // re-run advances only what is left — but it must never go unreported.
    pg.pending = [bet('b1'), bet('b2'), bet('b3')];
    pg.resultFor = (a) => (a.pgBetId === 'b2' ? { ok: false, reason: 'slices_mismatch' } : { ok: true });
    await settle();

    expect(pg.settled).toHaveLength(3);
    const alert = alerts.sent.find((a) => a[1]?.includes('refused bet settlements'));
    expect(alert?.[2]).toMatchObject({ cycleId: 'c1', refused: 1 });
  });

  it('does not alert when every bet settled', async () => {
    pg.pending = [bet('b1')];
    await settle();
    expect(alerts.sent).toHaveLength(0);
  });
});

describe('closing the cycle', () => {
  it('closes the run and archives the cycle, guarded on the states that may close', async () => {
    pg.pending = [bet('b1')];
    pg.totals = { paidRupees: 198, feeRupees: 2, winners: 1 };
    await settle();

    expect(run.finished[0]).toMatchObject({ cycleId: 'c1', payoutRupees: 198 });
    // Guarded, so a cancelled or already-archived cycle is not dragged back.
    expect(pg.statusWrites[0]).toMatchObject({
      cycleId: 'c1', to: 'COMPLETED', from: ['RESULT_DECLARED', 'CLOSED'],
    });
  });

  it('reports the totals DERIVED from the bets, not this pass\'s accumulators', async () => {
    // A resume only re-processes still-PENDING bets, so an accumulator would
    // undercount by everything the previous pass already paid. Here the pass
    // settles one bet but the table knows about three.
    pg.pending = [bet('b1')];
    pg.totals = { paidRupees: 594, feeRupees: 6, winners: 3 };
    await settle();
    expect(run.finished[0].payoutRupees).toBe(594);
  });
});
