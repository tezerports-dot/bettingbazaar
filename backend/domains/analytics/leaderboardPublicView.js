// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * leaderboardPublicView.js — what an unauthenticated visitor is told about the
 * players at the top of the board.
 *
 * Lives beside the other analytics reads because its source is
 * `db.stats.leaderboard()`; it is the same shape as `cyclePublicView.js`, one
 * projection in one file (§24).
 *
 * ── Why it exists ──────────────────────────────────────────────────────────
 * `GET /api/leaderboard/:period` needs no authentication, and it returned the
 * repository row whole — including `userId`, **the internal identifier every
 * user-scoped API takes**.
 *
 * That is the wrong thing to publish for a reason that has little to do with
 * the leaderboard: it sets the price of every other flaw. An IDOR against
 * random ids is a theory; the same IDOR against fifty ids the platform hands
 * out, ordered by how much money each player has, is a script. It is also the
 * join key that makes correlating one player across endpoints possible.
 *
 * The panel never needed it: it used `userId` as a React `key` and nothing
 * else, and `rank` is unique within the list and does the same job.
 *
 * ── Why a projection and not a `delete` ────────────────────────────────────
 * §24: an allowlist fails closed and its symptom is a blank field somebody
 * notices; a denylist admits the next field added upstream by default, and the
 * mistake is always "too much". The source is an aggregate over `bets` joined
 * to `users`, so the next column added to that SELECT would have been
 * published on the day it was added.
 *
 * ── Why it filters on the way OUT, not only at rebuild ─────────────────────
 * Entries are cached as JSONB in `leaderboard_cache` and rebuilt on a schedule.
 * Rows written before this existed still carry `userId`, so stripping it only
 * at rebuild would keep publishing it until the next run. This is the boundary,
 * so this is where it stops.
 *
 * `realWinners` in `repositories/engagement.js` already had the right shape —
 * it SELECTs `user_id` and its mapper simply never emits it. This brings the
 * leaderboard into line with the feed beside it.
 */

/** Everything a public leaderboard entry may contain. Nothing else travels. */
export const PUBLIC_LEADERBOARD_FIELDS = Object.freeze([
  'rank',
  'username',
  'totalBets',
  'wins',
  'totalStaked',
  'totalWon',
  'netProfit',
  'winRate',
]);

/**
 * @param {object} entry a row from `db.stats.leaderboard()` or from the cache
 * @returns {object} only the permitted keys
 */
export function publicLeaderboardEntry(entry) {
  const out = {};
  for (const key of PUBLIC_LEADERBOARD_FIELDS) {
    if (entry?.[key] !== undefined) out[key] = entry[key];
  }
  return out;
}

/** The whole board. A non-array is an empty board, never a thrown route. */
export function publicLeaderboard(entries) {
  return Array.isArray(entries) ? entries.map(publicLeaderboardEntry) : [];
}
