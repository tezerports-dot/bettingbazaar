// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The server's clock, as this phone sees it (owner, 2026-10-22).
 *
 * A round's `endTime` is the SERVER's time. Counting down to it with the
 * phone's `Date.now()` made the timer, the bet buttons and the stale-round
 * watchdog only as right as the phone's clock: a phone 20 s fast showed 20 s
 * less, greyed the buttons 20 s early, and reopened the stream every minute
 * believing each round was stuck. Only the display was wrong — the server
 * refuses a late bet by its own clock whatever the phone shows
 * (`bet.routes.js`, "Time backstop") — but the display is what the player bets by.
 *
 * Every stream event that carries the server time (`ts`, `timestamp`,
 * `serverTime`) is a sample of `server − phone`, taken as it arrives
 * (`realBackend.ts`). No request is added: the events already carry it.
 * Delivery only ever makes a sample SMALLER than the true offset, so the
 * largest of the last few is the closest; keeping only a few lets a phone
 * whose clock is changed mid-session follow within a few events.
 */

const KEEP = 5;
/** An epoch-ms server time is at least this; anything smaller is not one. */
const MIN_EPOCH_MS = 1e12;

let samples: number[] = [];
let offsetMs = 0;

/** Record a server time from a stream event, received at `receivedAtMs`. */
export function noteServerTime(serverMs: unknown, receivedAtMs: number = Date.now()): void {
  if (typeof serverMs !== 'number' || !Number.isFinite(serverMs) || serverMs < MIN_EPOCH_MS) return;
  samples = [...samples.slice(-(KEEP - 1)), serverMs - receivedAtMs];
  offsetMs = Math.max(...samples);
}

/** Now, on the server's clock. Before the first sample, the phone's. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}
