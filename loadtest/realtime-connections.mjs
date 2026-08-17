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
 * The single number that proves the rework: while this holds N connections open
 * and the bet harness drives 500–800 bets/sec, scrape GET /metrics and confirm
 *   bb_realtime_stats{metric="snapshots_published"}   rises ~= (live cycles / sec)
 * NOT ~= (bets/sec). If snapshots track bets, coalescing is broken. Watch
 *   nodejs_eventloop_lag_seconds  — this is what actually degrades under
 * realtime overload; it must stay low as N climbs 2k → 5k → 10k.
 *
 * ZERO DEPENDENCIES — built-in http/https only, so it runs on any box with Node
 * and nothing installed. It opens N Server-Sent-Events connections (the app's
 * PRIMARY public transport) and reports events/sec, p50/p95 inter-event gap, and
 * bytes. Socket.IO room delivery (pool_update) is a faithful follow-up with the
 * panels' socket.io-client or artillery-socketio; the coalescing win is
 * transport-agnostic, so this SSE harness already exercises the dominant lever.
 *
 * ── NOT RUN HERE. Staging only. Never point at production. ────────────────────
 * Like the bet harness, no numbers exist until you run this on a load-gen box
 * against a deployed instance. Treat any capacity claim as unverified until then
 * — and report MEASURED p95/lag/CPU, never a benchmark guess (design item 17).
 *
 * USAGE
 *   SSE_URL="https://staging.example/api/sse/events" CONN=2000 DURATION=60 \
 *     node loadtest/realtime-connections.mjs
 *   # ramp: run again at CONN=5000, then CONN=10000, watching /metrics each time.
 */
import http from 'node:http';
import https from 'node:https';

const SSE_URL   = process.env.SSE_URL || 'http://127.0.0.1:5000/api/sse/events';
const CONN      = Math.max(1, Number(process.env.CONN) || 2000);
const DURATION  = Math.max(5, Number(process.env.DURATION) || 60);   // seconds
const RAMP_MS   = Math.max(0, Number(process.env.RAMP_MS) || 10_000); // spread connects to avoid a thundering herd
const COOKIE    = process.env.COOKIE || '';                           // optional auth cookie

const isHttps = SSE_URL.startsWith('https://');
const agent = new (isHttps ? https : http).Agent({ keepAlive: true, maxSockets: Infinity, maxFreeSockets: Infinity });

let connected = 0, failed = 0, events = 0, bytes = 0;
const gaps = [];            // inter-event ms, sampled
let lastEventAt = 0;

function openOne() {
  const lib = isHttps ? https : http;
  const req = lib.get(SSE_URL, {
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
const perTick = Math.max(1, Math.ceil(CONN / Math.max(1, RAMP_MS / 50)));
let opened = 0;
const ramp = setInterval(() => {
  for (let i = 0; i < perTick && opened < CONN; i++) { openOne(); opened++; }
  if (opened >= CONN) clearInterval(ramp);
}, 50);

const report = setInterval(() => {
  console.log(`  t+${new Date().toISOString().slice(11, 19)} open=${connected} failed=${failed} events/s≈${(events).toString()} bytes=${(bytes / 1e6).toFixed(1)}MB p50gap=${pct(gaps, 50)}ms p95gap=${pct(gaps, 95)}ms`);
  events = 0; // events/s since last tick
}, 1000);

setTimeout(() => {
  clearInterval(report); clearInterval(ramp);
  console.log(`\n[realtime-load] DONE. peakOpen≈${connected} failed=${failed} totalBytes=${(bytes / 1e6).toFixed(1)}MB p95gap=${pct(gaps, 95)}ms`);
  console.log('  → now read GET /metrics: snapshots_published should track live-cycles/sec, NOT bets/sec; nodejs_eventloop_lag_seconds should stay low.');
  process.exit(0);
}, DURATION * 1000);
