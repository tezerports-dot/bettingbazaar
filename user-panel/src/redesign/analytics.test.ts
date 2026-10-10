// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * The analytics window reports only what actually happened.
 *
 * These assert an ABSENCE, which is why they are worth their length: the
 * module used to top a thin window up to 1,440 entries with a seeded PRNG and
 * then chart, count and describe the result exactly like real history. Nothing
 * in the UI distinguished the two, and the tabs served by it in ordinary
 * operation were the full-day one (which rarely holds 12 results) and, once
 * the 1-minute block resolves 60 times an hour, whichever ones its volume
 * crowds out of the shared history feed.
 *
 * A regression here does not throw or render wrong — it silently invents
 * betting history in a real-money product. So the padding is pinned as gone.
 */
import { describe, it, expect } from 'vitest';
import { analyticsFor, computeAnalytics, MIN_SAMPLE, Side } from './analytics';
import { ANALYTICS_WINDOW, analyticsWindowFor, chipScales, chipsFor } from '../constants';
import { canPlaceBet, BET_SUBMIT_MARGIN_MS } from '../GAME_CORE';

const run = (n: number, side: Side): Side[] => Array.from({ length: n }, () => side);
const INTERVAL = { kind: 'INTERVAL' };
const DAILY = { kind: 'DAILY' };

describe('analyticsFor', () => {
  it('reports an empty board as empty rather than filling it in', () => {
    for (const type of [INTERVAL, DAILY, undefined]) {
      const A = analyticsFor([], type);
      expect(A.sample, `${type} sample`).toBe(0);
      expect(A.total, `${type} total`).toBe(0);
      expect(A.seq, `${type} seq`).toEqual([]);
      expect(A.sufficient, `${type} sufficient`).toBe(false);
    }
  });

  it('keeps the sample equal to the real results given, at every size', () => {
    // The old behaviour: 2 real results in, 1,440 out.
    for (const n of [1, 2, 11, 12, 40]) {
      const A = analyticsFor(run(n, 'DELHI'), INTERVAL);
      expect(A.sample, `${n} real results`).toBe(n);
      expect(A.seq.length).toBe(n);
    }
  });

  it('marks a window sufficient only at MIN_SAMPLE and above', () => {
    expect(analyticsFor(run(MIN_SAMPLE - 1, 'DELHI'), INTERVAL).sufficient).toBe(false);
    expect(analyticsFor(run(MIN_SAMPLE, 'DELHI'), INTERVAL).sufficient).toBe(true);
  });

  it('caps the full-day window without padding a short one', () => {
    // A daily board looks back 30 results; the cap trims a long history and
    // does nothing at all to a short one.
    expect(analyticsFor(run(50, 'DELHI'), DAILY).sample).toBe(30);
    expect(analyticsFor(run(4, 'DELHI'), DAILY).sample).toBe(4);
  });

  it('carries the full 1,440-result window on every repeating board', () => {
    // The specified depth for the streak statistics: 24h of 1-minute blocks,
    // 30 days of half-hour ones. GameContext caps stored history to the same
    // map and the drawer requests exactly this many rows, so a change here
    // that is not matched there leaves the charts quietly describing less
    // history than they claim.
    expect(ANALYTICS_WINDOW.INTERVAL).toBe(1440);
    expect(analyticsWindowFor(INTERVAL)).toBe(1440);
    expect(analyticsFor(run(2000, 'DELHI'), INTERVAL).sample).toBe(1440);
  });

  it('gives a board nobody has described yet the repeating window, never zero', () => {
    expect(analyticsWindowFor(undefined)).toBe(1440);
    expect(analyticsWindowFor(null)).toBe(1440);
  });

  it('counts only the winners it was given', () => {
    const A = analyticsFor([...run(3, 'DELHI'), ...run(2, 'BOMBAY')], INTERVAL);
    expect(A.delhiWins).toBe(3);
    expect(A.bombayWins).toBe(2);
    expect(A.delhiWins + A.bombayWins).toBe(A.sample);
  });

  it('falls back to the repeating window for an unknown board, still without padding', () => {
    const A = analyticsFor(run(5, 'BOMBAY'), undefined);
    expect(A.sample).toBe(5);
  });
});

describe('computeAnalytics on an empty sequence', () => {
  // The drawer reads `current` unconditionally to render "Current: X ×N".
  // It must not read as a real one-long DELHI run on a board with no results,
  // which is why the drawer hides that chip when `sample` is 0.
  it('does not claim a current run it cannot have observed', () => {
    const A = computeAnalytics([]);
    expect(A.runs).toEqual([]);
    expect(A.sample).toBe(0);
    expect(A.cont(1)).toBe(0);
  });
});

describe('client betting cutoff', () => {
  // The client stops offering a bet before the server stops accepting one.
  // Without the margin a stake tapped just inside the deadline arrives just
  // outside it and is rejected — the player sees an open board and an error
  // for a bet they placed in time.
  const END = 1_800_000_000_000;
  const at = (msLeft: number) => END - msLeft;

  it('closes a board 1.5s before the server does, on the board\'s own offset', () => {
    expect(canPlaceBet(5, at(7_000), END)).toBe(true);
    expect(canPlaceBet(5, at(6_500), END)).toBe(false); // 5s + margin
    expect(canPlaceBet(5, at(5_100), END)).toBe(false); // server would still take it
    expect(canPlaceBet(30, at(32_000), END)).toBe(true);
    expect(canPlaceBet(30, at(31_000), END)).toBe(false);
  });

  it('never opens later than it closes, on any board', () => {
    for (const t of [0, 5, 30]) {
      expect(canPlaceBet(t, at(0), END), `${t} at the buzzer`).toBe(false);
      expect(canPlaceBet(t, at(-1_000), END), `${t} past the end`).toBe(false);
    }
  });

  it('costs the margin and no more', () => {
    // A board must not lose a meaningful share of its betting window to this.
    expect(BET_SUBMIT_MARGIN_MS).toBeLessThanOrEqual(2_000);
    expect(canPlaceBet(5, at(60_000), END)).toBe(true);
  });
});

describe('chips', () => {
  it('is the 10 · 30 · 90 · 270 · 810 ladder at the board\'s lowest scale', () => {
    expect(chipsFor({ minBet: 10, maxBet: 100000 })).toEqual([10, 30, 90, 270, 810]);
    expect(chipsFor({ minBet: 100, maxBet: 500000 })).toEqual([100, 300, 900, 2700, 8100]);
    expect(chipsFor({ minBet: 50, maxBet: 500 })).toEqual([100, 300]);
    expect(chipsFor(undefined)).toEqual([]);
  });

  it('scales by 10× steps, within the board\'s bounds', () => {
    const board = { minBet: 10, maxBet: 100000 };
    expect(chipScales(board)).toEqual({ min: 0, max: 4 });
    expect(chipsFor(board, 1)).toEqual([100, 300, 900, 2700, 8100]);
    expect(chipsFor(board, 2)).toEqual([1000, 3000, 9000, 27000, 81000]);
    // Above the maximum, the chips that would exceed it are dropped.
    expect(chipsFor(board, 4)).toEqual([100000]);
    // A scale outside the range is held to it.
    expect(chipsFor(board, 9)).toEqual([100000]);
    expect(chipsFor(board, -3)).toEqual([10, 30, 90, 270, 810]);
    // A ₹100 board cannot scale down to 10.
    expect(chipScales({ minBet: 100, maxBet: 500000 })).toEqual({ min: 1, max: 4 });
    expect(chipScales({ minBet: 0, maxBet: 10 })).toBeNull();
  });
});
