// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
// ─── App identity ─────────────────────────────────────────────────────────────

  // use branding.userPanelName at runtime
// APP_VERSION: read from import.meta.env.VITE_APP_VERSION (set from package.json by Vite).
// Do not add a literal version string here — GOVERNANCE §8.

// Chips and the analytics window are DERIVED from the board the player is on
// (`GET /api/v1/boards`): boards are rows an admin creates (owner, 2026-10-08),
// so a table keyed by board would miss every board created after it.

/**
 * The quick-bet chip ladder (owner, 2026-10-10): 10 · 30 · 90 · 270 · 810 on
 * every board, and a 10× switch that scales the whole ladder up or down a
 * step at a time (100 … 8,100, then 1,000 … 81,000).
 */
export const CHIP_LADDER = [10, 30, 90, 270, 810];
export const CHIP_SCALE_STEP = 10;

/**
 * The scales a board can show (§11: UI only; the server holds every stake to
 * the board's bounds). A scale is a power of `CHIP_SCALE_STEP`: the lowest is
 * the first whose bottom chip reaches the board's minimum stake, the highest
 * the last whose bottom chip is still within its maximum. A ₹10 board opens at
 * 10 … 810; a ₹100 board at 100 … 8,100 and cannot go below it.
 */
export function chipScales(board?: { minBet: number; maxBet: number } | null): { min: number; max: number } | null {
  if (!board || !(board.minBet > 0) || !(board.maxBet >= board.minBet)) return null;
  let min = 0;
  while (CHIP_LADDER[0] * CHIP_SCALE_STEP ** min < board.minBet) min++;
  let max = min;
  while (CHIP_LADDER[0] * CHIP_SCALE_STEP ** (max + 1) <= board.maxBet) max++;
  return { min, max };
}

/**
 * Quick-bet chips for a board at a scale (default: its lowest): the ladder
 * times `CHIP_SCALE_STEP ** scale`, none outside the board's stake bounds.
 */
export function chipsFor(board?: { minBet: number; maxBet: number } | null, scale?: number): number[] {
  const range = chipScales(board);
  if (!board || !range) return [];
  const k = Math.max(range.min, Math.min(range.max, scale ?? range.min));
  return CHIP_LADDER.map((v) => v * CHIP_SCALE_STEP ** k).filter((v) => v >= board.minBet && v <= board.maxBet);
}

// ANALYTICS_WINDOW — how many past results a board's streak analytics cover,
// by the board's kind of timer.
//
// This is a real target, not a display cap: the drawer requests exactly this
// many rows for the board being viewed, and `analyticsFor` computes over what
// arrives. 1,440 results is 24 hours of 1-minute rounds and 30 days of
// half-hour ones — enough for the run-length distribution and the streak-gap
// tables to describe something rather than echo a handful of runs.
//
// A DAILY board is 30 because that IS 30 days; asking for 1,440 would ask for
// four years of a board that produces one result a day.
//
// Read through `analyticsWindowFor` by `redesign/analytics.ts`, `GameContext`
// (the per-board cap when merging history), `AnalyticsPanel` and
// `HistoryPage`. The server enforces its own ceiling independently
// (backend/domains/markets/cycleHistory.service.js).
export const ANALYTICS_WINDOW = Object.freeze({ INTERVAL: 1440, DAILY: 30 });

/** The analytics window of a board; an unknown board gets the repeating one. */
export function analyticsWindowFor(board?: { kind: string } | null): number {
  return board?.kind === 'DAILY' ? ANALYTICS_WINDOW.DAILY : ANALYTICS_WINDOW.INTERVAL;
}

// M-03 fix: MIN_BET constant removed — GOVERNANCE §2 forbids frontend hardcoded
// business values with backend config equivalents. The board's `minBet`
// (`GET /api/v1/boards`) is the runtime authority.
// If you need a display placeholder while config loads, use 0 or '' — never a typed number.
