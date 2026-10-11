// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/markets/cycleSnapshotPublisher.js — the realtime cost/concurrency fix.
 *
 * THE PROBLEM IT SOLVES
 * Every bet used to fan out a `bet_placed` event to EVERY connected client, on
 * BOTH transports (Socket.IO `io.emit` + the SSE bridge). At the target load —
 * ~500–800 bets/sec against ~2,000 concurrent users — that is on the order of a
 * MILLION message deliveries per second, pure realtime fan-out, before a single
 * useful thing is computed. That is what drains CPU, saturates the network, and
 * makes the box fall over under a traffic spike.
 *
 * THE FIX (state-snapshot, not per-event)
 * Bets update an IN-MEMORY aggregate keyed by cycleId (absolute pool totals, so
 * a coalesced update is idempotent — the newest value is the whole truth). ONE
 * timer publishes at most one snapshot per live cycle per interval (default 1s),
 * no matter how many bets landed in between. 800 bets in a second become ONE
 * snapshot. The publish rate is now bounded by (live cycles × 1/interval) — two
 * cycles, so ~2 messages/sec of ORIGIN work — instead of (bets/sec × users).
 *
 * This is the dominant lever: it cuts the delivery count ~99.7% on BOTH
 * transports and needs no new infrastructure (no Kafka, no broker, no second
 * realtime box). Room-scoping (below) trims the remaining fan-out from "every
 * connected user" to "users watching THIS cycle", a smaller additional win that
 * the Socket.IO Redis adapter already carries across instances for free.
 *
 * WHY IN-MEMORY AND NOT "query the DB every second"
 * The authoritative pools live on the Cycle document (the bet route's atomic
 * $inc). Re-reading them every second would be a needless DB poll. Instead the
 * bet route hands us the post-$inc totals it already computed; we just hold the
 * latest per cycle and publish it. The snapshot is a READ-ONLY projection — it
 * is NEVER an authority and changes no money/settlement semantics.
 *
 * POOL SAFETY (non-negotiable)
 * Every payload goes through assertPublicCycleSafe (cyclePublicView.js), which
 * throws if a real/phantom field is ever present. The public can only ever see
 * TOTAL pools (real + phantom), never the real or phantom breakdown.
 *
 * ROLLOUT SAFETY
 * The canonical event is `pool_update`, scoped to the `cycle:<cycleId>` room.
 * The Socket.IO clients have all migrated to `watch_cycle` + `pool_update`, so
 * the global `io.emit('bet_placed')` bridge was removed on 2026-08-31: with
 * three boards live it delivered every cycle's snapshot to every connected
 * client on top of the room-scoped copy they already had.
 *
 * The SSE bridge is NOT a leftover and stays. `pool_update` travels through
 * Socket.IO rooms only, and the browser socket is WebSocket-only, so a client
 * behind a WebSocket-blocking proxy has SSE as its sole transport. `sseManager`
 * has no room concept to scope it to — see the flush() comment. *
 * ONE SSE MESSAGE PER TICK, CLUSTER-WIDE (2026-10-11)
 * Since 2026-10-10 the SSE `bet_placed` is the player app's only pool feed. It
 * used to go out once per dirty cycle per worker, and `sseManager.broadcast`
 * relays each copy to every other worker, so every stream received
 * (live cycles × workers) messages a second, each one gzip-flushed separately
 * (`eventStreamCompression`). Measured locally: 1.63 million deliveries in 65 s
 * for ONE live cycle on three workers with 10,000 streams, and bet p95 went
 * from 38 ms to 9.8 s. Now each worker shares its dirty snapshots with the
 * others (`sseManager.sharePeer`, written to no client), keeps the newest per
 * cycle, and on its own tick sends its own streams ONE `bet_placed` carrying
 * every changed cycle: `{ pools: [ … ] }`.
 */
import { assertPublicCycleSafe } from './cyclePublicView.js';

/** Publish cadence. 1s per the design; env-overridable for load tests. */
const PUBLISH_INTERVAL_MS = Math.max(100, Number(process.env.CYCLE_SNAPSHOT_INTERVAL_MS) || 1000);
/** A cycle with no bet for this long is pruned from the in-memory map. */
const STALE_AFTER_MS = Math.max(60_000, Number(process.env.CYCLE_SNAPSHOT_STALE_MS) || 120_000);

export class CycleSnapshotPublisher {
  constructor() {
    this.io = null;
    this.sseManager = null;
    /** cycleId -> { cycleType, totalDelhi, totalBombay, poolsHidden, betCount, dirty, updatedAt } */
    this.snapshots = new Map();
    /** cycleId -> { pool, ts } — newest snapshot each other worker shared since the last flush. */
    this.peerPools = new Map();
    /** cycleId -> ts of the snapshot last sent to this worker's streams (never send an older one after it). */
    this.sentTs = new Map();
    this.timer = null;
    this.metrics = { flushes: 0, snapshotsPublished: 0, betsCoalesced: 0, lastFlushSize: 0, pruned: 0 };
  }

  /** Wire the transports. Called once at server startup. */
  attach({ io, sseManager } = {}) {
    this.io = io || null;
    this.sseManager = sseManager || null;
    this.sseManager?.onPeer?.('cycle_pools', (items) => this.ingestPeer(items));
    return this;
  }

  /**
   * Record one bet's post-$inc absolute totals. Coalesces: many bets in a window
   * collapse to the latest value. Does NOT emit — the timer does.
   * `poolsHidden` is the cycle's, from `cyclePublicView.poolsHidden`: when set,
   * the payload carries the total alone.
   */
  recordBet(cycleId, { cycleType, totalDelhi, totalBombay, poolsHidden = false } = {}) {
    if (!cycleId) return;
    const prev = this.snapshots.get(cycleId);
    if (prev) this.metrics.betsCoalesced++;
    this.snapshots.set(cycleId, {
      cycleType: cycleType ?? prev?.cycleType,
      totalDelhi: Number(totalDelhi) || 0,
      totalBombay: Number(totalBombay) || 0,
      poolsHidden: poolsHidden === true,
      betCount: (prev?.betCount || 0) + 1,
      dirty: true,
      updatedAt: Date.now(),
    });
  }

  /**
   * Snapshots another worker flushed. Held until this worker's next flush,
   * which sends them to its own streams in the same message as its own.
   */
  ingestPeer(items) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const cycleId = item?.pool?.cycleId;
      const ts = Number(item?.ts) || 0;
      if (typeof cycleId !== 'string' || !cycleId) continue;
      const prev = this.peerPools.get(cycleId);
      if (prev && prev.ts > ts) continue;
      try {
        this.peerPools.set(cycleId, { pool: assertPublicCycleSafe(item.pool), ts });
      } catch (e) {
        console.warn('[cycleSnapshot] refused a peer snapshot:', e.message);
      }
    }
  }

  /** Start the single publisher timer. Idempotent. */
  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => {
      try { this.flush(); } catch (e) { console.warn('[cycleSnapshot] flush error:', e.message); }
    }, PUBLISH_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
    console.log(`✅ Cycle snapshot publisher: coalescing bets into ≤1 snapshot / ${PUBLISH_INTERVAL_MS}ms per live cycle`);
    return this;
  }

  /**
   * Build the canonical public payload for a cycle. Totals only; the client
   * derives ratios/percentages itself, so the wire stays tiny. Guarded.
   */
  buildPayload(cycleId, snap) {
    const totalPool = snap.totalDelhi + snap.totalBombay;
    const pools = snap.poolsHidden
      ? { poolsHidden: true, totalPool }
      : { poolsHidden: false, totalDelhi: snap.totalDelhi, totalBombay: snap.totalBombay, totalPool };
    return assertPublicCycleSafe({
      cycleId,
      cycleType: snap.cycleType,
      ...pools,
      betCount: snap.betCount,
      ts: Date.now(),
    });
  }

  /**
   * Emit every dirty cycle's snapshot once, send this worker's streams ONE
   * `bet_placed` with every changed cycle (its own and its peers'), then clear
   * dirt and prune stale.
   */
  flush() {
    this.metrics.flushes++;
    const now = Date.now();
    let published = 0;
    /** cycleId -> { pool, ts } to send this tick. */
    const outgoing = new Map();
    const shared = [];

    for (const [cycleId, snap] of this.snapshots) {
      if (snap.dirty) {
        snap.dirty = false;
        const payload = this.buildPayload(cycleId, snap);

        // Canonical: room-scoped to watchers of this cycle. The Socket.IO Redis
        // adapter carries it to the other workers' rooms.
        this.io?.to(`cycle:${cycleId}`).emit('pool_update', payload);

        // The SSE feed. Not a leftover: since 2026-10-10 the player app opens
        // no socket, so this is its only live-pool feed. `sseManager` has no
        // room concept, so it reaches every stream; one message per tick keeps
        // that affordable (see the header).
        const pool = assertPublicCycleSafe(snap.poolsHidden
          ? { cycleId, cycleType: snap.cycleType, poolsHidden: true, totalPool: payload.totalPool }
          : { cycleId, cycleType: snap.cycleType, newTotalDelhi: snap.totalDelhi, newTotalBombay: snap.totalBombay });
        outgoing.set(cycleId, { pool, ts: snap.updatedAt });
        shared.push({ pool, ts: snap.updatedAt });

        published++;
      } else if (now - snap.updatedAt > STALE_AFTER_MS) {
        // Betting closed on this cycle a while ago — stop tracking it so the map
        // can't grow without bound across the day's cycles.
        this.snapshots.delete(cycleId);
        this.metrics.pruned++;
      }
    }

    if (shared.length) this.sseManager?.sharePeer?.('cycle_pools', shared);

    // A peer's snapshot of the same cycle wins when it is newer: each worker
    // holds the totals of the last bet IT placed.
    for (const [cycleId, peer] of this.peerPools) {
      const mine = outgoing.get(cycleId);
      if (!mine || peer.ts > mine.ts) outgoing.set(cycleId, peer);
    }
    this.peerPools.clear();

    const pools = [];
    for (const [cycleId, { pool, ts }] of outgoing) {
      if ((this.sentTs.get(cycleId) ?? -Infinity) > ts) continue; // already sent newer totals
      this.sentTs.set(cycleId, ts);
      pools.push(pool);
    }
    if (pools.length) this.sseManager?.broadcastLocal?.('bet_placed', { pools });
    for (const [cycleId, ts] of this.sentTs) {
      if (now - ts > STALE_AFTER_MS) this.sentTs.delete(cycleId);
    }

    this.metrics.lastFlushSize = published;
    this.metrics.snapshotsPublished += published;
  }

  /** Current in-memory snapshot for a cycle (used to seed a fresh watcher). */
  peek(cycleId) {
    const snap = this.snapshots.get(cycleId);
    return snap ? this.buildPayload(cycleId, snap) : null;
  }

  /** Drop a cycle immediately (e.g. on RESULT_DECLARED). */
  forget(cycleId) { this.snapshots.delete(cycleId); this.peerPools.delete(cycleId); this.sentTs.delete(cycleId); }

  /** Observability snapshot for the metrics endpoint. */
  stats() { return { ...this.metrics, trackedCycles: this.snapshots.size, intervalMs: PUBLISH_INTERVAL_MS }; }

  /** Graceful shutdown. */
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}

/** Process-wide singleton — there is exactly ONE publisher (design item 11). */
export const cycleSnapshotPublisher = new CycleSnapshotPublisher();
