// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * When the live stream has gone quiet under a board (owner report,
 * 2026-10-19: "the cycles sometimes stick at 00:00").
 *
 * Every phase change and every new round reaches the player app only as a
 * push. A stream can stay "open" over a dead socket (a laptop waking from
 * sleep, a Wi-Fi change, a tab the browser froze in the background), and
 * nothing then moves the board on: the timer reaches 00:00 and stays there,
 * still "NEXT RESULT IN", until a reload. The native shell already reopens
 * the stream on every foreground; the web app had no such step.
 *
 * A round's result lands about 10 s after its end and the next round's
 * `new_cycle` shortly after, so a board whose round ended
 * `STALE_AFTER_END_MS` ago and is still on that round is not waiting for the
 * server: the app missed the pushes. Reopening the stream makes the server
 * send its `cycle_snapshot` again. Display only (§11): the server decides
 * every phase; this only asks it again.
 */

/** How long past a round's end the app waits for the next round before asking again. */
export const STALE_AFTER_END_MS = 45_000;
/** At most one reopen in this long, so a server that is itself late is not hammered. */
export const REOPEN_AT_MOST_EVERY_MS = 60_000;
/** A tab hidden longer than this reopens the stream when it is shown again. */
export const HIDDEN_LONG_MS = 30_000;

/** Whether any board still shows a round that ended `STALE_AFTER_END_MS` or more ago. */
export function hasStaleRound(cycles: Record<string, { endTime?: number } | undefined>, now: number): boolean {
  return Object.values(cycles).some((c) => {
    const end = Number(c?.endTime) || 0;
    return end > 0 && now - end >= STALE_AFTER_END_MS;
  });
}

/** Whether a reopen is allowed now, given the last one. */
export function mayReopen(lastReopenAt: number, now: number): boolean {
  return now - lastReopenAt >= REOPEN_AT_MOST_EVERY_MS;
}
