// GOVERNANCE: Read docs/governance/04-GOVERNANCE.md before editing this file. (See sec.0 for mandatory pre-edit checklist.)
/**
 * Betting closes on the clock, not on a status flag.
 *
 * `bet.routes.js` gated betting solely on `cycle.status`, which the generator's
 * 1-second tick flips to CLOSED. A late tick therefore extended betting past
 * the intended cutoff. On the 30-minute block the slack between close (T−30s)
 * and declare (T−10s) is ~20 seconds and it never mattered; on the 1-minute
 * block it is TWO seconds, and the generator deliberately completes a
 * still-OPEN cycle directly, so a slipped tick let bets land until T−3s.
 *
 * That window is after the phantom equalizer (T−9s), so a stake in it moves the
 * real minority — the winning side — after the house has finished balancing.
 *
 * This pins the arithmetic of the cutoff itself and, more importantly, that the
 * 1-minute block's betting window is the specified 55 of 60 seconds rather than
 * whatever a tick happens to allow.
 */
import { describe, it, expect } from 'vitest';
import { CYCLE_TYPES, phasesFor } from '../../domains/markets/cycleTypes.js';
import { DEFAULT_CYCLE_PHASES } from '../../domains/configuration/systemConfig.model.js';

/** The cutoff bet.routes.js computes: endTime − closeBeforeEndSec. */
const closesAt = (endTime, type, cfg = DEFAULT_CYCLE_PHASES) =>
  endTime - phasesFor(type, cfg).closeBeforeEndSec * 1000;

describe('betting cutoff', () => {
  const END = 1_800_000_000_000;

  it('closes the 1-minute block 5s before the end, not at the end', () => {
    expect(closesAt(END, CYCLE_TYPES.ONE_MIN)).toBe(END - 5_000);
  });

  it('leaves the 1-minute block the specified 55-second betting window', () => {
    const durationMs = 60_000;
    const openFor = closesAt(END, CYCLE_TYPES.ONE_MIN) - (END - durationMs);
    expect(openFor).toBe(55_000);
  });

  it('rejects inside the window a late status flip would have allowed', () => {
    // T−4s: past the T−5s cutoff, before the T−3s declaration. This is exactly
    // the gap a slow tick opens, and the clock check must reject in it even
    // though the stored status still reads OPEN.
    const cutoff = closesAt(END, CYCLE_TYPES.ONE_MIN);
    expect(END - 4_000 >= cutoff, 'T-4s must be rejected').toBe(true);
    expect(END - 6_000 >= cutoff, 'T-6s must still be accepted').toBe(false);
  });

  it('honours an admin-tuned close offset over the default', () => {
    // The cutoff reads SystemConfig first, so retuning the board moves the
    // cutoff with it rather than leaving the gate on the shipped default.
    const tuned = { ...DEFAULT_CYCLE_PHASES, oneMin: { ...DEFAULT_CYCLE_PHASES.oneMin, closeBeforeEndSec: 8 } };
    expect(closesAt(END, CYCLE_TYPES.ONE_MIN, tuned)).toBe(END - 8_000);
  });

  it('closes every board strictly before it declares a winner', () => {
    // If close were not strictly before celebrate, a bet could land after the
    // winner was computed — the failure this whole guard exists to prevent.
    for (const type of Object.values(CYCLE_TYPES)) {
      const p = phasesFor(type, DEFAULT_CYCLE_PHASES);
      expect(p.closeBeforeEndSec, `${type} close > declare`).toBeGreaterThan(p.celebrateBeforeEndSec);
    }
  });
});
