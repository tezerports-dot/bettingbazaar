// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * The winners board ranks by AMOUNT WON.
 *
 * ── The defect this pins ────────────────────────────────────────────────────
 * `/api/v1/winners` merged its two sources — real settled bets and
 * admin-curated entries — and sorted the result by `displayTime`, i.e. by
 * RECENCY. The nav item is called "Top Winners", the page is titled "Top
 * Winners" with the subtitle "Biggest wins right now", and it renders the first
 * three entries as a podium. So the podium showed the three most RECENT
 * winners, presented as the three biggest: a ₹50 win a minute ago outranked a
 * ₹50,000 win an hour ago.
 *
 * Nothing about that is visible from the outside. The endpoint returned the
 * right shape, the right count, and plausible names and amounts — it was only
 * wrong about the one thing the feature is for. That is why the ranking is a
 * pure function with a test rather than a `.sort()` inline in a route handler.
 */
import { describe, it, expect } from 'vitest';
import {
  rankWinners, resolveWinnersLimit,
  DEFAULT_WINNERS_LIMIT, MAX_WINNERS_LIMIT,
} from '../../routes/winners.ranking.js';

const at = (mins) => new Date(Date.now() - mins * 60_000).toISOString();

describe('ranking the board', () => {
  it('puts the biggest win first, however old it is', () => {
    const ranked = rankWinners([
      { displayName: 'recent_small', amount: 50,     displayTime: at(1) },
      { displayName: 'old_huge',     amount: 50_000, displayTime: at(600) },
      { displayName: 'mid',          amount: 5_000,  displayTime: at(60) },
    ]);

    expect(ranked.map((w) => w.displayName)).toEqual(['old_huge', 'mid', 'recent_small']);
  });

  it('ranks curated and real entries on the same scale', () => {
    // The two sources are merged, so an admin-curated entry must not outrank a
    // real win merely by being curated — or the board becomes an ad.
    const ranked = rankWinners([
      { displayName: 'curated', amount: 1_000,  displayTime: at(2), isReal: false },
      { displayName: 'real',    amount: 90_000, displayTime: at(9), isReal: true },
    ]);

    expect(ranked[0].displayName).toBe('real');
  });

  it('breaks ties deterministically instead of by concatenation order', () => {
    // Both sources produce equal amounts often (round numbers, fixed stakes).
    // Without a tiebreak the order depends on which array was spread first,
    // which makes the board flicker between two requests over the same data.
    const entries = [
      { displayName: 'older',  amount: 500, displayTime: at(30) },
      { displayName: 'newer',  amount: 500, displayTime: at(5) },
    ];

    expect(rankWinners(entries).map((w) => w.displayName)).toEqual(['newer', 'older']);
    expect(rankWinners([...entries].reverse()).map((w) => w.displayName)).toEqual(['newer', 'older']);
  });

  it('does not mutate what it was given', () => {
    // The caller builds the merged array from two queries; an in-place sort
    // would reorder a list it may still be reading.
    const entries = [
      { displayName: 'a', amount: 1, displayTime: at(1) },
      { displayName: 'b', amount: 9, displayTime: at(2) },
    ];
    rankWinners(entries);
    expect(entries.map((w) => w.displayName)).toEqual(['a', 'b']);
  });

  it('survives entries with no amount or no timestamp', () => {
    // A curated row can be saved with either missing, and a board that throws
    // is worse than one that ranks an incomplete row last.
    const ranked = rankWinners([
      { displayName: 'no_amount' },
      { displayName: 'good', amount: 100, displayTime: at(1) },
      { displayName: 'no_time', amount: 50 },
    ]);
    expect(ranked[0].displayName).toBe('good');
    expect(ranked).toHaveLength(3);
  });

  it('cuts to the requested length', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ displayName: `w${i}`, amount: i, displayTime: at(i) }));
    expect(rankWinners(many, 5).map((w) => w.amount)).toEqual([39, 38, 37, 36, 35]);
  });
});

describe('the limit is clamped, because it sizes a public read', () => {
  it('defaults when absent, empty or unparseable', () => {
    // `null` and `''` are the ones that bite: both are Number() === 0, so a
    // finite-check-then-Math.max(1, n) let a bare `?limit=` through as a
    // ONE-ENTRY leaderboard. Anything not clearly asked for takes the default.
    for (const raw of [undefined, null, '', '  ', 'abc', NaN]) {
      expect(resolveWinnersLimit(raw), `limit=${JSON.stringify(raw)}`).toBe(DEFAULT_WINNERS_LIMIT);
    }
  });

  it('refuses to read more than the ceiling', () => {
    expect(resolveWinnersLimit(10_000)).toBe(MAX_WINNERS_LIMIT);
    expect(resolveWinnersLimit('999')).toBe(MAX_WINNERS_LIMIT);
  });

  it('treats zero and negatives as unspecified rather than as an empty board', () => {
    expect(resolveWinnersLimit(0)).toBe(DEFAULT_WINNERS_LIMIT);
    expect(resolveWinnersLimit(-5)).toBe(DEFAULT_WINNERS_LIMIT);
  });

  it('accepts a reasonable request unchanged', () => {
    expect(resolveWinnersLimit(10)).toBe(10);
    expect(resolveWinnersLimit('20')).toBe(20);
  });
});
