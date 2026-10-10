// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * domains/markets/cycleTypes.js — the boards a cycle can run on, read from
 * the `boards` table (owner, 2026-10-08: admins create any number of board
 * games, each with its own timer, and order them on the home page).
 *
 * A cycle's `type` is its board's key. Everything that used to be a fixed
 * per-type literal here (label, id prefix, block length, phase offsets, stake
 * bounds) is a column of the board's row, written only by
 * `database/repositories/boards.js` and held to the engine's invariants by the
 * schema (`boards_timer_runs`, `boards_phases_ordered`, `boards_stakes`). So no
 * caller validates a board's timings or falls back to a default: a row that
 * exists can run.
 *
 * Read through a short cache because the cycle tick asks every second. An
 * admin's change calls `invalidateBoards()` on this instance; another instance
 * sees it within `BOARDS_CACHE_MS`. A changed timer applies from the board's
 * next round: a round already open keeps the start and end it was created with.
 *
 * Callers ask `boardOf(type)` and treat `null` as "no such board": loud and
 * skipped, never defaulted (a guessed board would close betting or declare a
 * winner at an arbitrary moment).
 */
import { db } from '#db';

/** How stale a board read may be on an instance that did not make the change. */
export const BOARDS_CACHE_MS = 5000;

let cache = null;
let cachedAt = 0;
let inflight = null;

async function load() {
  const list = await db.boards.listBoards();
  cache = { list, byKey: new Map(list.map((b) => [b.key, b])) };
  cachedAt = Date.now();
  return cache;
}

async function boards() {
  if (cache && Date.now() - cachedAt < BOARDS_CACHE_MS) return cache;
  if (!inflight) inflight = load().finally(() => { inflight = null; });
  return inflight;
}

/** Drop the cache; the next read goes to the database. Called after every board write. */
export function invalidateBoards() {
  cache = null;
  cachedAt = 0;
}

/** Every board, switched on or off, in home-page order. */
export async function allBoards() {
  return (await boards()).list;
}

/** The boards players see and the engine starts new rounds on, in home-page order. */
export async function enabledBoards() {
  return (await boards()).list.filter((b) => b.enabled);
}

/** One board by key (switched off included: its open rounds still finish), or null. */
export async function boardOf(type) {
  return (await boards()).byKey.get(type) ?? null;
}

/** Name used in result announcements and logs. */
export function cycleLabel(board) {
  return board.name;
}

/** What players are told as a round moves on. */
export function boardMessages(board) {
  return {
    newCycle: `New ${board.name} round started!`,
  };
}

/** The public view of a board: what the player panel needs to draw and time it. */
export function publicBoard(b) {
  return {
    key: b.key,
    name: b.name,
    kind: b.kind,
    durationMin: b.durationMin,
    anchorHourIst: b.anchorHourIst,
    phases: { ...b.phases },
    minBet: b.minBet,
    maxBet: b.maxBet,
    homeOrder: b.homeOrder,
    // The panel attributes a legacy event that names only its cycleId by this.
    idPrefix: b.idPrefix,
  };
}
