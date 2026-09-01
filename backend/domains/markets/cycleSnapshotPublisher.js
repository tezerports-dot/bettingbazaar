// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
 * behind a WebSocket-blocking proxy has SSE as its sole transport. It is now
 * scoped the same way: `sseManager` gained cycle topics on 2026-09-01, so the
 * snapshot reaches the SSE clients watching that cycle rather than all of them
 * — see the flush() comment for what that was costing.
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
    /** cycleId -> { cycleType, totalDelhi, totalBombay, betCount, dirty, updatedAt } */
    this.snapshots = new Map();
    this.timer = null;
    this.metrics = { flushes: 0, snapshotsPublished: 0, betsCoalesced: 0, lastFlushSize: 0, pruned: 0 };
  }

  /** Wire the transports. Called once at server startup. */
  attach({ io, sseManager } = {}) {
    this.io = io || null;
    this.sseManager = sseManager || null;
    return this;
  }

  /**
   * Record one bet's post-$inc absolute totals. Coalesces: many bets in a window
   * collapse to the latest value. Does NOT emit — the timer does.
   */
  recordBet(cycleId, { cycleType, totalDelhi, totalBombay } = {}) {
    if (!cycleId) return;
    const prev = this.snapshots.get(cycleId);
    if (prev) this.metrics.betsCoalesced++;
    this.snapshots.set(cycleId, {
      cycleType: cycleType ?? prev?.cycleType,
      totalDelhi: Number(totalDelhi) || 0,
      totalBombay: Number(totalBombay) || 0,
      betCount: (prev?.betCount || 0) + 1,
      dirty: true,
      updatedAt: Date.now(),
    });
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
    return assertPublicCycleSafe({
      cycleId,
      cycleType: snap.cycleType,
      totalDelhi: snap.totalDelhi,
      totalBombay: snap.totalBombay,
      totalPool: snap.totalDelhi + snap.totalBombay,
      betCount: snap.betCount,
      ts: Date.now(),
    });
  }

  /** Emit every dirty cycle's snapshot once, then clear dirt and prune stale. */
  flush() {
    this.metrics.flushes++;
    const now = Date.now();
    let published = 0;

    for (const [cycleId, snap] of this.snapshots) {
      if (snap.dirty) {
        snap.dirty = false;
        const payload = this.buildPayload(cycleId, snap);

        // Canonical: room-scoped to watchers of this cycle.
        this.io?.to(`cycle:${cycleId}`).emit('pool_update', payload);

        // ── SSE bridge, now topic-scoped ───────────────────────────────────
        // The Socket.IO half of this bridge is GONE (2026-08-31): every socket
        // client ships `watch_cycle` + `pool_update` (GameContext.tsx), so the
        // global `io.emit` was sending each live cycle's snapshot to every
        // connected client on top of the room-scoped one they already had.
        //
        // The SSE half stays, because `pool_update` travels through Socket.IO
        // rooms only and the browser socket is WebSocket-only
        // (`transports: ['websocket'], upgrade: false`) — a client behind a
        // proxy that blocks WebSocket has SSE as its ONLY live-pool path, and
        // removing this would stop pool movement for exactly the users least
        // able to report why.
        //
        // What HAS changed is who receives it (2026-09-01). It used to be
        // `sseManager.broadcast`, and the user panel opens its EventSource
        // unconditionally — `SSEEventBridge` connects in its constructor, with
        // no "only if the socket failed" branch — so this was not serving a
        // blocked minority. It was sending every live cycle's snapshot to
        // EVERY connected client, in addition to the room-scoped `pool_update`
        // the same client was already processing on its socket. With three
        // boards live that is 3 duplicated deliveries per client per second,
        // and the client normalises the field names of the two copies against
        // each other to reconcile them.
        //
        // `sseManager` now has cycle topics, so this reaches only the clients
        // that asked for THIS cycle — which, per the default in
        // `sse.routes.js`, is only those without a working WebSocket.
        const legacy = { cycleId, cycleType: snap.cycleType, newTotalDelhi: snap.totalDelhi, newTotalBombay: snap.totalBombay };
        this.sseManager?.broadcastToCycle(cycleId, 'bet_placed', legacy);

        published++;
      } else if (now - snap.updatedAt > STALE_AFTER_MS) {
        // Betting closed on this cycle a while ago — stop tracking it so the map
        // can't grow without bound across the day's cycles.
        this.snapshots.delete(cycleId);
        this.metrics.pruned++;
      }
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
  forget(cycleId) { this.snapshots.delete(cycleId); }

  /** Observability snapshot for the metrics endpoint. */
  stats() { return { ...this.metrics, trackedCycles: this.snapshots.size, intervalMs: PUBLISH_INTERVAL_MS }; }

  /** Graceful shutdown. */
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}

/** Process-wide singleton — there is exactly ONE publisher (design item 11). */
export const cycleSnapshotPublisher = new CycleSnapshotPublisher();
