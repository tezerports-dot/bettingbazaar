// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
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
import { CycleType } from '../types';

const run = (n: number, side: Side): Side[] => Array.from({ length: n }, () => side);

describe('analyticsFor', () => {
  it('reports an empty board as empty rather than filling it in', () => {
    for (const type of Object.values(CycleType)) {
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
      const A = analyticsFor(run(n, 'DELHI'), CycleType.ONE_MIN);
      expect(A.sample, `${n} real results`).toBe(n);
      expect(A.seq.length).toBe(n);
    }
  });

  it('marks a window sufficient only at MIN_SAMPLE and above', () => {
    expect(analyticsFor(run(MIN_SAMPLE - 1, 'DELHI'), CycleType.THIRTY_MIN).sufficient).toBe(false);
    expect(analyticsFor(run(MIN_SAMPLE, 'DELHI'), CycleType.THIRTY_MIN).sufficient).toBe(true);
  });

  it('caps the full-day window without padding a short one', () => {
    // FULL_DAY looks back 30 results; the cap trims a long history and does
    // nothing at all to a short one.
    expect(analyticsFor(run(50, 'DELHI'), CycleType.FULL_DAY).sample).toBe(30);
    expect(analyticsFor(run(4, 'DELHI'), CycleType.FULL_DAY).sample).toBe(4);
  });

  it('counts only the winners it was given', () => {
    const A = analyticsFor([...run(3, 'DELHI'), ...run(2, 'BOMBAY')], CycleType.ONE_MIN);
    expect(A.delhiWins).toBe(3);
    expect(A.bombayWins).toBe(2);
    expect(A.delhiWins + A.bombayWins).toBe(A.sample);
  });

  it('falls back to the 30-minute window for an unknown type, still without padding', () => {
    const A = analyticsFor(run(5, 'BOMBAY'), 'SOMETHING_ELSE');
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
