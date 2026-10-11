// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The realtime cost fix, pinned. The publisher must:
 *   • COALESCE — many bets in one window collapse to ONE snapshot carrying the
 *     LATEST absolute totals (this is the ~99.7% delivery cut).
 *   • emit only DIRTY cycles (an idle second sends nothing).
 *   • never leak real/phantom — every payload goes through assertPublicCycleSafe.
 *   • scope to the cycle room, and send the SSE streams ONE `bet_placed` per
 *     tick carrying every changed cycle, its own and other workers'.
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
  const sseManager = { broadcast: vi.fn(), broadcastLocal: vi.fn(), sharePeer: vi.fn(), onPeer: vi.fn() };
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

  it('sends NO global socket broadcast — socket clients get the room-scoped pool_update', () => {
    // The global `io.emit('bet_placed')` was a migration bridge for clients
    // that had not adopted watch_cycle/pool_update. They all have, so with
    // three boards live it delivered every cycle's snapshot to every connected
    // client on top of the room-scoped copy they already had.
    //
    // Asserted as an ABSENCE because re-adding it would look like a fix — the
    // event name is still live on the SSE transport below, so a future reader
    // finding "bet_placed" in the codebase could reasonably conclude the socket
    // emit was dropped by mistake.
    const h = harness();
    h.pub.recordBet('c1', { cycleType: '30_MIN', totalDelhi: 10, totalBombay: 5 });
    h.pub.recordBet('c1', { cycleType: '30_MIN', totalDelhi: 20, totalBombay: 5 });
    h.pub.flush();

    expect(h.globalEmits.filter((e) => e.event === 'bet_placed')).toHaveLength(0);
    // The room-scoped snapshot is still delivered, once.
    expect(h.poolUpdates()).toHaveLength(1);
  });

  it('KEEPS the coalesced SSE bet_placed — it is the only live-pool feed without a socket', () => {
    // Not a leftover half of the removal above. Since 2026-10-10 the player
    // app opens no socket, so this is its only live-pool feed.
    const h = harness();
    h.pub.recordBet('c1', { cycleType: '30_MIN', totalDelhi: 10, totalBombay: 5 });
    h.pub.recordBet('c1', { cycleType: '30_MIN', totalDelhi: 20, totalBombay: 5 });
    h.pub.flush();

    expect(h.sseManager.broadcastLocal).toHaveBeenCalledTimes(1);   // coalesced, not per-bet
    expect(h.sseManager.broadcastLocal).toHaveBeenCalledWith('bet_placed', {
      pools: [expect.objectContaining({ cycleId: 'c1', newTotalDelhi: 20, newTotalBombay: 5 })],
    });
    // Never relayed as a delivery: each worker sends its own streams one message.
    expect(h.sseManager.broadcast).not.toHaveBeenCalled();
  });

  it('a hidden cycle\'s snapshot carries the total alone, on the room and on SSE', () => {
    const h = harness();
    h.pub.recordBet('c1', { cycleType: '30_MIN', totalDelhi: 1200, totalBombay: 800, poolsHidden: true });
    h.pub.flush();
    const [pu] = h.poolUpdates();
    expect(pu.payload).toMatchObject({ cycleId: 'c1', poolsHidden: true, totalPool: 2000 });
    for (const f of ['totalDelhi', 'totalBombay', 'delhiPool', 'bombayPool']) expect(pu.payload).not.toHaveProperty(f);
    const [, sse] = h.sseManager.broadcastLocal.mock.calls[0];
    expect(sse.pools).toEqual([{ cycleId: 'c1', cycleType: '30_MIN', poolsHidden: true, totalPool: 2000 }]);
    // A watcher who joins now is seeded with the same.
    expect(h.pub.peek('c1')).not.toHaveProperty('totalDelhi');
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

describe('CycleSnapshotPublisher — one SSE message per tick, cluster-wide', () => {
  // Every stream used to get (live cycles × workers) messages a second, each
  // gzip-flushed on its own: at 10,000 streams bet p95 went from 38 ms to 9.8 s.
  const peerItem = (cycleId, totalDelhi, totalBombay, ts) => ({
    pool: { cycleId, cycleType: '30_MIN', newTotalDelhi: totalDelhi, newTotalBombay: totalBombay }, ts,
  });

  it('sends every changed cycle in ONE message', () => {
    const h = harness();
    h.pub.recordBet('c30', { cycleType: '30_MIN', totalDelhi: 1, totalBombay: 2 });
    h.pub.recordBet('cFD', { cycleType: 'FULL_DAY', totalDelhi: 3, totalBombay: 4 });
    h.pub.flush();
    expect(h.sseManager.broadcastLocal).toHaveBeenCalledTimes(1);
    const [, { pools }] = h.sseManager.broadcastLocal.mock.calls[0];
    expect(pools.map((p) => p.cycleId).sort()).toEqual(['c30', 'cFD']);
  });

  it('shares its own dirty snapshots with the other workers, written to no client', () => {
    const h = harness();
    h.pub.recordBet('c1', { cycleType: '30_MIN', totalDelhi: 7, totalBombay: 3 });
    h.pub.flush();
    expect(h.sseManager.sharePeer).toHaveBeenCalledTimes(1);
    const [kind, items] = h.sseManager.sharePeer.mock.calls[0];
    expect(kind).toBe('cycle_pools');
    expect(items).toEqual([{ pool: expect.objectContaining({ cycleId: 'c1', newTotalDelhi: 7 }), ts: expect.any(Number) }]);

    h.pub.flush(); // nothing new → nothing shared, nothing sent
    expect(h.sseManager.sharePeer).toHaveBeenCalledTimes(1);
    expect(h.sseManager.broadcastLocal).toHaveBeenCalledTimes(1);
  });

  it('subscribes to its peers on attach', () => {
    const h = harness();
    expect(h.sseManager.onPeer).toHaveBeenCalledWith('cycle_pools', expect.any(Function));
  });

  it('sends a peer\'s snapshot in the same message as its own, and does not re-share it', () => {
    const h = harness();
    h.pub.recordBet('mine', { cycleType: '30_MIN', totalDelhi: 1, totalBombay: 1 });
    h.pub.ingestPeer([peerItem('theirs', 50, 60, Date.now())]);
    h.pub.flush();
    expect(h.sseManager.broadcastLocal).toHaveBeenCalledTimes(1);
    const [, { pools }] = h.sseManager.broadcastLocal.mock.calls[0];
    expect(pools.map((p) => p.cycleId).sort()).toEqual(['mine', 'theirs']);
    const [, shared] = h.sseManager.sharePeer.mock.calls[0];
    expect(shared.map((i) => i.pool.cycleId)).toEqual(['mine']);
    // A peer's snapshot is sent once.
    h.pub.flush();
    expect(h.sseManager.broadcastLocal).toHaveBeenCalledTimes(1);
  });

  it('a peer\'s newer totals for the same cycle win; older ones are never sent after newer', () => {
    const h = harness();
    h.pub.recordBet('c1', { cycleType: '30_MIN', totalDelhi: 10, totalBombay: 10 });
    const mineTs = h.pub.snapshots.get('c1').updatedAt;
    h.pub.ingestPeer([peerItem('c1', 30, 30, mineTs + 5)]);
    h.pub.flush();
    expect(h.sseManager.broadcastLocal.mock.calls[0][1].pools).toEqual([
      expect.objectContaining({ cycleId: 'c1', newTotalDelhi: 30, newTotalBombay: 30 }),
    ]);

    // A late peer message carrying older totals is dropped.
    h.pub.ingestPeer([peerItem('c1', 20, 20, mineTs + 1)]);
    h.pub.flush();
    expect(h.sseManager.broadcastLocal).toHaveBeenCalledTimes(1);
  });

  it('keeps the newest of several peer snapshots for one cycle', () => {
    const h = harness();
    const t = Date.now();
    h.pub.ingestPeer([peerItem('c1', 40, 40, t + 2), peerItem('c1', 10, 10, t + 1)]);
    h.pub.flush();
    expect(h.sseManager.broadcastLocal.mock.calls[0][1].pools).toEqual([
      expect.objectContaining({ newTotalDelhi: 40 }),
    ]);
  });

  it('refuses a peer snapshot that carries a real or phantom field', () => {
    const h = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.pub.ingestPeer([{ pool: { cycleId: 'c1', cycleType: '30_MIN', realDelhi: 5 }, ts: Date.now() }]);
    warn.mockRestore();
    h.pub.flush();
    expect(h.sseManager.broadcastLocal).not.toHaveBeenCalled();
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
