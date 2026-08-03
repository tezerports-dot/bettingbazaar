// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
// Unit tests for the item-3 backoff+jitter utility (pure, no DB). Proves the
// jitter actually spreads retries and that fetchWithRetry retries the right
// statuses and stops on the wrong ones.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { computeBackoffDelay, retryWithBackoff, fetchWithRetry } from '../../utils/retry.js';

afterEach(() => vi.restoreAllMocks());

describe('computeBackoffDelay', () => {
  it("'none' is deterministic exponential (base·2^(n-1))", () => {
    const o = { baseMs: 100, factor: 2, jitter: 'none', capMs: 1e9 };
    expect(computeBackoffDelay(1, o)).toBe(100);
    expect(computeBackoffDelay(2, o)).toBe(200);
    expect(computeBackoffDelay(3, o)).toBe(400);
    expect(computeBackoffDelay(4, o)).toBe(800);
  });

  it('caps the ceiling at capMs', () => {
    expect(computeBackoffDelay(20, { baseMs: 100, capMs: 5000, jitter: 'none' })).toBe(5000);
  });

  it("'full' jitter draws from [0, ceiling] — rng=0 → 0, rng≈1 → ceiling", () => {
    const o = { baseMs: 100, factor: 2, jitter: 'full', capMs: 1e9 };
    expect(computeBackoffDelay(3, { ...o, rng: () => 0 })).toBe(0);
    expect(computeBackoffDelay(3, { ...o, rng: () => 0.999999 })).toBe(400);
    expect(computeBackoffDelay(3, { ...o, rng: () => 0.5 })).toBe(200);
  });

  it("'equal' jitter is half-fixed + half-random", () => {
    const o = { baseMs: 100, factor: 2, jitter: 'equal', capMs: 1e9 };
    expect(computeBackoffDelay(3, { ...o, rng: () => 0 })).toBe(200);   // ceiling/2
    expect(computeBackoffDelay(3, { ...o, rng: () => 1 })).toBe(400);   // ceiling
  });

  it('full jitter actually spreads: 200 draws are not all equal', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(computeBackoffDelay(5, { baseMs: 50, jitter: 'full' }));
    expect(seen.size).toBeGreaterThan(50); // would be 1 with no jitter
  });
});

describe('retryWithBackoff', () => {
  it('resolves after transient failures', async () => {
    let calls = 0;
    const v = await retryWithBackoff(async () => {
      calls++;
      if (calls < 3) throw new Error('flaky');
      return 'ok';
    }, { retries: 5, baseMs: 1, capMs: 2 });
    expect(v).toBe('ok');
    expect(calls).toBe(3);
  });

  it('throws the last error once retries are exhausted', async () => {
    let calls = 0;
    await expect(retryWithBackoff(async () => { calls++; throw new Error('down'); },
      { retries: 2, baseMs: 1, capMs: 2 })).rejects.toThrow('down');
    expect(calls).toBe(3); // 1 initial + 2 retries
  });

  it('does not retry when shouldRetry says no', async () => {
    let calls = 0;
    await expect(retryWithBackoff(async () => { calls++; const e = new Error('4xx'); e.status = 400; throw e; },
      { retries: 5, baseMs: 1, shouldRetry: (e) => e.status >= 500 })).rejects.toThrow('4xx');
    expect(calls).toBe(1);
  });
});

describe('fetchWithRetry', () => {
  it('retries a 503 then succeeds', async () => {
    let n = 0;
    global.fetch = vi.fn(async () => {
      n++;
      return { status: n < 2 ? 503 : 200 };
    });
    const res = await fetchWithRetry('http://1.1.1.1', {}, { retries: 3, baseMs: 1, capMs: 2, timeoutMs: 50 });
    expect(res.status).toBe(200);
    expect(n).toBe(2);
  });

  it('does NOT retry a 400 (client error)', async () => {
    let n = 0;
    global.fetch = vi.fn(async () => { n++; return { status: 400 }; });
    const res = await fetchWithRetry('http://1.1.1.1', {}, { retries: 3, baseMs: 1, timeoutMs: 50 });
    expect(res.status).toBe(400);
    expect(n).toBe(1);
  });
});
