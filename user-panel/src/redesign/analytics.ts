// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * analytics.ts — descriptive streak/roadmap statistics for the redesigned game
 * screen and the analytics drawer.
 *
 * The winner sequence is derived from real cycle history (GameContext.pastCycles)
 * when enough is available; otherwise a deterministic pseudo-random fallback fills
 * the window so the roadmap/analytics always render. All outputs are DESCRIPTIVE
 * statistics of past results only — every cycle is independent (see the disclaimer
 * shown in the Probability tab). Nothing here is used for server-side validation.
 */

import type { CycleType } from '../types';

export type Side = 'DELHI' | 'BOMBAY';

export interface Run { side: Side; len: number; start: number; }
export interface Analytics {
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

/** Deterministic PRNG (mulberry32) — stable fallback roadmap when history is thin. */
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate a plausible winner sequence with mild streak persistence. index 0 = newest. */
export function genSeq(n: number, seed: number): Side[] {
  const rnd = mulberry32(seed);
  const out: Side[] = [];
  let last: Side = 'DELHI';
  for (let i = 0; i < n; i++) {
    const r = rnd();
    let side: Side;
    if (i === 0) side = r < 0.5 ? 'DELHI' : 'BOMBAY';
    else side = r < 0.55 ? last : last === 'DELHI' ? 'BOMBAY' : 'DELHI';
    out.push(side);
    last = side;
  }
  return out;
}

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

  return { total, delhiWins, bombayWins, runs, dist, gaps, cont, current: runs[0] || { side: 'DELHI', len: 1, start: 0 }, seq };
}

/**
 * Build the analytics window for a cycle type. Uses real winners from history
 * (newest first) when we have a meaningful sample, otherwise a deterministic
 * fallback so the roadmap is never empty.
 */
export function analyticsFor(realWinnersNewestFirst: Side[], cycleType: CycleType | string): Analytics {
  // Window size and fallback seed per type. The window is roughly "a month of
  // results": 1440 thirty-minute cycles, 30 full days, and 1440 one-minute
  // cycles — which is only a day of them, but a larger window would be a
  // roadmap nobody can read and a sequence nobody scrolls.
  //
  // Each type gets its OWN seed so the deterministic padding differs between
  // tabs; sharing one would render three tabs with identical "history" before
  // real results arrive, which looks exactly like a bug.
  const WINDOW: Record<string, { target: number; seed: number }> = {
    '1_MIN':    { target: 1440, seed: 13337 },
    '30_MIN':   { target: 1440, seed: 90210 },
    'FULL_DAY': { target: 30,   seed: 47311 },
  };
  const { target, seed } = WINDOW[cycleType as string] ?? WINDOW['30_MIN'];
  let seq = realWinnersNewestFirst.slice(0, target);
  if (seq.length < 12) {
    // Not enough real history yet — pad with a deterministic tail so charts render.
    const fill = genSeq(target - seq.length, seed);
    seq = [...seq, ...fill];
  }
  return computeAnalytics(seq);
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
