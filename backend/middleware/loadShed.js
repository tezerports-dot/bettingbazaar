// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * middleware/loadShed.js — Bounded concurrency + load shedding (item 9). 2026-07-13.
 *
 * THE PROBLEM (owner's words): "An unbounded queue is a time bomb." Node accepts
 * every incoming request and piles the work onto ONE event loop. Past a point,
 * accepting MORE work doesn't serve anyone — it starves the loop so that even
 * the in-flight requests (including money paths mid-transaction) time out. The
 * fix is a BOUND: past the ceiling, reject the excess FAST with 503 instead of
 * admitting it into a queue that will never drain.
 *
 * TWO independent ceilings, both admin-editable (SystemConfig.loadShedding),
 * both env-overridable, both default to values that only trip under genuine
 * overload — normal traffic (and cycle-settlement bursts) never see a 503:
 *   1. maxInFlight — cap on concurrently-processing requests. At the cap, new
 *      requests get 503 + Retry-After. This is the "bound the queue" itself.
 *   2. maxEventLoopLagMs — if the loop is already saturated (mean delay over the
 *      threshold), shed regardless of count. 0 = off (default) — the in-flight
 *      cap is the primary guard; lag shedding is opt-in for very spiky tenants.
 *
 * WHY SHEDDING IS MONEY-SAFE: a shed request is rejected AT THE EDGE, before any
 * route handler, DB read, or wallet write runs — there is no partial operation
 * to roll back. The client (which uses jittered backoff, utils/retry.js) simply
 * retries later. Rejecting cleanly is strictly safer than admitting work the
 * loop can't finish. Streaming/observability endpoints are EXEMPT (below) so a
 * long-lived SSE connection never counts against the cap or gets dropped.
 *
 * IMPORTANT: this bounds ONE instance. Horizontal scale (k8s HPA on the shed
 * metric / CPU) is the capacity answer; this is the safety valve that keeps each
 * instance healthy until more come online. Read bb_requests_shed_total (item 33)
 * to know when to scale.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

// Never shed or count these — health/metrics must answer even under overload
// (so orchestrators can see the instance is alive and scrapers keep working),
// and SSE connections are long-lived (counting them would leak slots forever).
const EXEMPT_PREFIXES = ['/health', '/api/v1/health', '/metrics', '/api/sse'];

// Live event-loop delay histogram (nanoseconds). resolution=20ms sampling is
// cheap and enabled once for the process lifetime.
const eld = monitorEventLoopDelay({ resolution: 20 });
eld.enable();
function currentLagMs() { return eld.mean / 1e6; }

// ── Config (admin-editable, env fallback, cached) ────────────────────────────
const DEFAULTS = {
  enabled: true,
  // 300 concurrently-processing requests on ONE Node instance already means the
  // loop is saturated; a generous ceiling that protects without tripping in
  // normal operation. Tune per instance size in admin / env.
  maxInFlight: Number(process.env.LOAD_SHED_MAX_INFLIGHT || 300),
  // Off by default — opt in for spiky workloads. 250ms mean loop delay = trouble.
  maxEventLoopLagMs: Number(process.env.LOAD_SHED_MAX_LAG_MS || 0),
};
let cfg = { ...DEFAULTS };
if (String(process.env.LOAD_SHED_ENABLED).toLowerCase() === 'false') cfg.enabled = false;

let inFlight = 0;
let refreshTimer = null;

/** Pull SystemConfig.loadShedding over the env/defaults. Safe before DB is up. */
async function refreshConfig() {
  try {
    const mongoose = (await import('mongoose')).default;
    const SystemConfig = mongoose.model('SystemConfig');
    const doc = await SystemConfig.findOne({ key: 'main' }).select('loadShedding').lean();
    const s = doc?.loadShedding;
    if (s) {
      cfg = {
        enabled: s.enabled !== undefined ? !!s.enabled : DEFAULTS.enabled,
        maxInFlight: Number.isFinite(s.maxInFlight) && s.maxInFlight >= 0 ? s.maxInFlight : DEFAULTS.maxInFlight,
        maxEventLoopLagMs: Number.isFinite(s.maxEventLoopLagMs) && s.maxEventLoopLagMs >= 0 ? s.maxEventLoopLagMs : DEFAULTS.maxEventLoopLagMs,
      };
    }
  } catch { /* DB not ready / model absent — keep current cfg (env+defaults) */ }
}

/** Start the periodic config refresh. Called once from server startup. */
export function startLoadShedConfigRefresh(everyMs = 30_000) {
  if (refreshTimer) return;
  refreshConfig();
  refreshTimer = setInterval(refreshConfig, everyMs);
  if (refreshTimer.unref) refreshTimer.unref();
}

function shed(res, reason) {
  import('../services/metrics.service.js').then(m => m.requestsShed.inc({ reason })).catch(() => {});
  res.set('Retry-After', '2'); // seconds — a hint; the client's jittered backoff spreads the actual retry
  return res.status(503).json({
    success: false,
    message: 'Server is at capacity. Please retry in a moment.',
    retryAfter: 2,
  });
}

/**
 * loadShed — the edge middleware. Mount EARLY (right after metrics), before the
 * routers, so rejection happens before any real work. Exempt paths pass straight
 * through, uncounted.
 */
export function loadShed(req, res, next) {
  const p = req.path;
  if (EXEMPT_PREFIXES.some(pre => p === pre || p.startsWith(pre + '/') || p.startsWith(pre))) return next();
  if (!cfg.enabled) return next();

  if (cfg.maxEventLoopLagMs > 0 && currentLagMs() > cfg.maxEventLoopLagMs) {
    return shed(res, 'eventloop');
  }
  if (cfg.maxInFlight > 0 && inFlight >= cfg.maxInFlight) {
    return shed(res, 'inflight');
  }

  inFlight++;
  let done = false;
  const dec = () => { if (!done) { done = true; inFlight = Math.max(0, inFlight - 1); } };
  res.on('finish', dec);
  res.on('close', dec);
  next();
}

/** Test/introspection helpers. */
export function _loadShedState() { return { inFlight, cfg: { ...cfg }, lagMs: currentLagMs() }; }
export function _setLoadShedConfig(partial) { cfg = { ...cfg, ...partial }; } // tests only
