// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Phantom bets: the rules that are fixed, and the line players read.
 *
 * Phantom bets are phantom stakes that count in the public pool totals and are
 * never paid (the settlement skips `is_phantom`). Players are told so where
 * they read the totals and in the board rules (owner, 2026-10-15): the line
 * is `SystemConfig.phantomBetsLabel`, admin-editable but never blank, held to
 * PHANTOM_BETS_LABEL_LIMITS on save.
 *
 * Auto phantom bets (owner, 2026-10-15): a phantom agent sets, per board and
 * side, a list of 1 to AUTO_BET_STEPS_MAX bet sizes. One bet a second is
 * placed from the list in order, starting again at the top when it runs out,
 * from the round's start (or when the plan was saved) until the equalizer.
 * The plans are `phantom_auto_plans` (database/repositories/phantomAutoPlans.js);
 * the bets are placed by the cycle generator through
 * `markets.placeAutoPhantomBets`.
 */

/** The longest list of sizes one plan may carry (schema `phantom_auto_plans_steps`). */
export const AUTO_BET_STEPS_MAX = 1000;

/** The smallest and largest single auto bet, in rupees (schema `phantom_auto_plans_amounts`). */
export const AUTO_BET_MIN_RUPEES = 1;
export const AUTO_BET_MAX_RUPEES = 10_000_000;

/**
 * At most this many seconds are caught up in one tick. A generator that
 * stalled (a restart, a slow database) places the last few seconds it missed
 * and skips the rest rather than landing a burst of bets at once.
 */
export const AUTO_BET_CATCH_UP_SECONDS = 5;

/** The default line, and the schema default of `SystemConfig.phantomBetsLabel`. */
export const DEFAULT_PHANTOM_BETS_LABEL = 'Pool totals include phantom bets, which are never paid out.';

export const PHANTOM_BETS_LABEL_LIMITS = { minLength: 10, maxLength: 160 };

/** The line as players are shown it: the saved one, or the default. Never blank. */
export function phantomBetsLabelOf(cfg) {
  const saved = typeof cfg?.phantomBetsLabel === 'string' ? cfg.phantomBetsLabel.trim() : '';
  return saved.length >= PHANTOM_BETS_LABEL_LIMITS.minLength ? saved : DEFAULT_PHANTOM_BETS_LABEL;
}

/**
 * Which second of the round's betting window a bet belongs to, and the
 * seconds a tick offers: the last AUTO_BET_CATCH_UP_SECONDS up to now, never
 * before the plan's first second nor past the equalizer. A second already
 * placed is skipped by its bet id (`ON CONFLICT DO NOTHING`), so offering it
 * again costs nothing and two ticks never place it twice.
 *
 * `startMs` is the round's start, `stopMs` the equalizer, `fromMs` when the
 * plan was saved (a plan saved mid-round starts then, not at second 0).
 */
export function firstSecond(startMs, fromMs) {
  return Math.max(0, Math.ceil((Math.max(fromMs, startMs) - startMs) / 1000));
}

export function secondsToPlace({ startMs, stopMs, fromMs, nowMs }) {
  if (!(nowMs >= startMs) || !(nowMs < stopMs)) return [];
  const first = firstSecond(startMs, fromMs);
  const now = Math.floor((nowMs - startMs) / 1000);
  const lastSecond = Math.ceil((stopMs - startMs) / 1000) - 1;
  const to = Math.min(now, lastSecond);
  const from = Math.max(first, to - AUTO_BET_CATCH_UP_SECONDS + 1);
  const out = [];
  for (let s = from; s <= to; s++) out.push(s);
  return out;
}

/** The size bet at second `s` of a plan whose first second is `first`. */
export function sizeAtSecond(amounts, first, s) {
  const n = amounts.length;
  return amounts[(((s - first) % n) + n) % n];
}
