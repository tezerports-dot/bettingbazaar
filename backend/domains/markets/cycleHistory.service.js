// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * domains/markets/cycleHistory.service.js — the resolved-cycle feed, per type.
 *
 * ── Why this is per-type and not one list ──────────────────────────────────
 * Three places emitted `cycle_history`, and all three ran the same query: the
 * 50 most recent `RESULT_DECLARED` cycles, ALL TYPES TOGETHER, sorted by
 * `endTime`. With two types that was fine by accident — 30-minute blocks
 * arrive twice an hour, so 50 rows spanned about a day and both tabs were fed.
 *
 * It is not fine with three. A 1-minute block resolves 60 times an hour, so
 * the 50 most recent cycles are THE LAST 50 MINUTES AND NOTHING ELSE. The
 * 30-minute and full-day tabs would receive zero rows of their own type — and
 * the client does not render an empty tab, it renders a seeded fallback
 * sequence, so the starvation would have surfaced as three tabs of confident,
 * entirely invented streak analytics in a real-money product.
 *
 * The full-day tab was ALREADY starving on this for the same reason: about one
 * full-day cycle fits in a 50-row window shared with the 30-minute type.
 *
 * So the window is per type. Each type gets its own N most recent, which is
 * what every consumer actually wanted — the client buckets by type on arrival
 * regardless.
 *
 * ── Why callers say which types they are refreshing ────────────────────────
 * `fetchCycleHistory` returns `{ cycles, types }`, and `types` is the contract:
 * "this payload is authoritative for exactly these types". The post-result
 * broadcast sends ONE type (only that type's history changed — sending all
 * three after every 1-minute result is 3x the payload to every connected
 * client, 60 times an hour, to restate rows nobody's view changed), and the
 * client replaces just those types instead of clobbering the rest.
 *
 * ── The projection is not ours ─────────────────────────────────────────────
 * Rows go through `publicCycleView` like every other public cycle payload.
 * The three emitters each hand-rolled their own field list, which is precisely
 * the "three copies are three chances to forget a field" that
 * `cyclePublicView.js` exists to prevent — the pools here are combined totals,
 * so nothing leaked, but the next field added would have had to be remembered
 * three times.
 */
import { Cycle } from '../../models/index.js';
import { CYCLE_TYPE_VALUES, isCycleType } from './cycleTypes.js';
import { publicCycleView } from './cyclePublicView.js';

/**
 * Rows per type. Caps a `limit` a caller took from a query string.
 *
 * `DEFAULT_LIMIT` stays small because it is what every connect pays: enough to
 * draw the 60-bead roadmap immediately, on a metered handset connection, for
 * an anonymous visitor who may never open the analytics drawer.
 *
 * `MAX_SINGLE_TYPE` is the deep window the drawer asks for on demand — the
 * 1,440-result history the streak statistics are meant to describe (24h of
 * 1-minute blocks, 30 days of half-hour ones). About 288 KB of JSON.
 *
 * A multi-type request is capped much lower. Three deep windows in one message
 * is ~864 KB against socket.io's 1 MB default `maxHttpBufferSize`, so the
 * request that asks for everything is exactly the one that must not ask for
 * everything deeply. Deep windows are per type, one at a time, on request.
 */
export const DEFAULT_LIMIT = 50;
export const MAX_SINGLE_TYPE = 1440;
export const MAX_ALL_TYPES = 200;

/**
 * @param {number|string} limit
 * @param {number} typeCount how many types this request covers
 */
export function normaliseLimit(limit, typeCount) {
  const ceiling = typeCount === 1 ? MAX_SINGLE_TYPE : MAX_ALL_TYPES;
  const n = parseInt(limit, 10);
  if (!Number.isFinite(n)) return Math.min(DEFAULT_LIMIT, ceiling);
  return Math.min(Math.max(n, 1), ceiling);
}

/**
 * The most recent resolved cycles for one type, newest first.
 * Uses the `{type, status, endTime}` index — see cycle.model.js.
 */
async function historyForType(type, limit) {
  const cycles = await Cycle.find({ type, status: 'RESULT_DECLARED' })
    .sort({ endTime: -1 })
    .limit(limit)
    .lean();
  return cycles.map(publicCycleView);
}

/**
 * Resolved-cycle history.
 *
 * @param {object}   [opts]
 * @param {string[]} [opts.types]  which types to fetch; defaults to all of them.
 *                                 An unknown type is dropped rather than
 *                                 throwing — this feeds a broadcast, and one
 *                                 bad value from a socket client must not take
 *                                 the history away from everyone else.
 * @param {number}   [opts.limit]  rows PER TYPE (not in total). Capped at
 *                                 1,440 for a single type and 200 when several
 *                                 are asked for at once — see the constants.
 * @returns {Promise<{cycles: object[], types: string[]}>} newest first within
 *          each type; `types` names what the payload is authoritative for.
 */
export async function fetchCycleHistory({ types, limit } = {}) {
  const wanted = (Array.isArray(types) ? types : types ? [types] : CYCLE_TYPE_VALUES)
    .filter(isCycleType);
  if (wanted.length === 0) return { cycles: [], types: [] };

  const n = normaliseLimit(limit, wanted.length);
  const perType = await Promise.all(wanted.map((t) => historyForType(t, n)));

  return { cycles: perType.flat(), types: wanted };
}
