// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file.
/**
 * realtime-connections.mjs — connection-fan-out load for the snapshot rework.
 *
 * WHAT IT ANSWERS
 * The bet harness (bet-contention.js) measures the WRITE ceiling. This measures
 * the DELIVERY ceiling the snapshot rework targets: with N concurrent public
 * clients connected and bets flowing, does the server hold up — and does the
 * coalescing actually bound the fan-out?
 *
 * ── READ THIS BEFORE TRUSTING A NUMBER FROM IT ───────────────────────────────
 * Since 2026-09-01 the SSE pool stream is SUBSCRIBED, not broadcast: a
 * connection that does not pass `?cycles=` receives no `bet_placed` at all
 * (sseManager cycle topics; see REALTIME_SNAPSHOTS.md). A run with `CYCLES`
 * unset therefore reports a near-zero event rate — and that is not a result, it
 * is the harness measuring nothing. It looks like a spectacular improvement,
 * which is exactly why this paragraph is here.
 *
 * The connection mix is the point, because the two populations cost different
 * amounts and production has both:
 *   - `FALLBACK_PCT` of connections subscribe to `CYCLES` — these model a client
 *     whose WebSocket is blocked, for which SSE is the only live-pool path.
 *   - the rest subscribe to nothing — these model the normal client, which gets
 *     pool movement over its Socket.IO room and holds SSE only for the global
 *     events (cycle_result, system_config, branding).
 * Set FALLBACK_PCT=100 to measure the worst case (every client on the fallback);
 * that is the number that bounds the transport, not the expected one.
 *
 * The numbers that prove the rework, scraped from GET /metrics while the bet
 * harness drives 500–800 bets/sec:
 *   bb_realtime_stats{metric="snapshots_published"}  ~= live cycles/sec, NOT
 *     bets/sec. If snapshots track bets, coalescing is broken. This is ORIGIN
 *     work and is unaffected by who subscribes.
 *   sse.cycleSubscriptions (GET /api/sse/stats)      == CONN × FALLBACK_PCT ×
 *     |CYCLES|. If it is higher, subscriptions are leaking on disconnect; if it
 *     is zero, the harness is measuring nothing — see above.
 *   nodejs_eventloop_lag_seconds                     stays low as N climbs.
 *     This is what actually degrades under realtime overload.
 *
 * ZERO DEPENDENCIES — built-in http/https only, so it runs on any box with Node
 * and nothing installed. It opens N Server-Sent-Events connections and reports
 * events/sec, p50/p95 inter-event gap, and bytes, split by population. Socket.IO
 * room delivery (pool_update) is a faithful follow-up with the panels'
 * socket.io-client or artillery-socketio; the coalescing win is
 * transport-agnostic, so this SSE harness already exercises the dominant lever.
 *
 * ── NOT RUN HERE. Staging only. Never point at production. ────────────────────
 * Like the bet harness, no numbers exist until you run this on a load-gen box
 * against a deployed instance. Treat any capacity claim as unverified until then
 * — and report MEASURED p95/lag/CPU, never a benchmark guess (design item 17).
 *
 * USAGE
 *   SSE_URL="https://staging.example/api/sse/events" \
 *   CYCLES="cycle_1m_...,cycle_30m_...,cycle_fd_..." FALLBACK_PCT=100 \
 *   CONN=2000 DURATION=60 node loadtest/realtime-connections.mjs
 *   # ramp: run again at CONN=5000, then CONN=10000, watching /metrics each time.
 *   # Get live cycle ids from GET /api/v1/game/cycles.
 *
 * FOR THE 1-MINUTE BOARD specifically, hold the run across a cycle ROLLOVER.
 * A 1_MIN board settles 60 times an hour rather than twice, so the boundary —
 * settlement opening, the per-cycle advisory lock refusing in-flight bets,
 * every client re-subscribing to the new cycle id — stops being a rare event and
 * becomes the steady state. A 60-second run that happens to sit inside one
 * cycle measures the easy part. DURATION=300 crosses five of them.
 */
import http from 'node:http';
import https from 'node:https';

const SSE_URL   = process.env.SSE_URL || 'http://127.0.0.1:5000/api/sse/events';
const CONN      = Math.max(1, Number(process.env.CONN) || 2000);
const DURATION  = Math.max(5, Number(process.env.DURATION) || 60);   // seconds
const RAMP_MS   = Math.max(0, Number(process.env.RAMP_MS) || 10_000); // spread connects to avoid a thundering herd
const COOKIE    = process.env.COOKIE || '';                           // optional auth cookie
/** Cycle ids the fallback population subscribes to. Empty = measures nothing. */
const CYCLES    = (process.env.CYCLES || '').split(',').map((s) => s.trim()).filter(Boolean);
/** Share of connections that take the SSE fallback path and subscribe. */
const FALLBACK_PCT = Math.min(100, Math.max(0, Number(process.env.FALLBACK_PCT ?? 100)));

if (!CYCLES.length) {
  console.warn(
    '\n[realtime-load] WARNING: CYCLES is unset, so every connection subscribes to NOTHING\n'
    + '                and the server will send no bet_placed at all. The event rate below\n'
    + '                will be near zero. That is the harness measuring nothing, NOT a result.\n'
    + '                Pass CYCLES=<live cycle ids> — see the header.\n',
  );
}

const isHttps = SSE_URL.startsWith('https://');
const agent = new (isHttps ? https : http).Agent({ keepAlive: true, maxSockets: Infinity, maxFreeSockets: Infinity });

let connected = 0, failed = 0, events = 0, bytes = 0;
let subscribers = 0, poolEvents = 0;
const gaps = [];            // inter-event ms, sampled
let lastEventAt = 0;

/** Subscribe this connection, or not, per the modelled mix. */
function urlFor(index) {
  const subscribed = CYCLES.length && (index % 100) < FALLBACK_PCT;
  if (!subscribed) return { url: SSE_URL, subscribed: false };
  const sep = SSE_URL.includes('?') ? '&' : '?';
  return { url: `${SSE_URL}${sep}cycles=${CYCLES.map(encodeURIComponent).join(',')}`, subscribed: true };
}

function openOne(index) {
  const lib = isHttps ? https : http;
  const { url, subscribed } = urlFor(index);
  if (subscribed) subscribers++;
  const req = lib.get(url, {
    agent,
    headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache', ...(COOKIE ? { Cookie: COOKIE } : {}) },
  }, (res) => {
    if (res.statusCode !== 200) { failed++; res.resume(); return; }
    connected++;
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      bytes += chunk.length;
      // Count SSE event frames (lines beginning "data:"). Sampling the gap on a
      // fraction keeps the array bounded at high connection counts.
      const n = (chunk.match(/\ndata:/g) || []).length + (chunk.startsWith('data:') ? 1 : 0);
      // Counted separately: `bet_placed` is the only per-cycle event, so it is
      // the one that answers "did scoping actually change the delivery count".
      // Global events (cycle_result, system_config) still go to everyone and
      // would mask the difference if lumped in.
      poolEvents += (chunk.match(/event: bet_placed/g) || []).length;
      if (n > 0) {
        events += n;
        const now = Date.now();
        if (lastEventAt && gaps.length < 200_000) gaps.push(now - lastEventAt);
        lastEventAt = now;
      }
    });
    res.on('end', () => { connected--; });
    res.on('error', () => { connected--; failed++; });
  });
  req.on('error', () => { failed++; });
  req.setTimeout(0);
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

console.log(`[realtime-load] target=${SSE_URL} conn=${CONN} duration=${DURATION}s ramp=${RAMP_MS}ms`);
console.log(`[realtime-load] cycles=[${CYCLES.join(', ') || 'NONE'}] fallbackPct=${FALLBACK_PCT}%`);
const perTick = Math.max(1, Math.ceil(CONN / Math.max(1, RAMP_MS / 50)));
let opened = 0;
const ramp = setInterval(() => {
  for (let i = 0; i < perTick && opened < CONN; i++) { openOne(); opened++; }
  if (opened >= CONN) clearInterval(ramp);
}, 50);

const report = setInterval(() => {
  console.log(
    `  t+${new Date().toISOString().slice(11, 19)} open=${connected} subs=${subscribers} failed=${failed}`
    + ` events/s≈${events} pool/s≈${poolEvents} bytes=${(bytes / 1e6).toFixed(1)}MB`
    + ` p50gap=${pct(gaps, 50)}ms p95gap=${pct(gaps, 95)}ms`,
  );
  events = 0; poolEvents = 0; // per-second, since last tick
}, 1000);

setTimeout(() => {
  clearInterval(report); clearInterval(ramp);
  console.log(`\n[realtime-load] DONE. peakOpen≈${connected} subscribers=${subscribers} failed=${failed} totalBytes=${(bytes / 1e6).toFixed(1)}MB p95gap=${pct(gaps, 95)}ms`);
  console.log('  → GET /metrics: snapshots_published tracks live-cycles/sec, NOT bets/sec; nodejs_eventloop_lag_seconds stays low.');
  console.log(`  → GET /api/sse/stats: cycleSubscriptions should be ≈ ${subscribers * Math.max(1, CYCLES.length)} (subscribers × cycles).`);
  console.log('    Higher means subscriptions leak on disconnect. Zero with CYCLES set means the query param is not reaching the route.');
  if (!CYCLES.length) {
    console.log('  → CYCLES was unset: the pool rate above is meaningless. This run measured global events only.');
  }
  process.exit(0);
}, DURATION * 1000);
