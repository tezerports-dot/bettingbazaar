// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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

/** GET /metrics handler. */
export async function metricsHandler(req, res) {
  try {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  } catch (e) {
    res.status(500).end(e.message);
  }
}
