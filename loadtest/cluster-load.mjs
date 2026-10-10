// GOVERNANCE: Read CLAUDE.md before editing this file.
/**
 * cluster-load.mjs — the production-like load test for the PM2 cluster +
 * PgBouncer configuration (owner, 2026-10-09). Zero dependencies: Node 22's
 * global fetch and WebSocket.
 *
 * What it does, all at once for DURATION seconds:
 *   (SOCKET_URL, default BASE_URL, is where Socket.IO and SSE connect — the
 *   realtime role; BASE_URL takes the HTTP load — the api role.)
 *   - opens SOCKETS Socket.IO clients (websocket transport, the panels' only
 *     one) and SSE_CLIENTS public SSE streams, and records every cycle_phase /
 *     cycle_result they receive — so cross-worker delivery, event ordering and
 *     payload sizes are measured on the wire;
 *   - drives HTTP_CONCURRENCY concurrent loops of public reads (boards, rules,
 *     cycle history, readiness), recording latency percentiles and errors;
 *   - optionally drives CONNECT_SPIKE fresh HTTP connections at once at the
 *     midpoint (the "connection spike" acceptance criterion);
 *   - scrapes METRICS_URLS (comma-separated per-worker /metrics URLs) before
 *     and after for CPU, memory, PgBouncer and PostgreSQL connection figures.
 *
 * It sends no credentials and places no bets: it is safe against staging, and
 * it still must NOT be pointed at production during business hours.
 *
 *   BASE_URL=https://staging.example.com SOCKETS=2000 SSE_CLIENTS=2000 \
 *   HTTP_CONCURRENCY=200 DURATION=300 CONNECT_SPIKE=1000 \
 *   METRICS_URLS=http://10.0.0.5:9400/metrics,... METRICS_TOKEN=… \
 *   node loadtest/cluster-load.mjs > result.json
 *
 * Steps for the real 16 GB / 8-core server: docs/governance/PGBOUNCER_AND_CLUSTER.md.
 */
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const SOCKET_BASE = (process.env.SOCKET_URL || BASE).replace(/\/+$/, '');
const SOCKETS = Number(process.env.SOCKETS ?? 200);
const SSE_CLIENTS = Number(process.env.SSE_CLIENTS ?? 200);
const HTTP_CONCURRENCY = Number(process.env.HTTP_CONCURRENCY ?? 50);
const DURATION = Number(process.env.DURATION ?? 60) * 1000;
const CONNECT_SPIKE = Number(process.env.CONNECT_SPIKE ?? 0);
const METRICS_URLS = String(process.env.METRICS_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
const METRICS_TOKEN = process.env.METRICS_TOKEN || '';
const PATHS = (process.env.HTTP_PATHS || '/api/v1/boards,/api/v1/board-rules,/health/ready').split(',');

const now = () => performance.now();
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
};

// ── Realtime receivers ────────────────────────────────────────────────────────
const rt = {
  socketsOpen: 0, socketsFailed: 0, sseOpen: 0, sseFailed: 0,
  events: {}, bytes: {}, perClientPhase: [], orderViolations: 0, decodeFailures: 0,
};
function count(event, raw) {
  rt.events[event] = (rt.events[event] || 0) + 1;
  rt.bytes[event] = (rt.bytes[event] || 0) + Buffer.byteLength(raw);
}

/** Per client: the order of lifecycle codes seen per cycle must only move forward. */
const ORDER = { 2: 1, 3: 2, result: 3 };       // MERGED → CLOSED → result
function tracker() {
  const last = new Map();
  let phases = 0;
  return {
    see(event, data) {
      if (!data || typeof data !== 'object') { rt.decodeFailures += 1; return; }
      if (data.v !== undefined && data.v !== 2) { rt.decodeFailures += 1; return; }
      const id = data.c ?? data.cycleId;
      const rank = event === 'cycle_result' ? ORDER.result : ORDER[data.p];
      if (event === 'cycle_phase') phases += 1;
      if (!id || !rank) return;
      const prev = last.get(id) || 0;
      if (rank < prev) rt.orderViolations += 1;
      last.set(id, Math.max(prev, rank));
    },
    get phases() { return phases; },
  };
}

function openSocket() {
  return new Promise((resolve) => {
    const url = `${SOCKET_BASE.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`;
    let ws;
    try { ws = new WebSocket(url); } catch { rt.socketsFailed += 1; return resolve(null); }
    const t = tracker();
    const timer = setTimeout(() => { rt.socketsFailed += 1; try { ws.close(); } catch {} resolve(null); }, 15000);
    ws.onmessage = (m) => {
      const s = String(m.data);
      if (s[0] === '0') ws.send('40');                          // engine open → join namespace
      else if (s === '2') ws.send('3');                         // ping → pong
      else if (s.startsWith('40')) { clearTimeout(timer); rt.socketsOpen += 1; resolve({ ws, t }); }
      else if (s.startsWith('42')) {
        try {
          const [event, data] = JSON.parse(s.slice(2));
          count(`socket:${event}`, JSON.stringify(data ?? null));
          if (event === 'cycle_phase' || event === 'cycle_result') t.see(event, data);
        } catch { rt.decodeFailures += 1; }
      }
    };
    ws.onerror = () => { clearTimeout(timer); rt.socketsFailed += 1; resolve(null); };
  });
}

async function openSse(signal) {
  try {
    const res = await fetch(`${SOCKET_BASE}/api/sse/events`, { headers: { Accept: 'text/event-stream' }, signal });
    if (!res.ok || !res.body) { rt.sseFailed += 1; return null; }
    rt.sseOpen += 1;
    const t = tracker();
    (async () => {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (!ev || data === undefined) continue;
            count(`sse:${ev}`, data);
            if (ev === 'cycle_phase' || ev === 'cycle_result') { try { t.see(ev, JSON.parse(data)); } catch { rt.decodeFailures += 1; } }
          }
        }
      } catch { /* aborted at the end */ }
    })();
    return t;
  } catch { rt.sseFailed += 1; return null; }
}

// ── HTTP load ─────────────────────────────────────────────────────────────────
const http = { latencies: [], ok: 0, errors: 0, status: {}, byPath: {} };
async function httpLoop(until) {
  let i = 0;
  while (now() < until) {
    const path = PATHS[i++ % PATHS.length];
    const t0 = now();
    try {
      const res = await fetch(`${BASE}${path}`, { cache: 'no-store' });
      await res.arrayBuffer();
      http.status[res.status] = (http.status[res.status] || 0) + 1;
      const p = (http.byPath[path] ||= {});
      p[res.status] = (p[res.status] || 0) + 1;
      if (res.ok) http.ok += 1; else http.errors += 1;
    } catch { http.errors += 1; http.status.network = (http.status.network || 0) + 1; }
    http.latencies.push(now() - t0);
  }
}

async function spike(n) {
  const t0 = now();
  const results = await Promise.allSettled(Array.from({ length: n }, () =>
    fetch(`${BASE}/api/v1/boards`, { headers: { Connection: 'close' }, cache: 'no-store' }).then(async (r) => { await r.arrayBuffer(); return r.status; })));
  const statuses = {};
  for (const r of results) { const k = r.status === 'fulfilled' ? r.value : 'network'; statuses[k] = (statuses[k] || 0) + 1; }
  return { requests: n, ms: Math.round(now() - t0), statuses };
}

// ── Metrics scrape ────────────────────────────────────────────────────────────
const WANT = /^(process_cpu_seconds_total|process_resident_memory_bytes|nodejs_eventloop_lag_p99_seconds|bb_pgbouncer_pool|bb_pg_server_connections|bb_pg_pool_connections|bb_realtime_delivery|bb_sse_connections|bb_redis_up|bb_realtime_events_total|bb_realtime_payload_bytes_total|bb_pg_connect_errors_total)\b/;
async function scrape() {
  const out = {};
  await Promise.all(METRICS_URLS.map(async (u) => {
    try {
      const r = await fetch(u, { headers: METRICS_TOKEN ? { Authorization: `Bearer ${METRICS_TOKEN}` } : {} });
      out[u] = (await r.text()).split('\n').filter((l) => WANT.test(l));
    } catch (e) { out[u] = [`unreachable: ${e.message}`]; }
  }));
  return out;
}

// ── Run ──────────────────────────────────────────────────────────────────────
const started = new Date().toISOString();
const before = await scrape();
const sseAbort = new AbortController();

const sockets = [];
for (let i = 0; i < SOCKETS; i += 100) {
  sockets.push(...await Promise.all(Array.from({ length: Math.min(100, SOCKETS - i) }, openSocket)));
}
const sses = [];
for (let i = 0; i < SSE_CLIENTS; i += 100) {
  sses.push(...await Promise.all(Array.from({ length: Math.min(100, SSE_CLIENTS - i) }, () => openSse(sseAbort.signal))));
}

const t0 = now();
const until = t0 + DURATION;
const loops = Array.from({ length: HTTP_CONCURRENCY }, () => httpLoop(until));
let spikeResult = null;
if (CONNECT_SPIKE > 0) {
  await new Promise((r) => setTimeout(r, DURATION / 2));
  spikeResult = await spike(CONNECT_SPIKE);
}
await Promise.all(loops);
const elapsed = (now() - t0) / 1000;
await new Promise((r) => setTimeout(r, 1500));   // let the last events land
const after = await scrape();

for (const s of sockets) { try { s?.ws.close(); } catch {} }
sseAbort.abort();

const live = [...sockets.filter(Boolean).map((s) => s.t), ...sses.filter(Boolean)];
const avg = (event) => (rt.events[event] ? Math.round(rt.bytes[event] / rt.events[event]) : null);
console.log(JSON.stringify({
  started, base: BASE, durationSec: Math.round(elapsed),
  config: { SOCKETS, SSE_CLIENTS, HTTP_CONCURRENCY, CONNECT_SPIKE, PATHS },
  http: {
    requests: http.ok + http.errors, rps: Math.round((http.ok + http.errors) / elapsed),
    errorRate: http.ok + http.errors ? Number((http.errors / (http.ok + http.errors)).toFixed(4)) : null,
    p50ms: pct(http.latencies, 50), p95ms: pct(http.latencies, 95), p99ms: pct(http.latencies, 99), status: http.status, byPath: http.byPath,
  },
  spike: spikeResult,
  realtime: {
    socketsOpen: rt.socketsOpen, socketsFailed: rt.socketsFailed, sseOpen: rt.sseOpen, sseFailed: rt.sseFailed,
    clientsThatSawAPhase: live.filter((t) => t.phases > 0).length, clients: live.length,
    orderViolations: rt.orderViolations, decodeFailures: rt.decodeFailures,
    events: rt.events,
    avgBytes: { cycle_phase: avg('sse:cycle_phase') ?? avg('socket:cycle_phase'), cycle_result: avg('sse:cycle_result') ?? avg('socket:cycle_result') },
  },
  metricsBefore: before, metricsAfter: after,
}, null, 2));
process.exit(0);
