// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Starting against a database that is briefly not there (owner, 2026-10-24).
 *
 * The error log showed "Startup failed while preparing PostgreSQL: server login
 * has been failing": the connection pooler refused logins for a moment during a
 * restart. Startup gave up on that first refusal and closed its port, but the
 * process stayed alive (its timers held it open), so nothing restarted it. An
 * instance in that state runs no rounds: every board stops at 00:00 and the
 * admin sees no live cycle, with nothing to press.
 *
 * So a refusal that is about REACHING the database (a login the pooler is
 * holding back, a connection refused, reset or timed out, too many clients,
 * a server starting up) is retried with growing waits. Anything else (a
 * schema error) is not: retrying it changes nothing. And when startup does
 * fail, the process exits, so its supervisor starts a fresh one.
 */

/** The waits between tries, in ms: about two and a half minutes in all. */
export const DB_START_RETRY_WAITS_MS = Object.freeze([2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 60_000]);

const TRANSIENT_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE',
  '57P03', // the server is starting up or shutting down
  '53300', // too many clients
  '08000', '08001', '08003', '08004', '08006', // connection failures
]);

/** True when the error is about reaching the database, not about what was asked of it. */
export function isTransientDbStartError(error) {
  if (!error) return false;
  if (TRANSIENT_CODES.has(error.code)) return true;
  const msg = String(error.message ?? '');
  return /server login has been failing|connection terminated|timeout exceeded when trying to connect|Connection terminated unexpectedly|no more connections allowed|the database system is (starting up|shutting down)|getaddrinfo/i.test(msg);
}

/**
 * Run `step` until it succeeds, retrying only transient errors, waiting
 * `waits[i]` before try i+2. The last error is thrown when the waits run out
 * or the error is not transient.
 */
export async function retryTransientDbStart(step, {
  waits = DB_START_RETRY_WAITS_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = (line) => console.warn(line),
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await step();
    } catch (error) {
      if (!isTransientDbStartError(error) || attempt >= waits.length) throw error;
      log(`⚠️  PostgreSQL not reachable yet (${error.message}); trying again in ${Math.round(waits[attempt] / 1000)}s `
        + `(${attempt + 1} of ${waits.length})`);
      await sleep(waits[attempt]);
    }
  }
}
