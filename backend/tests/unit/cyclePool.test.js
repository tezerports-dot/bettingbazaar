// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * Unit tests for the derived cycle-pool projection.
 *
 * The property that matters most here is the one about the flag being OFF:
 * this is a money path, and a dormant feature that quietly changes behaviour
 * before anyone opts into it is worse than no feature. Several of these tests
 * exist purely to prove the no-op.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import mongoose from 'mongoose';
import {
  computeRealPools,
  refreshRealPools,
  derivedPoolsEnabled,
  forgetCycle,
  _resetPoolMemo,
} from '../../domains/markets/cyclePool.service.js';
import { FLAGS, override } from '../../services/featureFlags.service.js';

/** Records what the aggregation was asked for, and replays a canned answer. */
function stubModels({ betRows = [], cycleDoc = {} } = {}) {
  const calls = { aggregate: [], cycleUpdates: [] };

  const betModel = {
    aggregate: (pipeline) => {
      calls.aggregate.push(pipeline);
      return {
        readConcern() { return this; },
        exec: async () => betRows,
      };
    },
  };

  const cycleModel = {
    findOneAndUpdate: async (filter, update) => {
      calls.cycleUpdates.push({ filter, update });
      return cycleDoc === null ? null : { ...cycleDoc };
    },
  };

  vi.spyOn(mongoose, 'model').mockImplementation((name) => {
    if (name === 'Bet') return betModel;
    if (name === 'Cycle') return cycleModel;
    throw new Error(`unexpected model: ${name}`);
  });

  return calls;
}

beforeEach(() => {
  _resetPoolMemo();
  override(FLAGS.DERIVED_CYCLE_POOLS, false);
});

afterEach(() => {
  vi.restoreAllMocks();
  override(FLAGS.DERIVED_CYCLE_POOLS, false);
});

describe('flag off — the feature must be inert', () => {
  it('reports disabled by default', async () => {
    expect(await derivedPoolsEnabled()).toBe(false);
  });

  it('refreshRealPools writes nothing and returns null', async () => {
    const calls = stubModels({ betRows: [{ _id: 'DELHI', total: 999 }] });
    const result = await refreshRealPools('c1');
    expect(result).toBeNull();
    expect(calls.cycleUpdates).toHaveLength(0);
    // Must not even aggregate — the flag check comes first, so a disabled
    // deployment pays nothing for this code being present.
    expect(calls.aggregate).toHaveLength(0);
  });
});

describe('computeRealPools', () => {
  beforeEach(() => override(FLAGS.DERIVED_CYCLE_POOLS, true));

  it('sums each side independently', async () => {
    stubModels({ betRows: [{ _id: 'DELHI', total: 300 }, { _id: 'BOMBAY', total: 175 }] });
    expect(await computeRealPools('c1')).toEqual({ realDelhi: 300, realBombay: 175 });
  });

  it('returns zeros for a cycle with no bets rather than undefined', async () => {
    stubModels({ betRows: [] });
    expect(await computeRealPools('c1')).toEqual({ realDelhi: 0, realBombay: 0 });
  });

  it('excludes phantom bets — phantom pools are a separate, non-derived field', async () => {
    const calls = stubModels({ betRows: [] });
    await computeRealPools('c1');
    expect(calls.aggregate[0][0].$match.isPhantom).toBe(false);
  });

  it('excludes REFUNDED bets — a refunded stake is no longer in the pool', async () => {
    const calls = stubModels({ betRows: [] });
    await computeRealPools('c1');
    expect(calls.aggregate[0][0].$match.status).toEqual({ $ne: 'REFUNDED' });
  });

  it('counts WON and LOST, not just PENDING', async () => {
    // netProfit reads the pool AFTER settlement has relabelled every bet.
    // Matching on PENDING would make the pool collapse to zero at exactly the
    // moment it is converted into platform revenue.
    const calls = stubModels({ betRows: [] });
    await computeRealPools('c1');
    const match = calls.aggregate[0][0].$match;
    expect(match.status).not.toBe('PENDING');
    expect(JSON.stringify(match)).not.toContain('PENDING');
  });

  it('uses majority read concern only when exact is requested', async () => {
    const seen = [];
    vi.spyOn(mongoose, 'model').mockImplementation(() => ({
      aggregate: () => ({
        readConcern(level) { seen.push(level); return this; },
        exec: async () => [],
      }),
    }));
    await computeRealPools('c1', { exact: true });
    await computeRealPools('c1');
    expect(seen).toEqual(['majority', 'local']);
  });
});

describe('refreshRealPools', () => {
  beforeEach(() => override(FLAGS.DERIVED_CYCLE_POOLS, true));

  it('writes the derived reals and re-derives the totals from stored phantom', async () => {
    const calls = stubModels({
      betRows: [{ _id: 'DELHI', total: 500 }, { _id: 'BOMBAY', total: 200 }],
      cycleDoc: { cycleId: 'c1' },
    });

    const pools = await refreshRealPools('c1');
    expect(pools).toEqual({ realDelhi: 500, realBombay: 200 });

    const [stageReal, stageTotal] = calls.cycleUpdates[0].update;
    expect(stageReal.$set).toEqual({ realDelhi: 500, realBombay: 200 });
    // The totals must be computed against the phantom values AS STORED at write
    // time ($ifNull on the live field), never against a value read earlier —
    // otherwise an equalizer run landing in between is silently discarded.
    expect(stageTotal.$set.totalDelhi.$add[1]).toEqual({ $ifNull: ['$phantomDelhi', 0] });
    expect(stageTotal.$set.totalBombay.$add[1]).toEqual({ $ifNull: ['$phantomBombay', 0] });
  });

  it('memoises within the freshness window so a bet burst is not a write burst', async () => {
    const calls = stubModels({ betRows: [{ _id: 'DELHI', total: 10 }], cycleDoc: { cycleId: 'c1' } });
    for (let i = 0; i < 25; i++) await refreshRealPools('c1');
    expect(calls.cycleUpdates).toHaveLength(1);
  });

  it('exact bypasses the memo — the money-critical reads never serve a cache', async () => {
    const calls = stubModels({ betRows: [{ _id: 'DELHI', total: 10 }], cycleDoc: { cycleId: 'c1' } });
    await refreshRealPools('c1');
    await refreshRealPools('c1', { exact: true });
    await refreshRealPools('c1', { exact: true });
    expect(calls.cycleUpdates).toHaveLength(3);
  });

  it('force bypasses the memo', async () => {
    const calls = stubModels({ betRows: [], cycleDoc: { cycleId: 'c1' } });
    await refreshRealPools('c1');
    await refreshRealPools('c1', { force: true });
    expect(calls.cycleUpdates).toHaveLength(2);
  });

  it('does not memoise a cycle that no longer exists', async () => {
    const calls = stubModels({ betRows: [], cycleDoc: null });
    expect(await refreshRealPools('gone')).toBeNull();
    expect(await refreshRealPools('gone')).toBeNull();
    expect(calls.cycleUpdates).toHaveLength(2);
  });

  it('forgetCycle drops the memo so a settled cycle cannot serve a stale projection', async () => {
    const calls = stubModels({ betRows: [], cycleDoc: { cycleId: 'c1' } });
    await refreshRealPools('c1');
    await refreshRealPools('c1');
    expect(calls.cycleUpdates).toHaveLength(1);
    forgetCycle('c1');
    await refreshRealPools('c1');
    expect(calls.cycleUpdates).toHaveLength(2);
  });

  it('returns null for a missing cycleId instead of aggregating over everything', async () => {
    const calls = stubModels({ betRows: [] });
    expect(await refreshRealPools('')).toBeNull();
    expect(calls.aggregate).toHaveLength(0);
  });

  it('keeps each cycle memoised separately', async () => {
    const calls = stubModels({ betRows: [], cycleDoc: { cycleId: 'x' } });
    await refreshRealPools('c1');
    await refreshRealPools('c2');
    await refreshRealPools('c1');
    expect(calls.cycleUpdates).toHaveLength(2);
  });
});
