// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * winners.ranking.js — how the public winners board is ordered.
 *
 * Its own module, rather than a `.sort()` inside the route handler, for two
 * reasons. The ordering is the entire feature — `/api/v1/winners` sorted by
 * `displayTime` for as long as it existed, under a nav item called "Top
 * Winners" and a page subtitled "Biggest wins right now", and nothing about the
 * response shape gave that away — so it needs a test. And a pure ranking
 * function has no business reaching `mongoose`, PASETO and the auth middleware
 * through its own import graph, which is what testing it from the route file
 * would require.
 */

/** Board size when the caller does not say. The client asks for 20. */
export const DEFAULT_WINNERS_LIMIT = 20;
/** Hard ceiling: `limit` sizes a read of the largest collection in the system. */
export const MAX_WINNERS_LIMIT = 50;

/**
 * Rank the merged board: biggest amount won first.
 *
 * Ties break on recency, so the order is deterministic rather than dependent on
 * which source happened to be concatenated first — two equal payouts must not
 * swap places between two requests over the same data. Copies rather than
 * sorting in place, because the caller builds the input from two queries it may
 * still be holding.
 */
export function rankWinners(entries, limit = DEFAULT_WINNERS_LIMIT) {
  return [...entries]
    .sort((a, b) => (b.amount || 0) - (a.amount || 0)
                 || new Date(b.displayTime || 0).getTime() - new Date(a.displayTime || 0).getTime())
    .slice(0, limit);
}

/**
 * Clamp a caller-supplied `limit`.
 *
 * One rule: anything that is not a whole number of at least 1 is "unspecified"
 * and gets the default; then the ceiling applies. Written this way because
 * checking `Number.isFinite` alone is not enough — `Number(null)` and
 * `Number('')` are both `0`, so a bare `?limit=` sailed through the finite check
 * and came out of a `Math.max(1, …)` as a ONE-ENTRY leaderboard. Anything the
 * caller did not clearly ask for should land on the default, not on the edge of
 * the clamp.
 */
export function resolveWinnersLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_WINNERS_LIMIT;
  return Math.min(MAX_WINNERS_LIMIT, Math.floor(n));
}
