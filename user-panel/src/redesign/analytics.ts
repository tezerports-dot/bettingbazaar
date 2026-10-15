// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * analytics.ts — descriptive streak/roadmap statistics for the redesigned game
 * screen and the analytics drawer.
 *
 * Every number here is computed from REAL declared winners
 * (GameContext.pastCycles). All outputs are DESCRIPTIVE statistics of past
 * results only — every cycle is independent (see the disclaimer shown in the
 * Probability tab). Nothing here is used for server-side validation.
 *
 * ── Why there is no longer a generated fallback ────────────────────────────
 * This module used to pad any window holding fewer than 12 real results with a
 * seeded PRNG sequence, so the roadmap "always rendered". The padded results
 * were then counted, charted and described in exactly the same UI as real
 * ones: a tab with two real results displayed "Cycles 1,440 · Delhi 52% ·
 * Bombay 48%", a full big-road, streak-gap tables and a "DELHI next 58%"
 * signal, with nothing anywhere saying the history was invented.
 *
 * That is not a cosmetic placeholder in this product. Players stake real money
 * on those charts, and two of the three tabs were served by it in normal
 * operation — the full-day window rarely held 12 results, and once the
 * 1-minute block starts resolving 60 times an hour it crowds the shared
 * history feed (see cycleHistory.service.js, fixed there too).
 *
 * So a thin window now reports itself as thin. `sample` is the real count and
 * `sufficient` says whether it supports the streak statistics; the drawer
 * renders the shortfall instead of filling it in.
 */

import { analyticsWindowFor } from '../constants';

export type Side = 'DELHI' | 'BOMBAY';

export interface Run { side: Side; len: number; start: number; }
export interface Analytics {
  /** Real declared winners in this window. Equal to `total`; named so callers
   *  reading `sample` cannot mistake it for a padded or target figure. */
  sample: number;
  /** Whether `sample` clears MIN_SAMPLE — i.e. whether the streak
   *  distribution, gaps and continuation rate mean anything yet. */
  sufficient: boolean;
  total: number;
  delhiWins: number;
  bombayWins: number;
  runs: Run[];
  /** The streak lengths reported, 2 up to the longest seen (at least 7). */
  lengths: number[];
  /** Per length L: how many streaks REACHED L (a ×3 counts at ×2 and ×3). */
  dist: Record<string, { D: number; B: number }>;
  /** Per side and length ('D3'…): cycles between one streak reaching L and the next. */
  gaps: Record<string, { count: number; avg: number | null; last5: number[]; ago: number | null }>;
  /** Of the finished streaks that reached L, the share that reached L + 1. */
  cont: (L: number) => number;
  current: Run;
  seq: Side[]; // index 0 = newest
}

/** Longest streak length listed; longer runs still count at every length up to it. */
const MAX_LISTED = 15;

/**
 * Results a window needs before its streak statistics are worth showing.
 *
 * Below this the run-length distribution is a handful of counts and the
 * continuation rate is frequently 0% or 100% off one or two runs — a number
 * that reads as a strong signal and is noise. The roadmap itself is still
 * drawn under this threshold; it only reports what happened, it does not
 * generalise from it.
 */
export const MIN_SAMPLE = 30;

/** Consecutive same-side results, index 0 = the newest run (still going). */
export function runsOf(seq: Side[]): Run[] {
  const runs: Run[] = [];
  let i = 0;
  while (i < seq.length) {
    let j = i;
    while (j < seq.length && seq[j] === seq[i]) j++;
    runs.push({ side: seq[i], len: j - i, start: i });
    i = j;
  }
  return runs;
}

export function computeAnalytics(seq: Side[]): Analytics {
  const total = seq.length;
  const delhiWins = seq.filter(s => s === 'DELHI').length;
  const bombayWins = total - delhiWins;

  const runs = runsOf(seq);

  // ── Every streak counts at every length it passed through (owner,
  // 2026-10-10) ──────────────────────────────────────────────────────────
  // A Delhi ×3 was a Delhi ×2 first, so it is counted at ×2 AND ×3. Counting
  // only exact lengths made "how often does a ×2 happen" miss every ×2 that
  // went on to become longer, and skewed the continuation and gaps with it.
  const longest = runs.reduce((m, r) => Math.max(m, r.len), 0);
  const lengths: number[] = [];
  for (let L = 2; L <= Math.min(MAX_LISTED, Math.max(7, longest)); L++) lengths.push(L);

  const dist: Analytics['dist'] = {};
  for (const L of lengths) {
    dist[String(L)] = {
      D: runs.filter(r => r.side === 'DELHI' && r.len >= L).length,
      B: runs.filter(r => r.side === 'BOMBAY' && r.len >= L).length,
    };
  }

  // Where (cycles ago, 0 = the latest result) each streak REACHED length L.
  // A run occupies indices start … start+len-1 (newest first), so its L-th
  // result, counting from its oldest, sits at start + len - L.
  const gaps: Analytics['gaps'] = {};
  for (const L of lengths) {
    (['D', 'B'] as const).forEach(sd => {
      const sideName: Side = sd === 'D' ? 'DELHI' : 'BOMBAY';
      const occ = runs
        .filter(r => r.side === sideName && r.len >= L)
        .map(r => r.start + r.len - L);
      const g: number[] = [];
      for (let x = 1; x < occ.length; x++) g.push(occ[x] - occ[x - 1]);
      const avg = g.length ? Math.round(g.reduce((a, b) => a + b, 0) / g.length) : null;
      gaps[sd + L] = { count: occ.length, avg, last5: g.slice(0, 5), ago: occ.length ? occ[0] : null };
    });
  }

  // Continuation from FINISHED streaks only: the newest run is still going,
  // so whether it passes L + 1 is not known yet and must not count either way.
  const finished = runs.slice(1);
  const cont = (L: number) => {
    const atLeast = finished.filter(r => r.len >= L).length;
    const more = finished.filter(r => r.len >= L + 1).length;
    return atLeast ? more / atLeast : 0;
  };

  return {
    sample: total,
    sufficient: total >= MIN_SAMPLE,
    total, delhiWins, bombayWins, runs, lengths, dist, gaps, cont,
    current: runs[0] || { side: 'DELHI', len: 1, start: 0 },
    seq,
  };
}

/**
 * Build the analytics window for a board, from real winners only
 * (newest first). A window holding fewer than `MIN_SAMPLE` results comes back
 * with `sufficient: false` and is NOT topped up — see the module header.
 */
export function analyticsFor(realWinnersNewestFirst: Side[], board?: { kind: string } | null): Analytics {
  // How far back this board looks — `analyticsWindowFor` in constants.ts,
  // shared with GameContext (which caps the stored history to it) and the
  // drawer (which requests exactly that many rows for the board being viewed).
  const target = analyticsWindowFor(board);
  return computeAnalytics(realWinnersNewestFirst.slice(0, target));
}

/** Flatten runs back into a capped winner sequence (newest first) for bead rows. */
export function seqFromRuns(runs: Run[], cap = 80): Side[] {
  const out: Side[] = [];
  for (const r of runs) {
    for (let k = 0; k < r.len; k++) out.push(r.side);
    if (out.length > cap) break;
  }
  return out.slice(0, cap);
}

/**
 * Each board's real winners, newest first, keyed by EVERY board the server
 * lists, so a board with no results yet gets an empty list rather than falling
 * through to another board's history. The one builder for the game screen,
 * Results and the Analytics page.
 */
export function winnersByBoard(
  cycles: ReadonlyArray<{ type: string; winner?: string | null; endTime?: number }> | undefined,
  boards: ReadonlyArray<{ key: string }>,
): Record<string, Side[]> {
  const out: Record<string, Side[]> = {};
  for (const c of [...(cycles || [])].sort((a, b) => (b.endTime || 0) - (a.endTime || 0))) {
    if (c.winner !== 'DELHI' && c.winner !== 'BOMBAY') continue;
    (out[c.type] ??= []).push(c.winner);
  }
  for (const b of boards) out[b.key] ??= [];
  return out;
}

// ── Runs & Gaps (owner, 2026-10-15) ──────────────────────────────────────────
// Still descriptive only: each round is drawn on its own, so none of these
// figures says anything about the next one. The page says so beside them.

/** The look-back windows offered, in results. A window is cut to what exists. */
export const RUN_WINDOWS = Object.freeze([100, 500, 1000] as const);

/** Run lengths tabled one by one; the last bucket holds this length and longer. */
export const RUN_BUCKETS = Object.freeze([1, 2, 3, 4, 5, 6] as const);

const bucketOf = (len: number) => Math.min(len, RUN_BUCKETS[RUN_BUCKETS.length - 1]) - 1;

export interface SideRuns {
  /** How many runs had each length in RUN_BUCKETS (the last is "6 or more"). */
  buckets: number[];
  /** The longest run seen in the window, the current one included. */
  longest: number;
}

/**
 * How long each side's runs were over the newest `window` results. Every run
 * in the window counts, the current one at its length so far; a run cut by
 * the window's oldest edge counts at the part inside it.
 */
export function runLengthTable(seq: Side[], window: number): { rounds: number; DELHI: SideRuns; BOMBAY: SideRuns } {
  const s = seq.slice(0, window);
  const blank = (): SideRuns => ({ buckets: RUN_BUCKETS.map(() => 0), longest: 0 });
  const out = { rounds: s.length, DELHI: blank(), BOMBAY: blank() };
  for (const r of runsOf(s)) {
    const t = out[r.side];
    t.buckets[bucketOf(r.len)] += 1;
    t.longest = Math.max(t.longest, r.len);
  }
  return out;
}

export interface SideGaps {
  /** Rounds since this side last won: 0 = it won the latest round; null = not in the window. */
  sinceLast: number | null;
  /** Finished gaps (rounds in a row without a win) by RUN_BUCKETS. */
  buckets: number[];
  /** How many finished gaps there were, their longest and their average. */
  count: number;
  longest: number;
  avg: number | null;
}

/**
 * The gaps between one side's wins over the newest `window` results. A gap is
 * a run of the other side, so it is counted only when a win of this side
 * closes it on both ends: the one still open now is `sinceLast`, and one cut
 * by the window's oldest edge is left out rather than counted short.
 */
export function gapSummary(seq: Side[], side: Side, window: number): SideGaps {
  const s = seq.slice(0, window);
  const first = s.indexOf(side);
  const gaps = runsOf(s)
    .filter(r => r.side !== side && r.start !== 0 && r.start + r.len < s.length)
    .map(r => r.len);
  const buckets: number[] = RUN_BUCKETS.map(() => 0);
  for (const g of gaps) buckets[bucketOf(g)] += 1;
  return {
    sinceLast: first === -1 ? null : first,
    buckets,
    count: gaps.length,
    longest: gaps.reduce((m, g) => Math.max(m, g), 0),
    avg: gaps.length ? Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10 : null,
  };
}

/** Steps a progression may have; more than this only multiplies the loss. */
export const LADDER_MAX_STEPS = 12;

/**
 * What one winning stake returns, in tokens: the stake × the multiplier, less
 * the winnings fee on that gross, floored to the paisa. A display mirror of
 * `computeWinningsPayout` (backend/domains/risk/riskValidation.service.js),
 * fed the server's own `payoutMultiplier` and `winningsFeePercent`; never used
 * to decide anything (§11).
 */
export function winReturn(stake: number, multiplier: number, feePercent: number): number {
  const grossMinor = Math.round(stake * 100) * multiplier;
  const feeMinor = Math.floor((grossMinor * Math.round(feePercent * 100)) / 10000);
  return (grossMinor - feeMinor) / 100;
}

export interface LadderStep { stake: number; atRisk: number; profitIfWins: number | null; }

/**
 * A progression: start, then each stake `factor` times the last, rounded to
 * whole tokens. `atRisk` is everything staked up to and including that step;
 * `profitIfWins` what is left over if that step wins (null until the payout
 * rules are known).
 */
export function ladderPlan(
  start: number, factor: number, steps: number,
  payout: ((stake: number) => number) | null,
): LadderStep[] {
  const out: LadderStep[] = [];
  let atRisk = 0;
  for (let k = 0; k < steps; k++) {
    const stake = Math.max(1, Math.round(start * factor ** k));
    atRisk += stake;
    out.push({ stake, atRisk, profitIfWins: payout ? Math.round((payout(stake) - atRisk) * 100) / 100 : null });
  }
  return out;
}

export interface LadderBacktest {
  rounds: number;
  /** Times every step lost in a row, so the whole ladder was lost. */
  ranOut: number;
  /** Times a step won and the ladder started again. */
  won: number;
  /** Tokens up or down over these rounds, an unfinished ladder included (null until the payout is known). */
  net: number | null;
}

/**
 * Plays the ladder on one side through the newest `window` results, oldest
 * first: a win starts it again from the first step, a loss moves one step up,
 * and losing the last step counts as running out (and starts it again).
 */
export function ladderBacktest(
  seq: Side[], side: Side, stakes: number[], window: number,
  payout: ((stake: number) => number) | null,
): LadderBacktest {
  const chron = seq.slice(0, window).reverse();
  if (!stakes.length) return { rounds: chron.length, ranOut: 0, won: 0, net: null };
  let step = 0, ranOut = 0, won = 0, net = 0;
  for (const r of chron) {
    const stake = stakes[step];
    net -= stake;
    if (r === side) {
      if (payout) net += payout(stake);
      won += 1; step = 0;
    } else if (++step === stakes.length) {
      ranOut += 1; step = 0;
    }
  }
  return { rounds: chron.length, ranOut, won, net: payout ? Math.round(net * 100) / 100 : null };
}
