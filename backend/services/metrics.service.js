// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// Prometheus metrics (plan item 33, 2026-07-13). Exposes GET /metrics in the
// standard text format any Prometheus-compatible scraper ingests (Prometheus,
// Grafana Cloud, VictoriaMetrics, Datadog agent) — portable, no vendor agent,
// same philosophy as the stdout JSON logger. Default process metrics (CPU,
// memory, event loop lag, GC) plus HTTP request duration/count and a few
// business counters money paths increment.
import client from 'prom-client';

export const registry = new client.Registry();
// Under PM2 cluster mode every worker has its own registry, so every series
// carries which role and which worker produced it (NODE_APP_INSTANCE is PM2's
// 0-based worker index). Dashboards sum or max across `worker`.
registry.setDefaultLabels({
  role: String(process.env.BB_RUNTIME_ROLE || 'all'),
  worker: String(process.env.NODE_APP_INSTANCE ?? process.env.pm_id ?? '0'),
});
client.collectDefaultMetrics({ register: registry });

// ── HTTP ──────────────────────────────────────────────────────────────────────
const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  // Buckets tuned for an API tier: 5ms .. 5s
  buckets: [0.005, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

/**
 * Express middleware — times every request. Uses the ROUTE PATTERN
 * (req.route/baseUrl) rather than the raw URL so cardinality stays bounded
 * (no per-user/per-id label explosion).
 */
export function httpMetrics(req, res, next) {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    const route = (req.baseUrl || '') + (req.route?.path || '') || req.path.split('?')[0].replace(/\/[a-f0-9]{24}(\/|$)/g, '/:id$1');
    end({ method: req.method, route: route.slice(0, 100), status: res.statusCode });
  });
  next();
}

// ── Business counters (incremented by the owning services) ───────────────────
export const settlementRuns = new client.Counter({
  name: 'bb_settlement_runs_total',
  help: 'Cycle settlement attempts by outcome',
  labelNames: ['outcome'], // success | error
  registers: [registry],
});

export const ledgerReconcileErrors = new client.Counter({
  name: 'bb_ledger_reconcile_errors_total',
  help: 'Ledger reconciliation item failures',
  registers: [registry],
});


export const alertsSent = new client.Counter({
  name: 'bb_alerts_sent_total',
  help: 'Operational alerts dispatched to the configured webhook',
  labelNames: ['key'],
  registers: [registry],
});

// Item 9 (2026-07-13): requests rejected by the load-shed edge (503). A rising
// rate here means the instance hit its concurrency/lag ceiling — scale out or
// raise the admin-configured cap. Labelled by reason so overload (in-flight)
// vs saturation (event-loop lag) are distinguishable on the dashboard.
export const requestsShed = new client.Counter({
  name: 'bb_requests_shed_total',
  help: 'Requests shed with 503 by the bounded load-shedder',
  labelNames: ['reason'], // inflight | eventloop
  registers: [registry],
});

// ── Why there is no drift or reconciliation gauge here ──────────────────────
//
// Seven metrics used to sit at this point: drift row counts in both directions,
// a trial-balance flag, a reconciliation error counter, a consecutive-clean
// gauge that gated a cutover, a ledgers-agree flag, and a labelled gauge saying
// which store owned each money path.
//
// Every one of them measured the DISTANCE BETWEEN TWO STORES. There is one
// store, so each had exactly zero writers and would have reported 0 forever —
// and a gauge pinned at 0 reads on a dashboard as "in sync", which is the most
// dangerous possible reading for a number that is not being computed. The
// trial balance itself is not lost: it is asserted against a real database in
// the money suites, where a violation fails a build rather than needing
// somebody to notice a panel.

// ── Per-domain money operations ──────────────────────────────────────────────
// One counter for every balance mutation, labelled by which money path it
// belongs to, which store served it, and how it ended. Three separate counters
// were considered (transactions / retries / idempotent hits) and rejected: they
// would need identical labels to be comparable, and an outcome label answers
// all three questions from one series while keeping cardinality bounded (paths
// and outcomes are both closed sets — never an id, never a merchant).
//
// Alert-worthy signals this exposes:
//   - `idempotent` climbing steeply = a caller is retrying far more than it
//     should, or two paths share a txId they should not.
//   - `insufficient` climbing on a path that should never overdraw = an upstream
//     guard has stopped working.
//   - `error` at all on a money path = investigate immediately.
export const moneyOperations = new client.Counter({
  name: 'bb_money_operations_total',
  help: 'Balance mutations by money path, serving store and outcome',
  // outcome: applied | idempotent | insufficient | not_found | error
  labelNames: ['path', 'store', 'operation', 'outcome'],
  registers: [registry],
});

// Pool-stats provider — registered by pgClient via setPoolStatsProvider() when
// Postgres is in use. Inversion of control keeps this low-level metrics module
// free of any dependency on the higher-level pgClient (dependency-cruiser
// no-circular: metrics must not import pgClient; pgClient depends on metrics).
let poolStatsProvider = null;
/** pgClient registers its getPoolStats() here so /metrics can sample the pool
 *  without metrics.service importing pgClient (which would form an import cycle). */
export function setPoolStatsProvider(fn) { poolStatsProvider = typeof fn === 'function' ? fn : null; }

// Connection-pool monitoring (2026 DB hygiene). A Gauge with a collect() that
// samples the live pool on each scrape — no interval, no state. `waiting > 0`
// sustained = pool exhaustion (raise PG_POOL_SIZE or scale the DB). Dormant
// (emits nothing) until pgClient registers a provider and the pool has opened.
// Not exported: `registers: [registry]` IS its consumer — it is served as
// bb_pg_pool_connections on /metrics, and SRE_AND_OPERATIONS alerts on it.
new client.Gauge({
  name: 'bb_pg_pool_connections',
  help: 'Postgres connection pool state by bucket (total|idle|waiting)',
  labelNames: ['state'],
  registers: [registry],
  collect() {
    try {
      const s = poolStatsProvider ? poolStatsProvider() : null;
      if (!s) return;
      this.set({ state: 'total' }, s.total);
      this.set({ state: 'idle' }, s.idle);
      this.set({ state: 'waiting' }, s.waiting);
    } catch { /* pool unavailable — emit nothing */ }
  },
});

// Core Infrastructure Architecture readiness: measure money-DB query latency so
// operators can alert on pool/transaction pressure after adding an L4 edge path.
// Labels are intentionally bounded: caller supplies a small operation name, not
// raw SQL.
export const pgQueryDuration = new client.Histogram({
  name: 'bb_pg_query_duration_seconds',
  help: 'Postgres query duration by bounded operation label',
  labelNames: ['operation', 'outcome'], // success | error
  buckets: [0.005, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// ── Realtime delivery (cost / concurrency) ───────────────────────────────────
// The snapshot publisher (domains/markets/cycleSnapshotPublisher.js) coalesces
// per-bet pool broadcasts into ≤1 snapshot/sec/cycle. These make the win
// measurable: snapshots_published should track (live cycles × 1/sec) no matter
// how high the bet rate climbs, while connected_sockets shows fan-out scope.
// Event-loop lag — the thing that actually degrades under realtime overload — is
// already exported by collectDefaultMetrics as nodejs_eventloop_lag_seconds.
// IoC provider like the PG pool above: this module imports neither io nor the
// publisher, so no dependency cycle forms.
let realtimeStatsProvider = null;
/** server.js registers a getter returning {connectedSockets, trackedCycles, snapshotsPublished, betsCoalesced}. */
export function setRealtimeStatsProvider(fn) { realtimeStatsProvider = typeof fn === 'function' ? fn : null; }

// The getter above was registered and never read, so none of these reached
// /metrics. Sampled on each scrape like the pool gauge; dormant on an API-only
// role, where no provider is registered.
const REALTIME_STATS = ['connectedSockets', 'trackedCycles', 'snapshotsPublished', 'betsCoalesced'];
new client.Gauge({
  name: 'bb_realtime_delivery',
  help: 'Realtime delivery by stat (connectedSockets|trackedCycles|snapshotsPublished|betsCoalesced)',
  labelNames: ['stat'],
  registers: [registry],
  collect() {
    try {
      const s = realtimeStatsProvider ? realtimeStatsProvider() : null;
      if (!s) return;
      for (const stat of REALTIME_STATS) if (Number.isFinite(s[stat])) this.set({ stat }, s[stat]);
    } catch { /* realtime unavailable — emit nothing */ }
  },
});

// ── Realtime event rate and payload size (owner, 2026-10-09) ────────────────
// One increment per broadcast (not per recipient): events/sec and the average
// serialized size are bytes_total / events_total. Labels are event NAMES, a
// closed set of code constants — never an id.
const realtimeEvents = new client.Counter({
  name: 'bb_realtime_events_total',
  help: 'Public realtime broadcasts by event name',
  labelNames: ['event'],
  registers: [registry],
});
const realtimePayloadBytes = new client.Counter({
  name: 'bb_realtime_payload_bytes_total',
  help: 'Serialized JSON bytes of public realtime broadcasts, by event name (divide by bb_realtime_events_total for the average)',
  labelNames: ['event'],
  registers: [registry],
});
/** Count one broadcast and its serialized size. Never throws. */
export function recordRealtimeEvent(event, payload) {
  try {
    const name = String(event).slice(0, 48);
    realtimeEvents.inc({ event: name });
    realtimePayloadBytes.inc({ event: name }, Buffer.byteLength(JSON.stringify(payload ?? null)));
  } catch { /* metrics never break a broadcast */ }
}

// ── SSE connections, Redis health, server-side PostgreSQL connections ───────
// IoC providers like the pool gauge above, registered by server.js.
let sseStatsProvider = null;
export function setSseStatsProvider(fn) { sseStatsProvider = typeof fn === 'function' ? fn : null; }
new client.Gauge({
  name: 'bb_sse_connections',
  help: 'Open SSE streams on this worker by audience (public|user|merchant|admin)',
  labelNames: ['audience'],
  registers: [registry],
  collect() {
    try {
      const s = sseStatsProvider ? sseStatsProvider() : null;
      if (!s) return;
      this.set({ audience: 'public' }, s.active ?? 0);
      this.set({ audience: 'user' }, s.activeUsers ?? 0);
      this.set({ audience: 'merchant' }, s.activeMerchants ?? 0);
      this.set({ audience: 'admin' }, s.activeAdmins ?? 0);
    } catch { /* emit nothing */ }
  },
});

let redisHealthProvider = null;
export function setRedisHealthProvider(fn) { redisHealthProvider = typeof fn === 'function' ? fn : null; }
new client.Gauge({
  name: 'bb_redis_up',
  help: '1 when this worker\'s Redis connection is ready, 0 otherwise (absent when Redis is not configured)',
  registers: [registry],
  collect() {
    try {
      const up = redisHealthProvider ? redisHealthProvider() : null;
      if (up === null || up === undefined) return;
      this.set(up ? 1 : 0);
    } catch { /* emit nothing */ }
  },
});

// What the DATABASE sees, through PgBouncer: server connections by state and
// the configured ceiling. Sampled on scrape with one cheap query.
let pgServerStatsProvider = null;
export function setPgServerStatsProvider(fn) { pgServerStatsProvider = typeof fn === 'function' ? fn : null; }
new client.Gauge({
  name: 'bb_pg_server_connections',
  help: 'PostgreSQL backend connections by state (active|idle|idle_in_transaction|other|max)',
  labelNames: ['state'],
  registers: [registry],
  async collect() {
    try {
      const s = pgServerStatsProvider ? await pgServerStatsProvider() : null;
      if (!s) return;
      for (const [state, n] of Object.entries(s)) if (Number.isFinite(n)) this.set({ state }, n);
    } catch { /* database unavailable — emit nothing */ }
  },
});

// PgBouncer pool utilisation from its admin console (SHOW POOLS / SHOW STATS),
// sampled on scrape when PGBOUNCER_STATS_URL is set. cl_waiting > 0 or a
// growing maxwait means clients queue for a server connection; rejected
// connections show up as bb_pg_connect_errors_total below.
let pgBouncerStatsProvider = null;
export function setPgBouncerStatsProvider(fn) { pgBouncerStatsProvider = typeof fn === 'function' ? fn : null; }
new client.Gauge({
  name: 'bb_pgbouncer_pool',
  help: 'PgBouncer pool state for the app database (cl_active|cl_waiting|sv_active|sv_idle|sv_used|maxwait_seconds|avg_wait_seconds|avg_query_seconds)',
  labelNames: ['metric'],
  registers: [registry],
  async collect() {
    try {
      const s = pgBouncerStatsProvider ? await pgBouncerStatsProvider() : null;
      if (!s) return;
      for (const [metric, n] of Object.entries(s)) if (Number.isFinite(n)) this.set({ metric }, n);
    } catch { /* pooler unavailable — emit nothing */ }
  },
});

// Connection-level refusals: PgBouncer at max_client_conn, a pool wait that
// timed out, PostgreSQL out of slots. Classified from the driver's message.
export const pgConnectErrors = new client.Counter({
  name: 'bb_pg_connect_errors_total',
  help: 'Database connection refusals by reason',
  labelNames: ['reason'], // client_limit | wait_timeout | server_slots | connect_failed
  registers: [registry],
});

/** Count a database error when it is a connection refusal. Never throws. */
export function recordPgConnectError(err) {
  try {
    const m = String(err?.message || '');
    const reason = /no more connections allowed|max_client_conn/i.test(m) ? 'client_limit'
      : /query_wait_timeout|timeout exceeded when trying to connect/i.test(m) ? 'wait_timeout'
        : /too many clients|remaining connection slots/i.test(m) ? 'server_slots'
          : /ECONNREFUSED|ECONNRESET|server conn crashed|server login failed|Connection terminated/i.test(m) ? 'connect_failed'
            : null;
    if (reason) pgConnectErrors.inc({ reason });
  } catch { /* metrics never break a query */ }
}

// Client-reported endpoint events (discovery, adoption, failover), counted
// from `POST /api/v1/client/endpoint-events`. Every label is a closed enum
// validated by the route; the host is the server's own, from a fixed list.
export const clientEndpointEvents = new client.Counter({
  name: 'bb_client_endpoint_events_total',
  help: 'Endpoint discovery/failover events reported by player apps',
  labelNames: ['kind', 'source', 'reason', 'host'],
  registers: [registry],
});

/** GET /metrics handler. */
export async function metricsHandler(req, res) {
  try {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  } catch (e) {
    res.status(500).end(e.message);
  }
}
