// GOVERNANCE: Read 04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * utils/retry.js — Exponential backoff WITH JITTER (plan-adjacent item 3). 2026-07-13.
 *
 * THE PROBLEM this solves (owner's words): when many clients/workers retry a
 * failed dependency, plain exponential backoff makes them all wake at the SAME
 * moment (base, 2·base, 4·base …) — a synchronized "thundering herd" that hits
 * the recovering service in lockstep and knocks it over again. JITTER adds
 * randomness so the retries SPREAD across the window instead of stacking on one
 * instant.
 *
 * Algorithm: AWS "Exponential Backoff And Jitter" (Marc Brooker). For attempt n
 * the exponential ceiling is min(capMs, baseMs · factor^(n-1)); the actual delay
 * is drawn from it per the jitter mode:
 *   - 'full'  (default): delay = random(0, ceiling)          ← max spread, recommended
 *   - 'equal':           delay = ceiling/2 + random(0, ceiling/2)
 *   - 'none':            delay = ceiling                       ← no jitter (comparison/debug)
 *
 * This is a PURE utility (no app imports) so anything — outbound webhooks, SMS/
 * email adapters, payment-provider calls, health probes — can share ONE correct
 * retry policy instead of re-implementing (usually wrongly) its own. Timing knobs
 * default sensibly and are overridable per call; where a caller's retry budget is
 * a business decision, it passes values sourced from admin config (see callers).
 */

/** Sleep that resolves early (rejecting) if an AbortSignal fires. */
export function sleep(ms, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    if (t.unref) t.unref();
    if (signal) {
      signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    }
  });
}

/**
 * computeBackoffDelay — the delay (ms) for a given 1-based attempt number.
 * Exposed on its own so it can be unit-tested deterministically (inject rng)
 * and reused by non-Promise schedulers (e.g. a BullMQ custom backoff strategy).
 *
 * @param {number} attempt  1-based retry attempt (1 = first retry)
 * @param {object} opts     { baseMs, capMs, factor, jitter, rng }
 * @returns {number} milliseconds to wait, always in [0, capMs]
 */
export function computeBackoffDelay(attempt, opts = {}) {
  const { baseMs = 200, capMs = 10_000, factor = 2, jitter = 'full', rng = Math.random } = opts;
  const n = Math.max(1, attempt);
  const ceiling = Math.min(capMs, baseMs * Math.pow(factor, n - 1));
  switch (jitter) {
    case 'none':  return Math.round(ceiling);
    case 'equal': return Math.round(ceiling / 2 + rng() * (ceiling / 2));
    case 'full':
    default:      return Math.round(rng() * ceiling);
  }
}

/**
 * retryWithBackoff — run fn(), retrying failures with jittered exponential backoff.
 *
 * @param {(attempt:number)=>Promise<*>} fn          the operation (0-based attempt index)
 * @param {object} opts
 * @param {number} opts.retries      max RETRIES after the first try (default 3 → up to 4 attempts)
 * @param {number} opts.baseMs       base delay (default 200)
 * @param {number} opts.capMs        max single delay (default 10s)
 * @param {number} opts.factor       exponential factor (default 2)
 * @param {'full'|'equal'|'none'} opts.jitter  jitter mode (default 'full')
 * @param {(err:Error)=>boolean} opts.shouldRetry  gate (default: retry all)
 * @param {(err:Error,attempt:number,delayMs:number)=>void} opts.onRetry  observability hook
 * @param {AbortSignal} opts.signal  cancels pending sleeps
 * @returns {Promise<*>} fn's resolved value, or throws the last error
 */
export async function retryWithBackoff(fn, opts = {}) {
  const {
    retries = 3, baseMs = 200, capMs = 10_000, factor = 2, jitter = 'full',
    shouldRetry = () => true, onRetry = null, signal = null,
  } = opts;
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      attempt++;
      if (attempt > retries || !shouldRetry(err)) throw err;
      const delayMs = computeBackoffDelay(attempt, { baseMs, capMs, factor, jitter });
      if (onRetry) { try { onRetry(err, attempt, delayMs); } catch { /* hook must not break retry */ } }
      await sleep(delayMs, signal);
    }
  }
}

/**
 * fetchWithRetry — retryWithBackoff around fetch() with a per-attempt timeout.
 * Retries network errors and retryable HTTP statuses (429, 502, 503, 504) —
 * NOT 4xx (a bad request won't get better by repeating). Honors an upstream
 * Retry-After header when present (bounded by capMs). Fire-and-forget callers
 * still wrap this in try/catch — it can throw after exhausting retries.
 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
export async function fetchWithRetry(url, init = {}, opts = {}) {
  const { timeoutMs = 5000, ...retryOpts } = opts;
  return retryWithBackoff(async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { ...init, signal: ctrl.signal });
    } finally { clearTimeout(t); }
    if (RETRYABLE_STATUS.has(res.status)) {
      const e = new Error(`HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return res;
  }, { shouldRetry: (e) => e.status == null || RETRYABLE_STATUS.has(e.status), ...retryOpts });
}
