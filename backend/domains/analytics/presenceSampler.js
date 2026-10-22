// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Once a minute, this realtime worker records how many players hold a live
 * stream on it (`db.presence`, owner 2026-10-22: peak concurrent users). Runs
 * only where streams are served (`runtime.acceptsRealtime`, server.js). A
 * failed write is logged and the next minute tries again: the figure is a
 * report, nothing decides on it.
 */
import { hostname } from 'node:os';
import { db } from '#db';

const EVERY_MS = 60_000;
let timer = null;

/** Start sampling `countPlayers()` (a number). Returns a stop function. */
export function startPresenceSampler(countPlayers) {
  if (timer) return stopPresenceSampler;
  const workerId = `${hostname()}:${process.pid}`;
  let ticks = 0;
  const tick = async () => {
    try {
      await db.presence.recordSample(workerId, countPlayers());
      // Once a day per worker is plenty to keep the table trimmed.
      if (ticks++ % 1440 === 0) await db.presence.pruneSamples();
    } catch (e) {
      console.error('[presence] sample not recorded:', e.message);
    }
  };
  void tick();
  timer = setInterval(tick, EVERY_MS);
  timer.unref?.();
  return stopPresenceSampler;
}

export function stopPresenceSampler() {
  if (timer) clearInterval(timer);
  timer = null;
}
