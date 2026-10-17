// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * phantomBets.js (owner, 2026-10-15): which seconds an auto plan bets, which
 * size each second gets, and the phantom-bets line players read.
 */
import { describe, it, expect } from 'vitest';
import {
  secondsToPlace, firstSecond, sizeAtSecond, phantomBetsLabelOf,
  DEFAULT_PHANTOM_BETS_LABEL, AUTO_BET_CATCH_UP_SECONDS,
} from '../../domains/markets/phantomBets.js';

const START = 1_000_000_000_000;
const STOP = START + 60_000; // the equalizer, 60 s in

describe('auto phantom bets: the seconds', () => {
  it('offers the current second and the few before it, from the round start', () => {
    expect(secondsToPlace({ startMs: START, stopMs: STOP, fromMs: 0, nowMs: START + 500 })).toEqual([0]);
    expect(secondsToPlace({ startMs: START, stopMs: STOP, fromMs: 0, nowMs: START + 2_100 })).toEqual([0, 1, 2]);
    expect(secondsToPlace({ startMs: START, stopMs: STOP, fromMs: 0, nowMs: START + 30_000 }))
      .toHaveLength(AUTO_BET_CATCH_UP_SECONDS);
  });

  it('a plan saved mid-round starts at its save, not at second 0', () => {
    const fromMs = START + 10_400;
    expect(firstSecond(START, fromMs)).toBe(11);
    expect(secondsToPlace({ startMs: START, stopMs: STOP, fromMs, nowMs: START + 10_900 })).toEqual([]);
    expect(secondsToPlace({ startMs: START, stopMs: STOP, fromMs, nowMs: START + 11_000 })).toEqual([11]);
  });

  it('stops at the equalizer and before the round starts', () => {
    expect(secondsToPlace({ startMs: START, stopMs: STOP, fromMs: 0, nowMs: STOP })).toEqual([]);
    expect(secondsToPlace({ startMs: START, stopMs: STOP, fromMs: 0, nowMs: START - 1 })).toEqual([]);
    expect(secondsToPlace({ startMs: START, stopMs: STOP, fromMs: 0, nowMs: STOP - 1 }).at(-1)).toBe(59);
  });

  it('bets the list in order and loops it', () => {
    const list = [10, 20, 30];
    expect([0, 1, 2, 3, 4, 7].map((s) => sizeAtSecond(list, 0, s))).toEqual([10, 20, 30, 10, 20, 20]);
    // From a plan's own first second.
    expect([11, 12, 13, 14].map((s) => sizeAtSecond(list, 11, s))).toEqual([10, 20, 30, 10]);
    // A single size bets that size every second.
    expect([0, 5, 99].map((s) => sizeAtSecond([50], 0, s))).toEqual([50, 50, 50]);
  });
});

describe('the phantom-bets line', () => {
  it('is the saved wording, or the default when blank or too short', () => {
    expect(phantomBetsLabelOf({ phantomBetsLabel: '  Totals include phantom bets.  ' })).toBe('Totals include phantom bets.');
    for (const cfg of [null, {}, { phantomBetsLabel: '' }, { phantomBetsLabel: '   ' }, { phantomBetsLabel: 'short' }]) {
      expect(phantomBetsLabelOf(cfg)).toBe(DEFAULT_PHANTOM_BETS_LABEL);
    }
  });
});
