// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the item-9 bounded load-shedder (pure — no DB, no server).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadShed, _loadShedState, _setLoadShedConfig } from '../../middleware/loadShed.js';

// Minimal Express req/res doubles. res collects status + captures finish/close
// handlers so a test can "complete" a request and watch the counter drop.
function makeReq(path) { return { path, method: 'GET' }; }
function makeRes() {
  const handlers = {};
  return {
    statusCode: 200, body: null, headers: {},
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this._done?.(); return this; },
    on(evt, fn) { handlers[evt] = fn; },
    _finish() { handlers.finish?.(); },
    _close() { handlers.close?.(); },
  };
}

beforeEach(() => {
  // Drain any counter a previous test left behind: go unbounded first so the
  // draining requests are admitted (not shed), complete them, then set config.
  _setLoadShedConfig({ enabled: true, maxInFlight: 0, maxEventLoopLagMs: 0 });
  const { inFlight } = _loadShedState();
  for (let i = 0; i < inFlight; i++) { const r = makeRes(); loadShed(makeReq('/x'), r, () => {}); r._finish(); }
  _setLoadShedConfig({ enabled: true, maxInFlight: 2, maxEventLoopLagMs: 0 });
});

describe('loadShed', () => {
  it('exempts health/metrics/SSE even when the cap is full', () => {
    _setLoadShedConfig({ enabled: true, maxInFlight: 1 });
    const r = makeRes(); loadShed(makeReq('/api/x'), r, () => {}); // fill the single slot
    expect(_loadShedState().inFlight).toBe(1);
    for (const p of ['/health', '/metrics', '/api/v1/health', '/api/sse/stream']) {
      const res = makeRes(); let passed = false;
      loadShed(makeReq(p), res, () => { passed = true; });
      expect(passed).toBe(true);           // exempt → admitted despite full cap
      expect(res.statusCode).toBe(200);
    }
    r._finish();
  });

  it('passes through under the cap and counts in-flight', () => {
    const res = makeRes(); let passed = false;
    loadShed(makeReq('/api/bet'), res, () => { passed = true; });
    expect(passed).toBe(true);
    expect(_loadShedState().inFlight).toBe(1);
    res._finish();
    expect(_loadShedState().inFlight).toBe(0);
  });

  it('sheds with 503 + Retry-After once the cap is reached', () => {
    const held = [];
    for (let i = 0; i < 2; i++) { const r = makeRes(); loadShed(makeReq('/api/x'), r, () => {}); held.push(r); }
    expect(_loadShedState().inFlight).toBe(2);

    const res = makeRes(); let passed = false;
    loadShed(makeReq('/api/x'), res, () => { passed = true; });
    expect(passed).toBe(false);              // NOT admitted
    expect(res.statusCode).toBe(503);
    expect(res.headers['Retry-After']).toBe('2');
    expect(res.body.retryAfter).toBe(2);

    held[0]._finish();                        // a slot frees up
    const res2 = makeRes(); let passed2 = false;
    loadShed(makeReq('/api/x'), res2, () => { passed2 = true; });
    expect(passed2).toBe(true);               // now admitted
    held[1]._finish(); res2._finish();
  });

  it('when disabled, never sheds', () => {
    _setLoadShedConfig({ enabled: false, maxInFlight: 1 });
    for (let i = 0; i < 5; i++) {
      const res = makeRes(); let passed = false;
      loadShed(makeReq('/api/x'), res, () => { passed = true; });
      expect(passed).toBe(true);
      res._finish();
    }
  });

  it('close (client hangup) also frees the slot', () => {
    const res = makeRes();
    loadShed(makeReq('/api/x'), res, () => {});
    expect(_loadShedState().inFlight).toBe(1);
    res._close();
    expect(_loadShedState().inFlight).toBe(0);
  });
});
