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

export function computeAnalytics(seq: Side[]): Analytics {
  const total = seq.length;
  const delhiWins = seq.filter(s => s === 'DELHI').length;
  const bombayWins = total - delhiWins;

  // runs, index 0 = newest
  const runs: Run[] = [];
  let i = 0;
  while (i < total) {
    let j = i;
    while (j < total && seq[j] === seq[i]) j++;
    runs.push({ side: seq[i], len: j - i, start: i });
    i = j;
  }

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
