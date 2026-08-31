// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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

import type { CycleType } from '../types';

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
  dist: Record<string, { D: number; B: number }>;
  gaps: Record<string, { count: number; avg: number | null; last5: number[]; ago: number | null }>;
  cont: (L: number) => number;
  current: Run;
  seq: Side[]; // index 0 = newest
}

const DIST_KEYS = ['2', '3', '4', '5', '6', '7+'];

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

  const dist: Analytics['dist'] = {};
  DIST_KEYS.forEach(k => (dist[k] = { D: 0, B: 0 }));
  runs.forEach(r => {
    if (r.len < 2) return;
    const k = r.len >= 7 ? '7+' : String(r.len);
    dist[k][r.side === 'DELHI' ? 'D' : 'B']++;
  });

  const gaps: Analytics['gaps'] = {};
  DIST_KEYS.forEach(k => {
    (['D', 'B'] as const).forEach(sd => {
      const sideName: Side = sd === 'D' ? 'DELHI' : 'BOMBAY';
      const occ = runs
        .filter(r => (k === '7+' ? r.len >= 7 : r.len === Number(k)) && r.side === sideName)
        .map(r => r.start);
      const g: number[] = [];
      for (let x = 1; x < occ.length; x++) g.push(occ[x] - occ[x - 1]);
      const avg = g.length ? Math.round(g.reduce((a, b) => a + b, 0) / g.length) : null;
      gaps[sd + k] = { count: occ.length, avg, last5: g.slice(0, 5), ago: occ.length ? occ[0] : null };
    });
  });

  const cont = (L: number) => {
    const atLeast = runs.filter(r => r.len >= L).length;
    const more = runs.filter(r => r.len >= L + 1).length;
    return atLeast ? more / atLeast : 0;
  };

  return {
    sample: total,
    sufficient: total >= MIN_SAMPLE,
    total, delhiWins, bombayWins, runs, dist, gaps, cont,
    current: runs[0] || { side: 'DELHI', len: 1, start: 0 },
    seq,
  };
}

/**
 * Build the analytics window for a cycle type, from real winners only
 * (newest first). A window holding fewer than `MIN_SAMPLE` results comes back
 * with `sufficient: false` and is NOT topped up — see the module header.
 */
export function analyticsFor(realWinnersNewestFirst: Side[], cycleType: CycleType | string): Analytics {
  // How far back each tab looks. The cap is about readability and cost, not
  // availability: the server sends at most ~50 rows per type today
  // (cycleHistory.service.js), so these are ceilings the feed does not yet
  // reach rather than targets to be filled.
  const WINDOW: Record<string, number> = {
    '1_MIN':    1440,  // 24h of 1-minute blocks
    '30_MIN':   1440,  // 30 days of half-hour blocks
    'FULL_DAY': 30,    // 30 days
  };
  const target = WINDOW[cycleType as string] ?? WINDOW['30_MIN'];
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
