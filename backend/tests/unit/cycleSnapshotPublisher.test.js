// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The realtime cost fix, pinned. The publisher must:
 *   • COALESCE — many bets in one window collapse to ONE snapshot carrying the
 *     LATEST absolute totals (this is the ~99.7% delivery cut).
 *   • emit only DIRTY cycles (an idle second sends nothing).
 *   • never leak real/phantom — every payload goes through assertPublicCycleSafe.
 *   • scope to the cycle room, with the coalesced global `bet_placed` bridge for
 *     un-migrated clients.
 *   • prune cycles that stopped receiving bets, so the map can't grow unbounded.
 */
import { describe, it, expect, vi } from 'vitest';
import { CycleSnapshotPublisher } from '../../domains/markets/cycleSnapshotPublisher.js';

function harness() {
  const roomEmits = [];
  const globalEmits = [];
  const io = {
    to(room) { return { emit(event, payload) { roomEmits.push({ room, event, payload }); } }; },
    emit(event, payload) { globalEmits.push({ event, payload }); },
  };
  const sseManager = { broadcast: vi.fn() };
  const pub = new CycleSnapshotPublisher().attach({ io, sseManager });
  return { pub, io, sseManager, roomEmits, globalEmits,
    poolUpdates: () => roomEmits.filter((e) => e.event === 'pool_update') };
}

describe('CycleSnapshotPublisher — coalescing', () => {
  it('collapses many bets into ONE snapshot with the latest totals', () => {
    const h = harness();
    h.pub.recordBet('c1', { cycleType: '30_MIN', totalDelhi: 100, totalBombay: 0 });
    h.pub.recordBet('c1', { cycleType: '30_MIN', totalDelhi: 250, totalBombay: 50 });
    h.pub.recordBet('c1', { cycleType: '30_MIN', totalDelhi: 300, totalBombay: 80 });

    h.pub.flush();

    const pu = h.poolUpdates();
    expect(pu).toHaveLength(1);                 // 3 bets → 1 emit
    expect(pu[0].room).toBe('cycle:c1');        // room-scoped to watchers
    expect(pu[0].payload.totalDelhi).toBe(300); // latest wins (absolute)
    expect(pu[0].payload.totalBombay).toBe(80);
    expect(pu[0].payload.totalPool).toBe(380);
    expect(pu[0].payload.betCount).toBe(3);
  });

  it('bridges a single coalesced bet_placed to global io + SSE for legacy clients', () => {
    const h = harness();
    h.pub.recordBet('c1', { cycleType: '30_MIN', totalDelhi: 10, totalBombay: 5 });
    h.pub.recordBet('c1', { cycleType: '30_MIN', totalDelhi: 20, totalBombay: 5 });
    h.pub.flush();

    const legacy = h.globalEmits.filter((e) => e.event === 'bet_placed');
    expect(legacy).toHaveLength(1);                       // coalesced, not per-bet
    expect(legacy[0].payload.newTotalDelhi).toBe(20);
    expect(h.sseManager.broadcast).toHaveBeenCalledTimes(1);
    expect(h.sseManager.broadcast).toHaveBeenCalledWith('bet_placed', expect.objectContaining({ cycleId: 'c1', newTotalBombay: 5 }));
  });

  it('emits only dirty cycles — an idle flush sends nothing', () => {
    const h = harness();
    h.pub.recordBet('c1', { cycleType: '30_MIN', totalDelhi: 1, totalBombay: 1 });
    h.pub.flush();
    expect(h.poolUpdates()).toHaveLength(1);

    h.pub.flush(); // no new bets
    expect(h.poolUpdates()).toHaveLength(1); // unchanged
  });

  it('keeps two live cycles independent — one snapshot each per flush', () => {
    const h = harness();
    h.pub.recordBet('c30', { cycleType: '30_MIN', totalDelhi: 100, totalBombay: 200 });
    h.pub.recordBet('cFD', { cycleType: 'FULL_DAY', totalDelhi: 9, totalBombay: 1 });
    h.pub.flush();

    const pu = h.poolUpdates();
    expect(pu).toHaveLength(2);
    expect(pu.map((e) => e.room).sort()).toEqual(['cycle:c30', 'cycle:cFD']);
  });
});

describe('CycleSnapshotPublisher — pool safety', () => {
  it('never emits a real/phantom field (public sees totals only)', () => {
    const h = harness();
    h.pub.recordBet('c1', { cycleType: '30_MIN', totalDelhi: 700, totalBombay: 300 });
    h.pub.flush();
    const payload = h.poolUpdates()[0].payload;
    for (const k of Object.keys(payload)) {
      expect(k).not.toMatch(/real|phantom/i);
    }
  });
});

describe('CycleSnapshotPublisher — housekeeping', () => {
  it('peek returns the current snapshot, or null for an unknown cycle', () => {
    const h = harness();
    h.pub.recordBet('c9', { cycleType: '30_MIN', totalDelhi: 5, totalBombay: 7 });
    expect(h.pub.peek('c9').totalPool).toBe(12);
    expect(h.pub.peek('nope')).toBeNull();
  });

  it('prunes a cycle that stopped receiving bets', () => {
    const h = harness();
    h.pub.recordBet('old', { cycleType: '30_MIN', totalDelhi: 1, totalBombay: 1 });
    const snap = h.pub.snapshots.get('old');
    snap.dirty = false;                       // already published
    snap.updatedAt = Date.now() - 10 * 60_000; // 10 min ago → stale
    h.pub.flush();
    expect(h.pub.snapshots.has('old')).toBe(false);
  });

  it('forget() drops a cycle immediately (e.g. on RESULT_DECLARED)', () => {
    const h = harness();
    h.pub.recordBet('c1', { cycleType: '30_MIN', totalDelhi: 1, totalBombay: 1 });
    h.pub.forget('c1');
    expect(h.pub.peek('c1')).toBeNull();
  });

  it('reports observability counters', () => {
    const h = harness();
    h.pub.recordBet('c1', { cycleType: '30_MIN', totalDelhi: 1, totalBombay: 1 });
    h.pub.recordBet('c1', { cycleType: '30_MIN', totalDelhi: 2, totalBombay: 1 });
    h.pub.flush();
    const s = h.pub.stats();
    expect(s.snapshotsPublished).toBe(1);
    expect(s.betsCoalesced).toBe(1); // the 2nd bet coalesced into the 1st
    expect(s.trackedCycles).toBe(1);
  });
});
