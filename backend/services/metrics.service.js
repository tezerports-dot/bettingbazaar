// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Prometheus metrics (plan item 33, 2026-07-13). Exposes GET /metrics in the
// standard text format any Prometheus-compatible scraper ingests (Prometheus,
// Grafana Cloud, VictoriaMetrics, Datadog agent) — portable, no vendor agent,
// same philosophy as the stdout JSON logger. Default process metrics (CPU,
// memory, event loop lag, GC) plus HTTP request duration/count and a few
// business counters money paths increment.
import client from 'prom-client';

export const registry = new client.Registry();
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

// A balance moved but its audit rows did not land. The Mongo bet-stake path
// (walletAuthority._mongoBetStake) writes balance and ledger as two separate
// operations and deliberately lets the money stand if the ledger write fails —
// stranding a placed bet is judged worse than a missing audit row. That
// tradeoff is defensible; doing it SILENTLY is not, because the missing row is
// exactly what reconciliation and the trial balance are computed from.
//
// Any non-zero value here means the ledger no longer explains the balances.
// Alert on it: `increase(bb_unaudited_money_movements_total[15m]) > 0`.
export const unauditedMoneyMovements = new client.Counter({
  name: 'bb_unaudited_money_movements_total',
  help: 'Balance movements whose ledger rows failed to write (money moved unaudited)',
  labelNames: ['path'],
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

// AQ-9: hybrid money-DB continuous reconciliation signals. Dormant (stay at 0)
// until Postgres is provisioned and dual-write is live. A nonzero drift gauge or
// a trial-balance flip to 0 means Mongo and Postgres disagree on money data —
// alert on `bb_pg_drift_rows > 0` or `bb_pg_trial_balance_ok == 0`.
export const pgDriftRows = new client.Gauge({
  name: 'bb_pg_drift_rows',
  help: 'Money rows present in MongoDB but missing from the Postgres mirror (0 = in sync)',
  registers: [registry],
});
export const pgTrialBalanceOk = new client.Gauge({
  name: 'bb_pg_trial_balance_ok',
  help: 'Postgres ledger trial balance conserves to zero (1) or not (0)',
  registers: [registry],
});
export const pgReconcileErrors = new client.Counter({
  name: 'bb_pg_reconcile_errors_total',
  help: 'Postgres reconciliation run failures',
  registers: [registry],
});
// The cutover-readiness gate: consecutive clean reconciliation passes. Any drift
// or crashed run resets it to 0. Flipping money authority to Postgres
// (DATA_ROLLBACK_PLAN.md) requires this to stay high over a sustained window —
// drift DETECTION alone is not proof; sustained agreement is.
export const pgReconcileConsecutiveClean = new client.Gauge({
  name: 'bb_pg_reconcile_consecutive_clean',
  help: 'Consecutive clean hybrid-DB reconciliation passes (0 = last run drifted or failed)',
  registers: [registry],
});

// ── Reverse direction (cutover Phase B) ──────────────────────────────────────
// Once a money path is authoritative in Postgres, MongoDB becomes the copy that
// can fall behind — and the zero-RPO rollback guarantee in DATA_ROLLBACK_PLAN.md
// depends on it staying complete. The forward gauges above cannot see that:
// bb_pg_drift_rows only counts rows missing from Postgres. Without these two,
// bb_pg_reconcile_consecutive_clean would keep climbing while Mongo silently
// lost writes, and the gate the whole cutover rests on would be lying.
// Alert on `bb_mongo_drift_rows > 0` or `bb_ledgers_agree == 0`.
export const mongoDriftRows = new client.Gauge({
  name: 'bb_mongo_drift_rows',
  help: 'Money rows present in Postgres but missing from MongoDB (0 = in sync; only meaningful once a path is PG-authoritative)',
  registers: [registry],
});
export const ledgersAgree = new client.Gauge({
  name: 'bb_ledgers_agree',
  help: 'Mongo and Postgres ledgers agree account-by-account and both conserve to zero (1) or not (0)',
  registers: [registry],
});
// Which stores own money right now, as a labelled gauge: one series per path,
// 1 = Postgres is authoritative, 0 = MongoDB. Makes the cutover visible on the
// dashboard and lets an alert fire if a path moves unexpectedly.
export const moneyAuthorityPostgres = new client.Gauge({
  name: 'bb_money_authority_postgres',
  help: 'Postgres is the source of truth for this money path (1) or MongoDB is (0)',
  labelNames: ['path'],
  registers: [registry],
});

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

// ── Cross-store balance drift ────────────────────────────────────────────────
// bb_pg_drift_rows counts rows MISSING from a store. It cannot see the failure
// that actually matters for a balance: a row present in both stores whose
// NUMBER differs. These two gauges are that check — the money equivalent of the
// trial balance, per domain. Both must be zero for a path to be cutover-ready,
// and staying zero is what the certification checklist means by "reconciled".
// Alert on `bb_balance_drift_paise != 0`.
export const balanceDriftPaise = new client.Gauge({
  name: 'bb_balance_drift_paise',
  help: 'Absolute Mongo↔Postgres balance disagreement in paise, by money path (0 = agree)',
  labelNames: ['path'],
  registers: [registry],
});
export const balanceDriftAccounts = new client.Gauge({
  name: 'bb_balance_drift_accounts',
  help: 'Number of accounts whose Mongo and Postgres balances disagree, by money path',
  labelNames: ['path'],
  registers: [registry],
});

// ── Stalled settlements ──────────────────────────────────────────────────────
// A settlement run marked COMPLETED while bets on its cycle are still PENDING.
// That is a player's stake locked with nothing coming to release it: the bet is
// never paid, never lost, and never refunded. `findIncompleteSettlements()` in
// postgres/settlementPg.js is the query that finds it — it was built and tested
// and then had NO production call site at all, so the condition it detects
// could persist indefinitely with nothing looking. Wired to the ledger-reconcile
// cron 2026-08-31.
//
// Alert on `bb_stalled_settlements != 0`. It is a money-loss signal, not a
// performance one, and it should be zero at all times.
export const stalledSettlements = new client.Gauge({
  name: 'bb_stalled_settlements',
  help: 'Settlement runs marked COMPLETED with bets still PENDING (0 = none; any value is a locked stake)',
  registers: [registry],
});
export const stalledSettlementBets = new client.Gauge({
  name: 'bb_stalled_settlement_bets',
  help: 'Total bets left PENDING across COMPLETED settlement runs',
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
export const pgPoolConnections = new client.Gauge({
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
export const realtimeStats = new client.Gauge({
  name: 'bb_realtime_stats',
  help: 'Realtime delivery gauges (connected_sockets|tracked_cycles|snapshots_published|bets_coalesced)',
  labelNames: ['metric'],
  registers: [registry],
  collect() {
    try {
      const s = realtimeStatsProvider ? realtimeStatsProvider() : null;
      if (!s) return;
      if (typeof s.connectedSockets === 'number')   this.set({ metric: 'connected_sockets' },   s.connectedSockets);
      if (typeof s.trackedCycles === 'number')      this.set({ metric: 'tracked_cycles' },      s.trackedCycles);
      if (typeof s.snapshotsPublished === 'number') this.set({ metric: 'snapshots_published' }, s.snapshotsPublished);
      if (typeof s.betsCoalesced === 'number')      this.set({ metric: 'bets_coalesced' },      s.betsCoalesced);
    } catch { /* unavailable — emit nothing */ }
  },
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
