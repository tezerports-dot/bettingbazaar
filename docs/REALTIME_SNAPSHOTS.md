# Realtime delivery: coalesced snapshots, not per-bet broadcasts

**Goal:** cut server cost and raise concurrency headroom on the live path, with
no new infrastructure, without touching money/settlement semantics.

## The problem

Every bet used to fan a `bet_placed` event out to **every** connected client, on
**both** transports (`io.emit` + the SSE bridge). At the target load —
~500–800 bets/sec against ~2,000 concurrent users — that is on the order of a
**million message deliveries per second** of pure realtime fan-out. That is what
drains CPU, saturates the NIC, and makes the box fall over on a traffic spike.
`bet.routes.js` was the source; `GameContext.tsx` was the consumer (it already
throttled 200ms *client-side*, which does nothing for the *server's* cost).

## The fix (state-snapshot, not per-event)

The dominant lever is **coalescing**, and it is transport-agnostic:

- `domains/markets/cycleSnapshotPublisher.js` holds an **in-memory** aggregate
  per cycle. Each bet hands it the post-`$inc` **absolute** totals the bet route
  already computed (no extra DB read — item 6), and marks the cycle dirty.
- **One** timer (item 11) publishes at most **one snapshot per live cycle per
  second**, no matter how many bets landed in between. 800 bets/sec → 1 msg/sec.
- Publish rate is now bounded by `live cycles × 1/sec` (~2/sec of origin work),
  **not** `bets/sec × users`. That is the ~99.7% cut, on SSE and Socket.IO alike.

On top of coalescing, **room-scoping** trims each snapshot's recipients from
"every connection" to "watchers of this cycle":

- Clients call `watch_cycle {cycleId}` / `unwatch_cycle`; the canonical
  `pool_update` event is emitted to `io.to('cycle:<cycleId>')`. Socket.IO owns
  room membership (no Redis watcher list — item 5), and the Redis adapter fans
  the room emit across instances for free (item 4/12).
- At ~2,000 users this is a smaller, secondary win (2,000 → ~1,200 recipients);
  the coalescing above is what actually removes the overload.

### Pool safety (unchanged invariant)

Every public payload goes through `assertPublicCycleSafe` (`cyclePublicView.js`),
which throws if a `real*`/`phantom*` field is ever present. The public sees
**total** pools only (real + phantom) — never the breakdown.

### Money path (untouched — item 15)

This is display-only. The authoritative pools remain the Cycle document's atomic
`$inc`; settlement, ledger and authority are unchanged. The snapshot only
**reads** state and is never an authority.

## What changed

| Layer | File | Change |
|---|---|---|
| Publisher | `backend/domains/markets/cycleSnapshotPublisher.js` | **new** — in-memory aggregate + 1s coalesced publisher |
| Bet route | `backend/domains/markets/bet.routes.js` | per-bet public `io.emit`/SSE `bet_placed` → `recordBet()`; admins keep per-bet `admin_bet_placed` |
| Sockets | `backend/startup/socketHandlers.js` | `watch_cycle` / `unwatch_cycle` rooms (+ immediate seed on join) |
| Startup | `backend/server.js` | attach + start publisher; stop on shutdown; `/metrics` provider |
| Metrics | `backend/services/metrics.service.js` | `bb_realtime_stats` gauges (connected sockets, tracked cycles, snapshots, coalesced) |
| SSE manager | `backend/domains/notification/sseManager.service.js` | `cycleClients` / `clientCycles` topics; `watchCycles`, `broadcastToCycle` (Redis-bridged) |
| SSE route | `backend/routes/sse.routes.js` | `GET /events?cycles=a,b` subscribes the stream; omitted means none |
| Client | `user-panel/src/services/GameContext.tsx` | watch the live cycles; consume `pool_update` (reuses the pool applier); hand the pool stream to SSE while the socket is down |
| Client | `user-panel/src/services/realBackend.ts` | `SSEEventBridge.setCycles()` — reopens the stream on a changed set, no-ops otherwise |

## Delivery is scoped on both transports

The staged rollout is complete: there is no global bridge left on either
transport, and every pool snapshot goes only to clients watching that cycle.

| Transport | Scope mechanism | Who subscribes |
|---|---|---|
| Socket.IO | `cycle:<id>` rooms, joined with `watch_cycle` | every client, for each live cycle it displays |
| SSE | `cycleClients` topics, set with `GET /api/sse/events?cycles=a,b` | only a client whose WebSocket is down |

**The SSE side is a subscription in the URL, not a message.** SSE is one-way, so
there is no `watch_cycle` to send: changing the set means reopening the
`EventSource`, which `SSEEventBridge.setCycles()` does — and skips when the set
is unchanged, because `GameContext` calls it on every snapshot. A POST endpoint
to mutate a live stream was rejected: it would be a second unauthenticated way
to reach into an open connection, to save a reconnect that happens only on the
fallback path.

**Why the default is "subscribe to nothing".** A client with a healthy socket
already receives the same totals as room-scoped `pool_update`; the SSE copy is
pure duplication. `GameContext` therefore subscribes only after the socket
actually fails, latched on `disconnect`/`connect_error` rather than read from
`socket.connected` — the socket is legitimately disconnected for the first
moment of every page load, and reading the flag there would reconnect the
EventSource twice on every load to avoid a duplication that was not happening.

### What this cost before it was scoped

This was previously described here as an optional fast-follow, "marginal at ~2k
users". That estimate assumed SSE carried the bridge for a shrinking minority of
clients whose WebSocket was blocked. It did not: `SSEEventBridge` connects in its
constructor with no "only if the socket failed" branch, so **every** client held
an SSE connection alongside its socket, and `sseManager.broadcast('bet_placed')`
sent every live cycle's snapshot to all of them on top of the room-scoped
`pool_update` they were already processing. The client normalised the two
copies' field names against each other to reconcile them.

With three boards live that is 3 duplicated deliveries per client per second —
~6k/sec at 2,000 connections, ~600k/sec at the 200k target. The duplication grew
linearly with connections, which is exactly the shape the snapshot publisher
exists to avoid.

## Measure it (do not guess — item 17)

Two harnesses + `/metrics`, all **staging only, not yet run**:

```bash
# 1) connection fan-out (primary SSE transport), ramp 2k → 5k → 10k
SSE_URL="https://staging/api/sse/events" CONN=2000 DURATION=60 npm run loadtest:realtime
# 2) drive bets concurrently (existing harness)
npm run loadtest:bets
# 3) scrape the server the whole time
curl -s localhost:5000/metrics | grep -E 'bb_realtime_stats|nodejs_eventloop_lag_seconds'
```

**Pass criteria:** `bb_realtime_stats{metric="snapshots_published"}` rises at
~`live-cycles/sec` (≈2), **not** at `bets/sec`; `nodejs_eventloop_lag_seconds`
stays low as `connected_sockets` climbs to 10k. Report measured p95 / lag / CPU /
RAM / network — never a number from a generic Node.js benchmark.

**Hardware:** if 10k concurrent holds with acceptable p95 and DB headroom, stay
on the single i7-class box (32 GB RAM, SSD/NVMe, 300 Mbps+). Do not add a second
realtime box, Kafka, or a broker on the DAU number alone — only on a measurement.
